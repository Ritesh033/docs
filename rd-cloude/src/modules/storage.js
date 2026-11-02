// Object storage service (S3-class): buckets with versioning / ACL / CORS / lifecycle / website settings, objects with metadata,
// checksums, conditional requests, ranges, versions, multipart uploads, presigned URLs, public + website serving, quota and a sweeper.
// Auto-loaded by src/app.js. See docs/storage.md for the API, limits and the security decisions.
import crypto from 'node:crypto'
import { HttpError, HANDLED, required } from '../http.js'
import { record } from '../billing.js'
import * as authMod from '../auth.js' // masterKey / clientIp are used when present (namespace import: a missing export is undefined, not a crash)

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const DAY = 86_400_000
const BLOB_PREFIX = 'stb' // every blob this module writes is named stb_<hex>; the orphan sweeper only ever touches these
const BUCKET_RE = /^[a-z0-9][a-z0-9-]{2,62}$/
const VERSIONING = ['disabled', 'enabled', 'suspended']
const BUCKET_ACLS = ['private', 'public-read']
const OBJECT_ACLS = ['inherit', 'private', 'public-read']
const CORS_METHODS = ['GET', 'PUT', 'POST', 'DELETE', 'HEAD']
const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8', xml: 'application/xml', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', avif: 'image/avif', pdf: 'application/pdf',
  zip: 'application/zip', gz: 'application/gzip', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', woff2: 'font/woff2', woff: 'font/woff', wasm: 'application/wasm',
}
// Content that a browser may execute when it is rendered from our origin. Public / presigned responses force a download for these.
const ACTIVE_TYPE = /^(?:text\/(?:html|xml|xsl|javascript|css|cache-manifest)|application\/(?:xhtml\+xml|xml|xslt\+xml|javascript|ecmascript|x-javascript|x-shockwave-flash)|image\/svg\+xml)\b|\+xml\b/i
// Public / presigned (non-website) responses are inert and get an opaque origin; website responses may run scripts but still get an opaque origin.
const INERT_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
const SITE_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads'

/* ======================================================================================= configuration */

function envInt(name, def, min, max) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return def
  const n = Number(raw)
  if (Number.isInteger(n) && n >= min && n <= max) return n
  console.warn(`[rd-cloude] ${name}=${JSON.stringify(raw)} is not an integer in ${min}..${max}; using ${def}`)
  return def
}

function loadLimits() {
  const regions = (process.env.RD_STORAGE_REGIONS ?? 'rd-local').split(',').map((s) => s.trim()).filter((s) => /^[a-z0-9][a-z0-9-]{1,30}$/.test(s))
  return {
    quotaBytes: envInt('RD_STORAGE_QUOTA_BYTES', 5 * GiB, 1, 2 ** 50),
    maxObjectBytes: envInt('RD_STORAGE_MAX_OBJECT_BYTES', 5 * GiB, 1, 2 ** 50),
    chunkBytes: envInt('RD_STORAGE_CHUNK_BYTES', 4 * MiB, 1, 64 * MiB), // size of the blobs an object is stored in
    minPartBytes: envInt('RD_STORAGE_MIN_PART_BYTES', 5 * MiB, 0, 5 * GiB),
    maxPartBytes: envInt('RD_STORAGE_MAX_PART_BYTES', 512 * MiB, 1, 5 * GiB),
    maxParts: envInt('RD_STORAGE_MAX_PARTS', 1000, 1, 10_000),
    maxChunksPerObject: 5000, // the account-deletion walk in security.js follows at most 5000 entries per array
    maxBuckets: envInt('RD_STORAGE_MAX_BUCKETS', 100, 1, 10_000),
    maxObjectsPerUser: envInt('RD_STORAGE_MAX_OBJECTS', 100_000, 1, 50_000_000), // every version and delete marker counts
    maxOpenUploads: envInt('RD_STORAGE_MAX_UPLOADS', 1000, 1, 100_000),
    uploadTtlMs: envInt('RD_STORAGE_UPLOAD_TTL_HOURS', 168, 1, 8760) * 3_600_000,
    maxConcurrentUploads: envInt('RD_STORAGE_MAX_CONCURRENT_UPLOADS', 32, 1, 1000),
    uploadIdleMs: 60_000,
    maxListKeys: 1000,
    maxBatch: 1000,
    maxPrefixDelete: 5000,
    presignMaxSeconds: 7 * 86_400,
    sweepIntervalMs: envInt('RD_STORAGE_SWEEP_INTERVAL_MS', 600_000, 0, DAY),
    sweepBatch: 5000, // lifecycle actions per run; the rest is picked up by the next run
    orphanGraceMs: 3_600_000,
    orphanScanEveryMs: 6 * 3_600_000,
    regions: regions.length ? regions : ['rd-local'],
  }
}

/* ======================================================================================= small pure helpers */

const asObject = (v, what = 'Request body') => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, `${what} must be a JSON object`)
  return v
}
const bad = (msg) => new HttpError(400, msg)
const hdr = (req, name) => { const v = req.headers[name]; return Array.isArray(v) ? v[0] : v }
const sleepTick = () => new Promise((resolve) => setImmediate(resolve))
const md5hex = (buf) => crypto.createHash('md5').update(buf).digest('hex')

/** Code point order (= UTF-8 byte order), unlike `<` on strings, which orders astral characters before U+E000..U+FFFF. */
function keyCompare(a, b) {
  if (a === b) return 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i)
    const y = b.charCodeAt(i)
    if (x !== y) {
      const xs = x >= 0xd800 && x <= 0xdfff
      const ys = y >= 0xd800 && y <= 0xdfff
      if (xs !== ys) return xs ? 1 : -1
      return x < y ? -1 : 1
    }
  }
  return a.length < b.length ? -1 : 1
}

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/ // C0 and C1 control characters
// line / paragraph separators and bidi override + isolate characters (they let a key spoof another name in a listing); built from code points so no raw separator sits in the source
const SPOOF_RE = new RegExp(`[${[0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map((c) => String.fromCharCode(c)).join('')}]`)
const hasControl = (s) => CONTROL_RE.test(s) || SPOOF_RE.test(s)

/** Object key: NFC-normalised, 1..1024 UTF-8 bytes, no control characters, backslash, leading slash, empty or dot segments. */
function normKey(raw, what = 'Key') {
  if (typeof raw !== 'string') throw bad(`${what} must be a string`)
  const k = raw.normalize('NFC')
  if (!k) throw bad(`${what} must not be empty`)
  if (!k.isWellFormed()) throw bad(`${what} is not valid Unicode`)
  if (Buffer.byteLength(k) > 1024) throw bad(`${what} is longer than 1024 bytes`)
  if (hasControl(k) || k.includes('\\')) throw bad(`${what} contains control or reserved characters`)
  if (k.startsWith('/')) throw bad(`${what} must not start with "/"`)
  const segs = k.split('/')
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] === '.' || segs[i] === '..') throw bad(`${what} must not contain "." or ".." path segments`)
    if (segs[i] === '' && i < segs.length - 1) throw bad(`${what} must not contain empty path segments ("//")`)
  }
  return k
}
function normPrefix(raw, what = 'prefix') {
  if (raw === undefined || raw === null || raw === '') return ''
  if (typeof raw !== 'string') throw bad(`${what} must be a string`)
  const p = raw.normalize('NFC')
  if (!p.isWellFormed() || Buffer.byteLength(p) > 1024 || hasControl(p)) throw bad(`Invalid ${what}`)
  return p
}

function headerText(name, value, max = 256) {
  if (value === undefined || value === null) return undefined
  const v = String(value).trim()
  if (v.length > max || !/^[\x20-\x7e]*$/.test(v)) throw bad(`Invalid ${name} header`)
  return v
}

const CTYPE_RE = /^[\w!#$&^.+-]{1,127}\/[\w!#$&^.+-]{1,127}(?:\s*;\s*[\w!#$&^.+-]+=(?:"[^"\r\n\\]*"|[^\s;"]+))*$/
function contentTypeFor(raw, key) {
  const v = raw === undefined || raw === null ? '' : String(raw).trim()
  if (!v) return MIME[key.split('.').pop().toLowerCase()] ?? 'application/octet-stream'
  if (v.length > 255 || !CTYPE_RE.test(v)) throw bad('Invalid Content-Type')
  return v
}

/** Tag set {k: v}: at most `max` tags, keys 1..128 and values 0..256 chars without control characters. */
function normTags(raw, max = 10) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('tags must be an object of string values')
  const out = {}
  const entries = Object.entries(raw)
  if (entries.length > max) throw bad(`At most ${max} tags are allowed`)
  for (const [k, v] of entries) {
    if (typeof v !== 'string') throw bad('tag values must be strings')
    if (!k || k.length > 128 || v.length > 256 || hasControl(k) || hasControl(v)) throw bad('Invalid tag (keys 1-128 chars, values up to 256 chars, no control characters)')
    out[k] = v
  }
  return out
}

/** User metadata {name: value}: names [a-z0-9._-]{1,64}, values printable ASCII, at most 2 KiB in total. */
function normMetadata(raw) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('metadata must be an object of string values')
  const out = {}
  let total = 0
  const entries = Object.entries(raw)
  if (entries.length > 50) throw bad('At most 50 metadata entries are allowed')
  for (const [k0, v] of entries) {
    const k = k0.toLowerCase()
    if (!/^[a-z0-9._-]{1,64}$/.test(k)) throw bad(`Invalid metadata name "${k0.slice(0, 40)}"`)
    if (typeof v !== 'string' || v.length > 1024 || !/^[\x20-\x7e]*$/.test(v)) throw bad(`Invalid metadata value for "${k}" (printable ASCII only)`)
    total += k.length + v.length
    out[k] = v
  }
  if (total > 2048) throw bad('Metadata exceeds 2 KiB')
  return out
}

const filenameOf = (key) => key.split('/').filter(Boolean).pop() ?? 'download'
function dispositionFor(kind, key) {
  const name = filenameOf(key)
  const ascii = name.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120) || 'download'
  const star = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${star}`
}

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
function unb64url(token, what = 'token') {
  if (typeof token !== 'string' || token.length > 2200 || !/^[A-Za-z0-9_-]+$/.test(token)) throw bad(`Invalid ${what}`)
  try {
    const v = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
    if (v && typeof v === 'object' && !Array.isArray(v)) return v
  } catch { /* fall through */ }
  throw bad(`Invalid ${what}`)
}

function intQ(query, names, def, min, max) {
  for (const n of names) {
    const v = query.get(n)
    if (v === null || v === '') continue
    if (!/^\d{1,12}$/.test(v)) throw bad(`Invalid ${n}`)
    const x = Number(v)
    if (x < min) throw bad(`${n} must be at least ${min}`)
    return Math.min(x, max)
  }
  return def
}
const optInt = (v, name, min, max) => {
  if (v === undefined || v === null) return undefined
  if (!Number.isInteger(v) || v < min || v > max) throw bad(`${name} must be an integer between ${min} and ${max}`)
  return v
}

/** Entity tags in an If-* header value: ["W/\"x\"", "\"y\"", "*"]. */
const etagList = (value) => String(value).match(/(?:W\/)?"[^"]*"|\*/g) ?? []
const opaque = (t) => t.replace(/^W\//, '')

/** Parses a Range header. null = ignore it (absent / not understood), 'unsat' = 416, else a sorted, coalesced [{start,end}] (inclusive). */
function parseRange(value, size) {
  const m = /^bytes\s*=\s*(.+)$/i.exec(String(value).trim())
  if (!m) return null
  const specs = m[1].split(',').map((s) => s.trim()).filter(Boolean)
  if (!specs.length) return null
  if (specs.length > 32) return 'unsat'
  const list = []
  for (const spec of specs) {
    const p = /^(\d{0,16})-(\d{0,16})$/.exec(spec)
    if (!p || (p[1] === '' && p[2] === '')) return null
    if (p[1] === '') { // suffix range: the last N bytes
      const n = Number(p[2])
      if (n === 0 || size === 0) continue
      list.push({ start: Math.max(0, size - n), end: size - 1 })
      continue
    }
    const start = Number(p[1])
    if (p[2] !== '' && Number(p[2]) < start) return null
    if (start >= size) continue
    list.push({ start, end: p[2] === '' ? size - 1 : Math.min(Number(p[2]), size - 1) })
  }
  if (!list.length) return 'unsat'
  list.sort((a, b) => a.start - b.start)
  const out = [list[0]]
  for (const x of list.slice(1)) {
    const last = out[out.length - 1]
    if (x.start <= last.end + 1) last.end = Math.max(last.end, x.end)
    else out.push({ ...x })
  }
  return out
}

/** RFC 9110 section 13.2.2 for GET / HEAD / write requests. Returns 'ok' | 304 | 412. `etag` is quoted, `lastModMs` is a whole second. */
function evalPreconditions(req, etag, lastModMs, readMethod) {
  const ifMatch = hdr(req, 'if-match')
  const ifNone = hdr(req, 'if-none-match')
  const ims = hdr(req, 'if-modified-since')
  const ius = hdr(req, 'if-unmodified-since')
  if (ifMatch !== undefined) {
    const list = etagList(ifMatch)
    if (!list.includes('*') && !list.some((t) => !t.startsWith('W/') && t === etag)) return 412
  } else if (ius !== undefined) {
    const t = Date.parse(ius)
    if (!Number.isNaN(t) && lastModMs > t) return 412
  }
  if (ifNone !== undefined) {
    const list = etagList(ifNone)
    if (list.includes('*') || list.some((t) => opaque(t) === etag)) return readMethod ? 304 : 412
  } else if (ims !== undefined && readMethod) {
    const t = Date.parse(ims)
    if (!Number.isNaN(t) && lastModMs <= t) return 304
  }
  return 'ok'
}

/* ======================================================================================= module */

export async function register(r, db, ctx) {
  const L = loadLimits()
  const inflight = new Set() // blob ids written by uploads that have not committed yet (the orphan sweeper must not touch them)
  const reserved = new Map() // userId -> bytes promised to running uploads
  let activeUploads = 0
  let seqLast = 0
  let lastOrphanScan = Date.now()
  let presignKeyCache = null

  const rows = (col, field, value) => (typeof db.findBy === 'function' ? db.findBy(col, field, value) : db.find(col, (x) => x[field] === value))
  const iso = (t = Date.now()) => new Date(t).toISOString()
  const nextSeq = () => (seqLast = Math.max(Date.now() * 1000, seqLast + 1))
  const bkey = (bucketId, key) => `${bucketId}\n${key}`
  const newVersionId = () => `v${nextSeq().toString(36)}${crypto.randomBytes(3).toString('hex')}`
  const logErr = (what, e) => console.error(`[rd-cloude] storage: ${what}: ${e?.message ?? e}`)

  /* --------------------------------------------------------------- startup: adopt rows written by the previous (flat) implementation */
  for (const col of ['objects', 'st_uploads']) for (const o of db.find(col, () => true)) if (typeof o.seq === 'number') seqLast = Math.max(seqLast, o.seq)
  const legacy = db.find('objects', (o) => o.bkey === undefined)
  for (let i = 0; i < legacy.length; i += 500) {
    db.transaction(() => {
      for (const o of legacy.slice(i, i + 500)) {
        db.update('objects', o.id, { bkey: bkey(o.bucketId, o.key), versionId: 'null', isLatest: true, deleteMarker: false, seq: nextSeq(), acl: 'inherit' })
      }
    })
  }
  for (const [col, field] of [['objects', 'bkey'], ['objects', 'bucketId'], ['objects', 'userId'], ['buckets', 'name'], ['st_parts', 'uploadId'], ['st_parts', 'userId'], ['st_uploads', 'bucketId'], ['st_uploads', 'userId']]) {
    try { db.index?.(col, field) } catch { /* indexes are an optimisation */ }
  }

  /* --------------------------------------------------------------- tenancy + record helpers */
  // (buckets whose forced deletion was interrupted by a restart are finished at the end of register())
  // a bucket flagged `deleting` is being emptied in the background: to everybody it already does not exist
  const bucketByName = (name) => (typeof name === 'string' ? rows('buckets', 'name', name).find((x) => !x.deleting) ?? null : null)
  function ownBucket(user, name) {
    const b = typeof name === 'string' ? rows('buckets', 'name', name).find((x) => x.userId === user.id && !x.deleting) : null
    if (!b) throw new HttpError(404, 'Bucket not found')
    return b
  }
  const bset = (b) => ({
    region: b.region ?? L.regions[0], versioning: b.versioning ?? 'disabled', acl: b.acl ?? 'private',
    cors: b.cors ?? [], lifecycle: b.lifecycle ?? [], website: b.website ?? null, tags: b.tags ?? {},
  })
  const chunksOf = (o) => o.chunks ?? (o.blobId ? [{ blobId: o.blobId, size: o.size }] : [])
  const versionsOf = (bucketId, key) => rows('objects', 'bkey', bkey(bucketId, key)).slice().sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
  const liveOf = (bucketId, key) => versionsOf(bucketId, key).find((o) => o.isLatest !== false && !o.deleteMarker) ?? null
  const isPublic = (b, o) => o.acl === 'public-read' || (bset(b).acl === 'public-read' && o.acl !== 'private')

  function etagOf(o) {
    if (o.etag) return o.etag
    const h = crypto.createHash('md5')
    for (const c of chunksOf(o)) h.update(db.getBlob(c.blobId) ?? Buffer.alloc(0))
    const etag = h.digest('hex')
    try { db.update('objects', o.id, { etag }) } catch { /* cache only */ }
    return etag
  }

  const view = (o) => ({
    id: o.id, bucketId: o.bucketId, userId: o.userId, key: o.key, versionId: o.versionId ?? 'null', isLatest: o.isLatest !== false, deleteMarker: !!o.deleteMarker,
    size: o.size, etag: o.etag ?? null, contentType: o.contentType, lastModified: o.createdAt, createdAt: o.createdAt, storageClass: 'STANDARD',
    acl: o.acl ?? 'inherit', metadata: o.metadata ?? {}, tags: o.tags ?? {}, cacheControl: o.cacheControl ?? null, contentDisposition: o.contentDisposition ?? null,
    contentEncoding: o.contentEncoding ?? null, contentLanguage: o.contentLanguage ?? null, partCount: o.partCount ?? null, checksumSha256: o.sha256 ?? null,
  })

  function bucketStats(b) {
    let objectCount = 0
    let versionCount = 0
    let markerCount = 0
    let sizeBytes = 0
    for (const o of rows('objects', 'bucketId', b.id)) {
      versionCount++
      sizeBytes += o.size ?? 0
      if (o.deleteMarker) markerCount++
      else if (o.isLatest !== false) objectCount++
    }
    return { objectCount, versionCount, deleteMarkerCount: markerCount, sizeBytes }
  }
  const bucketView = (b, detail = false) => {
    const s = bset(b)
    return {
      id: b.id, name: b.name, userId: b.userId, createdAt: b.createdAt, updatedAt: b.updatedAt ?? null, region: s.region, versioning: s.versioning, acl: s.acl,
      website: s.website, tags: s.tags, corsRuleCount: s.cors.length, lifecycleRuleCount: s.lifecycle.length,
      ...(detail ? { cors: s.cors, lifecycle: s.lifecycle } : {}), ...bucketStats(b),
    }
  }

  /* --------------------------------------------------------------- blobs */
  function freeChunks(chunks) {
    for (const c of chunks ?? []) {
      inflight.delete(c.blobId)
      try { db.deleteBlob(c.blobId) } catch (e) { logErr('could not delete blob', e) }
    }
  }
  const adoptChunks = (chunks) => { for (const c of chunks) inflight.delete(c.blobId) }
  async function copyChunks(chunks) {
    const out = []
    try {
      for (const c of chunks) {
        const buf = db.getBlob(c.blobId)
        if (!buf || buf.length !== c.size) throw new HttpError(500, 'Stored data is missing')
        const id = db.id(BLOB_PREFIX)
        inflight.add(id)
        db.putBlob(id, buf)
        out.push({ blobId: id, size: c.size })
        await sleepTick()
      }
    } catch (e) { freeChunks(out); throw e }
    return out
  }

  /* --------------------------------------------------------------- quota + resource accounting */
  const quotaFor = (userId) => (typeof storage.quotaFor === 'function' ? storage.quotaFor(userId) : L.quotaBytes)
  function usageOf(userId) {
    let objectBytes = 0
    let objects = 0
    let partBytes = 0
    for (const o of rows('objects', 'userId', userId)) { objects++; objectBytes += o.size ?? 0 }
    for (const p of rows('st_parts', 'userId', userId)) partBytes += p.size ?? 0
    return { bytes: objectBytes + partBytes, objectBytes, partBytes, objects, uploads: rows('st_uploads', 'userId', userId).length }
  }
  class Reservation {
    constructor(userId, credit = 0) { this.userId = userId; this.credit = credit; this.bytes = 0 }
    /** Make sure at least `total` bytes of quota are promised to this upload (grows in 1 MiB steps to keep the check cheap). */
    ensure(total) {
      if (total <= this.bytes) return
      const used = usageOf(this.userId).bytes
      const others = reserved.get(this.userId) ?? 0
      const quota = quotaFor(this.userId)
      for (const want of [Math.max(total, this.bytes + MiB), total]) {
        const add = want - this.bytes
        if (used + others + add - this.credit <= quota) {
          reserved.set(this.userId, others + add)
          this.bytes = want
          return
        }
      }
      throw new HttpError(507, 'Storage quota exceeded')
    }
    /** Authoritative check at commit time (single-threaded, so nothing can slip in between this and the insert). */
    commitCheck(size, replacedBytes = 0) {
      const u = usageOf(this.userId)
      const others = (reserved.get(this.userId) ?? 0) - this.bytes
      if (u.bytes - replacedBytes + size + others > quotaFor(this.userId)) throw new HttpError(507, 'Storage quota exceeded')
    }
    release() {
      if (!this.bytes) return
      const left = (reserved.get(this.userId) ?? 0) - this.bytes
      if (left > 0) reserved.set(this.userId, left)
      else reserved.delete(this.userId)
      this.bytes = 0
    }
  }
  function acquireSlot() {
    if (activeUploads >= L.maxConcurrentUploads) {
      const e = new HttpError(503, 'Too many uploads in progress, retry shortly')
      e.headers = { 'retry-after': '2' }
      throw e
    }
    activeUploads++
    let done = false
    return () => { if (!done) { done = true; activeUploads-- } }
  }
  function checkObjectBudget(userId, extra = 1) {
    if (usageOf(userId).objects + extra > L.maxObjectsPerUser) throw new HttpError(507, `Object limit reached (${L.maxObjectsPerUser} versions per account)`)
  }

  /* --------------------------------------------------------------- metering (batched: one usage row per user per flush, not one per request) */
  const pending = new Map()
  function flushUser(uid) {
    const p = pending.get(uid)
    if (!p) return
    pending.delete(uid)
    try {
      if (p.req) record(db, uid, 'storage.requests', p.req)
      if (p.egress) record(db, uid, 'storage.egress_gb', p.egress / GiB)
    } catch (e) { logErr('metering failed', e) }
  }
  function meter(userId, requests = 1, egressBytes = 0) {
    if (!userId) return
    let p = pending.get(userId)
    if (!p) pending.set(userId, (p = { req: 0, egress: 0 }))
    p.req += requests
    p.egress += egressBytes
    if (p.req >= 500 || p.egress >= 64 * MiB) flushUser(userId)
  }
  const flushMetering = () => { for (const uid of [...pending.keys()]) flushUser(uid) }

  /* --------------------------------------------------------------- audit + events (fire and forget) */
  function audit(rc, userId, action, resource, meta) {
    try {
      const req = rc?.req
      ctx.events.emit('audit', { userId, action, resource, ip: req ? authMod.clientIp?.(req) ?? req.socket?.remoteAddress : undefined, requestId: rc?.requestId, meta, req })
    } catch (e) { logErr('audit failed', e) }
  }
  function emit(name, payload) { try { ctx.events.emit(name, payload) } catch (e) { logErr(`event ${name} failed`, e) } }

  /* --------------------------------------------------------------- versioned writes and deletes (all synchronous, so atomic) */
  /** Inserts a new version of `key`. Returns { rec, freed } where `freed` are the chunks of a replaced null version (delete them after commit). */
  function writeVersion(b, key, fields) {
    const freed = []
    const rec = db.transaction(() => {
      const versions = versionsOf(b.id, key)
      const latest = versions.find((v) => v.isLatest !== false)
      const state = bset(b).versioning
      let versionId
      if (state === 'enabled') versionId = newVersionId()
      else {
        versionId = 'null' // disabled / suspended buckets keep a single "null" version that each write replaces
        const old = versions.find((v) => (v.versionId ?? 'null') === 'null')
        if (old) { db.remove('objects', old.id); freed.push(...chunksOf(old)) }
      }
      if (latest && db.get('objects', latest.id)) db.update('objects', latest.id, { isLatest: false, noncurrentSince: iso() })
      return db.insert('objects', {
        userId: b.userId, bucketId: b.id, bkey: bkey(b.id, key), key, versionId, isLatest: true, deleteMarker: false, seq: nextSeq(),
        acl: 'inherit', metadata: {}, tags: {}, ...fields,
      })
    })
    return { rec, freed }
  }
  /** Removes one stored version for good and promotes the next newest one when it was the current version. */
  function removeVersion(rec) {
    db.transaction(() => {
      db.remove('objects', rec.id)
      if (rec.isLatest !== false) {
        const top = versionsOf(rec.bucketId, rec.key)[0]
        if (top && top.isLatest === false) db.update('objects', top.id, { isLatest: true, noncurrentSince: undefined })
      }
    })
    freeChunks(chunksOf(rec))
  }
  /** DELETE semantics for a key without a version id: permanent when versioning is off, a delete marker otherwise. */
  function deleteCurrent(b, key) {
    const state = bset(b).versioning
    const current = versionsOf(b.id, key).find((v) => v.isLatest !== false)
    if (state === 'disabled') {
      if (current) removeVersion(current)
      return { versionId: current?.versionId ?? 'null', deleteMarker: false }
    }
    const { rec, freed } = writeVersion(b, key, { size: 0, contentType: 'application/octet-stream', deleteMarker: true, etag: null })
    freeChunks(freed)
    return { versionId: rec.versionId, deleteMarker: true }
  }
  /** Empties and removes a bucket in small batches so a big one does not stall the server. Safe to call twice; resumed at start-up. */
  const purging = new Set()
  async function purgeBucket(b) {
    if (purging.has(b.id)) return
    purging.add(b.id)
    try {
      for (;;) {
        const objs = rows('objects', 'bucketId', b.id).slice(0, 400)
        const ups = rows('st_uploads', 'bucketId', b.id).slice(0, 40)
        if (!objs.length && !ups.length) break
        db.transaction(() => { for (const o of objs) db.remove('objects', o.id) })
        for (const o of objs) freeChunks(chunksOf(o))
        for (const u of ups) dropUpload(u)
        await sleepTick()
      }
      db.remove('buckets', b.id) // no await since the emptiness check above: nothing can slip in
    } catch (e) { logErr(`could not remove bucket ${b.name}`, e) } finally { purging.delete(b.id) }
  }
  function dropUpload(u) {
    const parts = rows('st_parts', 'uploadId', u.id).slice()
    db.transaction(() => { for (const p of parts) db.remove('st_parts', p.id); db.remove('st_uploads', u.id) })
    for (const p of parts) freeChunks(p.chunks)
    return parts.reduce((s, p) => s + p.size, 0)
  }

  /* --------------------------------------------------------------- upload ingestion (streams the request body into chunk blobs) */
  async function ingest(req, { maxBytes, resv, declared }) {
    const md5 = crypto.createHash('md5')
    const sha = crypto.createHash('sha256')
    const chunks = []
    let bufs = []
    let buffered = 0
    let size = 0
    const flushChunk = () => {
      if (!buffered) return
      const buf = bufs.length === 1 ? bufs[0] : Buffer.concat(bufs, buffered)
      bufs = []
      buffered = 0
      const id = db.id(BLOB_PREFIX)
      inflight.add(id)
      db.putBlob(id, buf)
      chunks.push({ blobId: id, size: buf.length })
    }
    const idle = setTimeout(() => req.destroy(new HttpError(408, 'Upload stalled')), L.uploadIdleMs)
    try {
      if (declared) resv.ensure(declared)
      for await (const data of req) {
        idle.refresh()
        size += data.length
        if (size > maxBytes) throw new HttpError(413, 'Object too large')
        resv.ensure(size)
        md5.update(data)
        sha.update(data)
        let off = 0
        while (off < data.length) {
          const take = Math.min(L.chunkBytes - buffered, data.length - off)
          bufs.push(data.subarray(off, off + take))
          buffered += take
          off += take
          if (buffered >= L.chunkBytes) flushChunk()
        }
      }
      flushChunk()
      if (chunks.length > L.maxChunksPerObject) throw new HttpError(413, 'Object has too many chunks')
    } catch (e) {
      freeChunks(chunks)
      // a client that hangs up mid-body is routine, not a server error (the app logs and answers 500 for anything else)
      if (e?.code === 'ECONNRESET' || e?.code === 'ERR_STREAM_PREMATURE_CLOSE' || e?.message === 'aborted') throw new HttpError(400, 'Upload aborted by the client')
      throw e
    } finally { clearTimeout(idle) }
    return { chunks, size, md5: md5.digest(), sha256: sha.digest('hex') }
  }

  /** Content-MD5 (base64) and x-rd-checksum-sha256 (hex or base64) verification. Throws 400 on a mismatch. */
  function verifyChecksums(req, body) {
    const cmd5 = hdr(req, 'content-md5')
    if (cmd5 !== undefined) {
      if (!/^[A-Za-z0-9+/]{22}==$/.test(cmd5.trim())) throw bad('Invalid Content-MD5 header')
      if (!Buffer.from(cmd5.trim(), 'base64').equals(body.md5)) throw bad('Content-MD5 does not match the uploaded data (BadDigest)')
    }
    const csha = hdr(req, 'x-rd-checksum-sha256')
    if (csha !== undefined) {
      const v = csha.trim()
      let want = null
      if (/^[0-9a-fA-F]{64}$/.test(v)) want = v.toLowerCase()
      else if (/^[A-Za-z0-9+/]{43}=$/.test(v)) want = Buffer.from(v, 'base64').toString('hex')
      else throw bad('Invalid x-rd-checksum-sha256 header (64 hex characters or base64)')
      if (want !== body.sha256) throw bad('x-rd-checksum-sha256 does not match the uploaded data (BadDigest)')
    }
  }
  function declaredLength(req) {
    const cl = req.headers['content-length']
    if (cl === undefined) return null
    if (!/^\d{1,16}$/.test(cl)) throw bad('Invalid Content-Length')
    return Number(cl)
  }
  /** Runs an upload handler; when it fails before the body was fully read, the connection is closed instead of draining a possibly huge body. */
  async function guardBody(rc, fn) {
    try { return await fn() } catch (e) {
      if (!rc.req.readableEnded && !rc.res.headersSent) rc.res.setHeader('connection', 'close')
      throw e
    }
  }

  /** System + user metadata from the request headers of a PUT / initiate. `trusted` = the caller is the bucket owner (may set ACL, tags, disposition). */
  function specFromHeaders(req, key, trusted) {
    const metadata = {}
    for (const [name, v] of Object.entries(req.headers)) if (name.startsWith('x-rd-meta-')) metadata[name.slice(10)] = Array.isArray(v) ? v.join(',') : v
    const spec = { contentType: contentTypeFor(hdr(req, 'content-type'), key), metadata: normMetadata(metadata) }
    if (trusted) {
      for (const [field, header] of [['cacheControl', 'cache-control'], ['contentDisposition', 'content-disposition'], ['contentEncoding', 'content-encoding'], ['contentLanguage', 'content-language']]) {
        const v = headerText(header, hdr(req, header))
        if (v) spec[field] = v
      }
      const acl = hdr(req, 'x-rd-acl')
      if (acl !== undefined) {
        if (!OBJECT_ACLS.includes(acl)) throw bad(`x-rd-acl must be one of ${OBJECT_ACLS.join(', ')}`)
        spec.acl = acl
      }
      const tagging = hdr(req, 'x-rd-tagging')
      if (tagging !== undefined) {
        if (tagging.length > 2048) throw bad('x-rd-tagging is too long')
        spec.tags = normTags(Object.fromEntries(new URLSearchParams(tagging)))
      }
    }
    return spec
  }
  /** If-Match / If-None-Match on a write. `current` is the live version or null. */
  function checkWritePreconditions(req, current) {
    const ifMatch = hdr(req, 'if-match')
    const ifNone = hdr(req, 'if-none-match')
    if (ifMatch === undefined && ifNone === undefined) return
    const etag = current ? `"${etagOf(current)}"` : null
    if (ifMatch !== undefined) {
      const list = etagList(ifMatch)
      if (!current || (!list.includes('*') && !list.some((t) => t === etag))) throw new HttpError(412, 'Precondition failed')
    }
    if (ifNone !== undefined && current) {
      const list = etagList(ifNone)
      if (list.includes('*') || list.some((t) => opaque(t) === etag)) throw new HttpError(412, 'Precondition failed')
    }
  }

  /** Shared by the console PUT and the presigned PUT. `user` is the bucket owner; `trusted` is false for presigned uploads. */
  function putObject(rc, b, key, opts) { return guardBody(rc, () => putObjectInner(rc, b, key, opts)) }
  async function putObjectInner(rc, b, key, { trusted }) {
    const { req } = rc
    const owner = b.userId
    const spec = specFromHeaders(req, key, trusted)
    checkWritePreconditions(req, liveOf(b.id, key))
    const declared = declaredLength(req)
    if (declared !== null && declared > L.maxObjectBytes) throw new HttpError(413, `Object too large (limit ${L.maxObjectBytes} bytes)`)
    const unversioned = bset(b).versioning !== 'enabled'
    const replaced = unversioned ? versionsOf(b.id, key).find((v) => (v.versionId ?? 'null') === 'null') : null
    const resv = new Reservation(owner, replaced?.size ?? 0)
    let release = null
    let body = null
    try {
      resv.ensure(declared ?? 0)
      release = acquireSlot()
      body = await ingest(req, { maxBytes: L.maxObjectBytes, resv, declared })
      verifyChecksums(req, body)
      checkWritePreconditions(req, liveOf(b.id, key)) // re-check: the object may have changed while the body streamed in
      if (!db.get('buckets', b.id) || b.deleting) throw new HttpError(404, 'Bucket not found')
      checkObjectBudget(owner, replaced ? 0 : 1)
      const again = unversioned ? versionsOf(b.id, key).find((v) => (v.versionId ?? 'null') === 'null') : null
      resv.commitCheck(body.size, again?.size ?? 0)
      const { rec, freed } = writeVersion(b, key, {
        size: body.size, etag: body.md5.toString('hex'), sha256: body.sha256, contentType: spec.contentType, metadata: spec.metadata, tags: spec.tags ?? {},
        ...(spec.acl ? { acl: spec.acl } : {}), ...(spec.cacheControl ? { cacheControl: spec.cacheControl } : {}), ...(spec.contentDisposition ? { contentDisposition: spec.contentDisposition } : {}),
        ...(spec.contentEncoding ? { contentEncoding: spec.contentEncoding } : {}), ...(spec.contentLanguage ? { contentLanguage: spec.contentLanguage } : {}),
        ...(body.chunks.length === 1 ? { blobId: body.chunks[0].blobId } : { chunks: body.chunks }),
      })
      adoptChunks(body.chunks)
      body = null
      freeChunks(freed)
      emit('storage.object.created', { userId: owner, bucket: b.name, key, versionId: rec.versionId, size: rec.size, etag: rec.etag })
      return rec
    } catch (e) {
      if (body) freeChunks(body.chunks)
      throw e
    } finally { resv.release(); release?.() }
  }

  /* --------------------------------------------------------------- reading objects */
  async function writeOut(res, buf) {
    if (res.destroyed) throw new Error('client closed')
    if (!res.write(buf)) {
      await new Promise((resolve) => {
        const done = () => { res.off('drain', done); res.off('close', done); resolve() }
        res.once('drain', done)
        res.once('close', done)
      })
    }
  }
  /** Writes bytes [start, end] of an object chunk by chunk (memory use is one chunk). Returns the number of bytes written. */
  async function writeRange(res, o, start, end, prefetched) {
    let pos = 0
    let sent = 0
    for (const c of chunksOf(o)) {
      const cs = pos
      const ce = pos + c.size - 1
      pos += c.size
      if (ce < start) continue
      if (cs > end) break
      const buf = prefetched?.get(c.blobId) ?? db.getBlob(c.blobId)
      if (!buf || buf.length !== c.size) throw new Error(`blob ${c.blobId} is missing`)
      const slice = buf.subarray(Math.max(start, cs) - cs, Math.min(end, ce) - cs + 1)
      await writeOut(res, slice)
      sent += slice.length
    }
    return sent
  }

  function corsRuleFor(b, origin, method, requestedHeaders) {
    if (!origin) return null
    for (const rule of bset(b).cors) {
      if (!rule.allowedMethods.includes(method)) continue
      if (!rule.allowedOrigins.some((p) => originMatches(p, origin))) continue
      if (requestedHeaders && !requestedHeaders.every((h) => rule.allowedHeaders.some((p) => p === '*' || p.toLowerCase() === h.toLowerCase()))) continue
      return rule
    }
    return null
  }
  function originMatches(pattern, origin) {
    if (pattern === '*') return true
    if (!pattern.includes('*')) return pattern === origin
    const [head, tail] = pattern.split('*')
    return origin.length >= head.length + tail.length && origin.startsWith(head) && origin.endsWith(tail)
  }
  /** CORS headers of a normal (non-preflight) response, from the bucket's rules. */
  function corsHeaders(b, req, method) {
    const out = {}
    if (bset(b).cors.length) out.vary = 'Origin'
    const rule = corsRuleFor(b, hdr(req, 'origin'), method, null)
    if (rule) {
      out['access-control-allow-origin'] = rule.allowedOrigins.includes('*') ? '*' : hdr(req, 'origin')
      if (rule.exposeHeaders.length) out['access-control-expose-headers'] = rule.exposeHeaders.join(', ')
    }
    return out
  }
  function preflight(b, rc) {
    const { req, res } = rc
    const origin = hdr(req, 'origin')
    const method = String(hdr(req, 'access-control-request-method') ?? '').toUpperCase()
    const asked = String(hdr(req, 'access-control-request-headers') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    if (!b || !origin || !CORS_METHODS.includes(method) || asked.length > 30 || asked.some((h) => !/^[A-Za-z0-9_-]{1,100}$/.test(h))) {
      res.writeHead(403, { 'content-length': 0 })
      res.end()
      return HANDLED
    }
    const rule = corsRuleFor(b, origin, method, asked)
    if (!rule) { res.writeHead(403, { vary: 'Origin', 'content-length': 0 }); res.end(); return HANDLED }
    res.writeHead(204, {
      vary: 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method',
      'access-control-allow-origin': rule.allowedOrigins.includes('*') ? '*' : origin,
      'access-control-allow-methods': rule.allowedMethods.join(', '),
      ...(asked.length ? { 'access-control-allow-headers': asked.join(', ') } : {}),
      ...(rule.exposeHeaders.length ? { 'access-control-expose-headers': rule.exposeHeaders.join(', ') } : {}),
      'access-control-max-age': String(rule.maxAgeSeconds ?? 3600),
      'content-length': 0,
    })
    res.end()
    return HANDLED
  }

  /**
   * Serves one stored version (GET / HEAD) with conditional requests and ranges.
   * mode: 'api' (authenticated console / API), 'pub' (public-read), 'presigned', 'site' (website hosting).
   * Public modes send nosniff + an inert, sandboxed CSP; see docs/storage.md "Serving user content safely".
   */
  async function serveObject(rc, b, o, { mode, status = 200, disposition = null }) {
    const { req, res } = rc
    const head = req.method === 'HEAD'
    const etag = `"${etagOf(o)}"`
    const lastMs = Math.floor(Date.parse(o.createdAt) / 1000) * 1000
    const headers = {
      etag, 'last-modified': new Date(lastMs).toUTCString(), 'accept-ranges': 'bytes', 'content-type': o.contentType,
      'x-content-type-options': 'nosniff', 'x-rd-version-id': o.versionId ?? 'null',
    }
    for (const [k, v] of Object.entries(o.metadata ?? {})) headers[`x-rd-meta-${k}`] = v
    if (o.tags && Object.keys(o.tags).length) headers['x-rd-tag-count'] = String(Object.keys(o.tags).length)
    if (o.sha256) headers['x-rd-checksum-sha256'] = o.sha256
    if (o.contentEncoding) headers['content-encoding'] = o.contentEncoding
    if (o.contentLanguage) headers['content-language'] = o.contentLanguage
    if (mode === 'api') {
      headers['content-security-policy'] = "default-src 'none'; sandbox"
      if (o.contentDisposition) headers['content-disposition'] = o.contentDisposition
    } else {
      headers['cross-origin-resource-policy'] = 'cross-origin'
      headers['cache-control'] = mode === 'presigned' ? 'private, no-cache' : (o.cacheControl ?? 'public, max-age=0, must-revalidate')
      if (mode === 'site') {
        headers['content-security-policy'] = SITE_CSP
        headers['access-control-allow-origin'] = '*'
        if (o.contentDisposition) headers['content-disposition'] = o.contentDisposition
      } else {
        Object.assign(headers, corsHeaders(b, req, req.method))
        headers['content-security-policy'] = INERT_CSP
        if (disposition) headers['content-disposition'] = dispositionFor(disposition, o.key)
        else if (o.contentDisposition) headers['content-disposition'] = o.contentDisposition
        else if (ACTIVE_TYPE.test(o.contentType)) headers['content-disposition'] = dispositionFor('attachment', o.key)
      }
    }
    const cond = status === 200 ? evalPreconditions(req, etag, lastMs, true) : 'ok'
    if (cond === 412) throw new HttpError(412, 'Precondition failed')
    if (cond === 304) {
      delete headers['content-type']
      res.writeHead(304, headers)
      res.end()
      meter(b.userId, 1)
      return HANDLED
    }
    let ranges = null
    const rangeHeader = hdr(req, 'range')
    if (rangeHeader !== undefined && status === 200) {
      const ifRange = hdr(req, 'if-range')
      let honour = true
      if (ifRange !== undefined) {
        const t = ifRange.trim()
        honour = t.startsWith('"') ? t === etag : Date.parse(t) === lastMs
      }
      if (honour) ranges = parseRange(rangeHeader, o.size)
    }
    if (ranges === 'unsat') {
      const e = new HttpError(416, 'Range not satisfiable')
      e.headers = { 'content-range': `bytes */${o.size}` }
      throw e
    }
    // read the first needed chunk before committing to a status line: storage damage then surfaces as a clean 500, never as wrong bytes
    const first = ranges ? ranges[0].start : 0
    const prefetched = new Map()
    if (!head && o.size > 0) {
      let pos = 0
      for (const c of chunksOf(o)) {
        if (pos + c.size > first) { const buf = db.getBlob(c.blobId); if (!buf || buf.length !== c.size) throw new Error(`blob ${c.blobId} is missing`); prefetched.set(c.blobId, buf); break }
        pos += c.size
      }
    }
    let boundary = null
    let plan = [{ start: 0, end: o.size - 1 }]
    let code = status
    let total = o.size
    if (ranges) {
      plan = ranges
      code = 206
      if (ranges.length === 1) {
        headers['content-range'] = `bytes ${ranges[0].start}-${ranges[0].end}/${o.size}`
        total = ranges[0].end - ranges[0].start + 1
      } else {
        boundary = `rd${crypto.randomBytes(12).toString('hex')}`
        const heads = ranges.map((x) => `--${boundary}\r\ncontent-type: ${o.contentType}\r\ncontent-range: bytes ${x.start}-${x.end}/${o.size}\r\n\r\n`)
        const tail = `--${boundary}--\r\n`
        total = heads.reduce((s, h, i) => s + h.length + (ranges[i].end - ranges[i].start + 1) + 2, 0) + tail.length
        headers['content-type'] = `multipart/byteranges; boundary=${boundary}`
        plan = ranges.map((x, i) => ({ ...x, head: heads[i] }))
        plan.tail = tail
      }
    }
    headers['content-length'] = String(total)
    res.writeHead(code, headers)
    if (head || o.size === 0) { res.end(); meter(b.userId, 1); return HANDLED }
    let sent = 0
    try {
      for (const part of plan) {
        if (boundary) await writeOut(res, Buffer.from(part.head))
        sent += await writeRange(res, o, part.start, part.end, prefetched)
        if (boundary) await writeOut(res, Buffer.from('\r\n'))
      }
      if (boundary) await writeOut(res, Buffer.from(plan.tail))
      res.end()
    } catch (e) {
      if (!res.destroyed) logErr(`streaming ${o.key} failed`, e)
      res.destroy() // truncated response: the client sees a short body, never wrong bytes
    }
    meter(b.userId, 1, sent)
    return HANDLED
  }

  /* --------------------------------------------------------------- presigned URLs */
  function presignKey() {
    if (presignKeyCache) return presignKeyCache
    const env = process.env.RD_STORAGE_PRESIGN_SECRET
    let secret = null
    if (env && env.length >= 16) secret = crypto.createHash('sha256').update(`rd-storage-presign\n${env}`).digest()
    if (!secret && typeof authMod.masterKey === 'function') {
      try { secret = crypto.createHmac('sha256', authMod.masterKey(ctx)).update('rd-storage-presign-v1').digest() } catch (e) { logErr('master key unavailable, using a stored secret', e) }
    }
    if (!secret) {
      let row = db.get('st_state', 'presign')
      if (!row) row = db.insert('st_state', { id: 'presign', secret: crypto.randomBytes(32).toString('hex') })
      secret = Buffer.from(row.secret, 'hex')
    }
    return (presignKeyCache = secret)
  }
  function signPresign(b, { method, key, expires, versionId = '', contentType = '', disposition = '' }) {
    const data = ['rd-presign-v1', method, b.id, String(b.presignEpoch ?? 0), key, String(expires), versionId, contentType, disposition].join('\n')
    return crypto.createHmac('sha256', presignKey()).update(data).digest('hex')
  }
  const encodeKeyPath = (key) => key.split('/').map(encodeURIComponent).join('/')

  /* --------------------------------------------------------------- listing */
  function sortedLive(b, prefix) {
    const out = []
    for (const o of rows('objects', 'bucketId', b.id)) if (o.isLatest !== false && !o.deleteMarker && o.key.startsWith(prefix)) out.push(o)
    return out.sort((x, y) => keyCompare(x.key, y.key))
  }
  function listObjects(b, { prefix, delimiter, maxKeys, token, startAfter }) {
    const all = sortedLive(b, prefix)
    const objects = []
    const commonPrefixes = []
    let count = 0
    let marker = null
    let truncated = false
    let lastCommon = null
    const after = token ? token.k : startAfter
    for (const o of all) {
      if (after !== undefined && after !== null) {
        if (token?.p ? (o.key.startsWith(after) || keyCompare(o.key, after) <= 0) : keyCompare(o.key, after) <= 0) continue
      }
      let cp = null
      if (delimiter) {
        const i = o.key.indexOf(delimiter, prefix.length)
        if (i >= 0) cp = o.key.slice(0, i + delimiter.length)
      }
      if (cp) {
        if (cp === lastCommon) continue
        if (count >= maxKeys) { truncated = true; break }
        commonPrefixes.push(cp)
        lastCommon = cp
        marker = { k: cp, p: 1 }
      } else {
        if (count >= maxKeys) { truncated = true; break }
        objects.push(o)
        marker = { k: o.key }
      }
      count++
    }
    return { objects, commonPrefixes, truncated, next: truncated ? b64url(marker) : null }
  }

  /* --------------------------------------------------------------- validation of bucket settings */
  function normCorsRules(input) {
    const arr = Array.isArray(input) ? input : asObject(input).rules
    if (!Array.isArray(arr)) throw bad('rules must be an array')
    if (arr.length > 100) throw bad('At most 100 CORS rules are allowed')
    return arr.map((x, i) => {
      const o = asObject(x, `rules[${i}]`)
      const strList = (v, name, min, max, re) => {
        if (v === undefined && min === 0) return []
        if (!Array.isArray(v) || v.length < min || v.length > max) throw bad(`rules[${i}].${name} must be a list of ${min}-${max} strings`)
        for (const s of v) if (typeof s !== 'string' || s.length > 255 || !re.test(s)) throw bad(`rules[${i}].${name} contains an invalid value`)
        return [...new Set(v)]
      }
      const allowedMethods = strList(o.allowedMethods, 'allowedMethods', 1, 5, /^[A-Z]+$/)
      if (allowedMethods.some((m) => !CORS_METHODS.includes(m))) throw bad(`rules[${i}].allowedMethods may contain ${CORS_METHODS.join(', ')}`)
      return {
        id: o.id === undefined ? `cors-${i + 1}` : headerText('rule id', o.id, 64) || `cors-${i + 1}`,
        allowedOrigins: strList(o.allowedOrigins, 'allowedOrigins', 1, 20, /^(?:\*|https?:\/\/[A-Za-z0-9.*:[\]-]{1,200})$/).map((p) => {
          if ((p.match(/\*/g) ?? []).length > 1) throw bad(`rules[${i}].allowedOrigins allows at most one "*" per origin`)
          return p
        }),
        allowedMethods,
        allowedHeaders: strList(o.allowedHeaders, 'allowedHeaders', 0, 20, /^(?:\*|[A-Za-z0-9_-]{1,100})$/),
        exposeHeaders: strList(o.exposeHeaders, 'exposeHeaders', 0, 20, /^[A-Za-z0-9_-]{1,100}$/),
        maxAgeSeconds: optInt(o.maxAgeSeconds, `rules[${i}].maxAgeSeconds`, 0, 86_400) ?? 3600,
      }
    })
  }
  function normLifecycleRules(input) {
    const arr = Array.isArray(input) ? input : asObject(input).rules
    if (!Array.isArray(arr)) throw bad('rules must be an array')
    if (arr.length > 100) throw bad('At most 100 lifecycle rules are allowed')
    const seen = new Set()
    return arr.map((x, i) => {
      const o = asObject(x, `rules[${i}]`)
      const id = o.id === undefined ? `rule-${i + 1}` : String(o.id)
      if (!/^[\w.:-]{1,64}$/.test(id)) throw bad(`rules[${i}].id must be 1-64 characters of [A-Za-z0-9_.:-]`)
      if (seen.has(id)) throw bad(`Duplicate rule id "${id}"`)
      seen.add(id)
      const status = o.status ?? 'enabled'
      if (status !== 'enabled' && status !== 'disabled') throw bad(`rules[${i}].status must be enabled or disabled`)
      const rule = {
        id, status, prefix: normPrefix(o.prefix, `rules[${i}].prefix`), tags: normTags(o.tags, 10),
        expirationDays: optInt(o.expirationDays, 'expirationDays', 1, 36_500),
        noncurrentExpirationDays: optInt(o.noncurrentExpirationDays, 'noncurrentExpirationDays', 1, 36_500),
        abortIncompleteMultipartDays: optInt(o.abortIncompleteMultipartDays, 'abortIncompleteMultipartDays', 1, 365),
        expiredObjectDeleteMarker: o.expiredObjectDeleteMarker === true,
        minSize: optInt(o.minSize, 'minSize', 0, 2 ** 50), maxSize: optInt(o.maxSize, 'maxSize', 0, 2 ** 50),
      }
      for (const k of Object.keys(rule)) if (rule[k] === undefined) delete rule[k]
      if (!rule.expirationDays && !rule.noncurrentExpirationDays && !rule.abortIncompleteMultipartDays && !rule.expiredObjectDeleteMarker) {
        throw bad(`rules[${i}] needs at least one action (expirationDays, noncurrentExpirationDays, abortIncompleteMultipartDays, expiredObjectDeleteMarker)`)
      }
      return rule
    })
  }
  function normWebsite(input) {
    const o = asObject(input)
    const index = o.indexDocument === undefined ? 'index.html' : normKey(o.indexDocument, 'indexDocument')
    if (index.includes('/')) throw bad('indexDocument must not contain "/"')
    const error = o.errorDocument === undefined || o.errorDocument === null || o.errorDocument === '' ? null : normKey(o.errorDocument, 'errorDocument')
    return { indexDocument: index, errorDocument: error }
  }

  /* ======================================================================================= lifecycle sweeper */
  function referencedBlobIds() {
    const ids = new Set()
    for (const o of db.find('objects', () => true)) for (const c of chunksOf(o)) ids.add(c.blobId)
    for (const p of db.find('st_parts', () => true)) for (const c of p.chunks ?? []) ids.add(c.blobId)
    return ids
  }

  /**
   * One pass of the lifecycle engine. Safe to call at any time (it is what the interval runs); tests pass `now` to time-travel.
   * Returns a report; `dryRun` reports without changing anything. At most `maxActions` objects/versions/uploads are touched per call.
   */
  function sweep({ now = Date.now(), dryRun = false, bucketId = null, maxActions = L.sweepBatch, orphans = false } = {}) {
    const rep = { dryRun, expired: 0, noncurrentRemoved: 0, markersRemoved: 0, uploadsAborted: 0, orphanBlobsRemoved: 0, bytesFreed: 0, truncated: false, sample: [] }
    let budget = maxActions
    const spend = (what, key) => { budget--; if (rep.sample.length < 50) rep.sample.push({ action: what, key }); return budget >= 0 }
    const buckets = bucketId ? [db.get('buckets', bucketId)].filter(Boolean) : db.find('buckets', () => true)
    for (const b of buckets) {
      const s = bset(b)
      const rules = s.lifecycle.filter((x) => x.status === 'enabled')
      // abandoned multipart uploads: the global TTL plus per-rule windows
      for (const u of rows('st_uploads', 'bucketId', b.id).slice()) {
        const age = now - Date.parse(u.createdAt)
        const byRule = rules.some((x) => x.abortIncompleteMultipartDays && u.key.startsWith(x.prefix ?? '') && age >= x.abortIncompleteMultipartDays * DAY)
        if (age < L.uploadTtlMs && !byRule) continue
        if (!spend('abort-upload', u.key)) { rep.truncated = true; break }
        rep.uploadsAborted++
        if (!dryRun) rep.bytesFreed += dropUpload(u)
      }
      if (!rules.length || budget < 0) continue
      const matches = (rule, o) => o.key.startsWith(rule.prefix ?? '')
        && Object.entries(rule.tags ?? {}).every(([k, v]) => o.tags?.[k] === v)
        && (rule.minSize === undefined || o.size >= rule.minSize) && (rule.maxSize === undefined || o.size <= rule.maxSize)
      const all = rows('objects', 'bucketId', b.id).slice()
      const gone = new Set()
      // 1. noncurrent versions
      for (const o of all) {
        if (o.isLatest !== false) continue
        const age = now - Date.parse(o.noncurrentSince ?? o.createdAt)
        if (!rules.some((x) => x.noncurrentExpirationDays && matches(x, o) && age >= x.noncurrentExpirationDays * DAY)) continue
        if (!spend('remove-noncurrent', o.key)) { rep.truncated = true; break }
        rep.noncurrentRemoved++
        rep.bytesFreed += o.size
        gone.add(o.id)
        if (!dryRun) removeVersion(o)
      }
      // 2. current objects older than expirationDays
      if (budget >= 0) {
        for (const o of all) {
          if (o.isLatest === false || o.deleteMarker || gone.has(o.id)) continue
          const age = now - Date.parse(o.createdAt)
          if (!rules.some((x) => x.expirationDays && matches(x, o) && age >= x.expirationDays * DAY)) continue
          if (!spend('expire', o.key)) { rep.truncated = true; break }
          rep.expired++
          if (s.versioning === 'disabled') rep.bytesFreed += o.size
          gone.add(o.id)
          if (!dryRun) deleteCurrent(b, o.key)
        }
      }
      // 3. delete markers that hide nothing any more
      if (budget >= 0 && rules.some((x) => x.expiredObjectDeleteMarker)) {
        for (const o of all) {
          if (!o.deleteMarker || o.isLatest === false || gone.has(o.id)) continue
          if (!rules.some((x) => x.expiredObjectDeleteMarker && o.key.startsWith(x.prefix ?? ''))) continue
          const others = dryRun ? all.filter((x) => x.key === o.key && x.id !== o.id && !gone.has(x.id)) : versionsOf(b.id, o.key).filter((x) => x.id !== o.id)
          if (others.length) continue
          if (!spend('remove-delete-marker', o.key)) { rep.truncated = true; break }
          rep.markersRemoved++
          if (!dryRun) removeVersion(o)
        }
      }
    }
    const realNow = Date.now()
    if (orphans || realNow - lastOrphanScan >= L.orphanScanEveryMs) {
      if (!dryRun) lastOrphanScan = realNow
      const refs = referencedBlobIds()
      let list = []
      try { list = db.listBlobs() } catch (e) { logErr('blob scan failed', e) }
      for (const blob of list) {
        if (!blob.id.startsWith(`${BLOB_PREFIX}_`) || refs.has(blob.id) || inflight.has(blob.id) || realNow - (blob.mtimeMs ?? 0) < L.orphanGraceMs) continue
        rep.orphanBlobsRemoved++
        rep.bytesFreed += blob.size ?? 0
        if (!dryRun) { try { db.deleteBlob(blob.id) } catch (e) { logErr('orphan delete failed', e) } }
      }
    }
    return rep
  }

  /* ======================================================================================= public surface for other modules + tests */
  const storage = ctx.storage = {
    limits: L, sweep, flushMetering, usageOf, referencedBlobIds, signPresign, quotaFor: (_userId) => L.quotaBytes, // billing may replace this with a per-plan lookup
   
    /** Blob ids of everything this module stores. Any blob garbage collector MUST treat these as referenced (db.gcBlobs((id) => storage.referencedBlobIds().has(id))). */
    isReferenced: (id) => referencedBlobIds().has(id),
  }
  ctx.blobRefs?.set?.('storage', referencedBlobIds)

  for (const b of db.find('buckets', (x) => x.deleting)) purgeBucket(b)
  const timers = []
  if (L.sweepIntervalMs > 0) {
    const t = setInterval(() => { try { sweep() } catch (e) { logErr('sweep failed', e) } }, L.sweepIntervalMs)
    t.unref?.()
    timers.push(t)
  }
  const meterTimer = setInterval(flushMetering, 30_000)
  meterTimer.unref?.()
  timers.push(meterTimer)
  ctx.events.on('shutdown', () => { for (const t of timers) clearInterval(t); flushMetering() })

  /* ======================================================================================= routes: service info */
  r.get('/api/storage/usage', ({ user }) => {
    const u = usageOf(user.id)
    return { usedBytes: u.bytes, objectBytes: u.objectBytes, inFlightMultipartBytes: u.partBytes, quotaBytes: quotaFor(user.id), versions: u.objects, openUploads: u.uploads, buckets: rows('buckets', 'userId', user.id).length }
  }, { meta: { summary: 'Storage usage and quota of the caller' } })
  r.get('/api/storage/info', ({ user }) => ({
    regions: L.regions, versioningStates: VERSIONING, acls: BUCKET_ACLS,
    limits: {
      maxObjectBytes: L.maxObjectBytes, minPartBytes: L.minPartBytes, maxPartBytes: L.maxPartBytes, maxParts: L.maxParts, chunkBytes: L.chunkBytes, maxBuckets: L.maxBuckets,
      maxKeys: L.maxListKeys, maxBatchDelete: L.maxBatch, presignMaxSeconds: L.presignMaxSeconds, uploadTtlHours: L.uploadTtlMs / 3_600_000,
    },
    quotaBytes: quotaFor(user.id),
  }), { meta: { summary: 'Limits, regions and capabilities of the storage service' } })

  /* ======================================================================================= routes: buckets */
  r.get('/api/buckets', ({ user }) => ({ buckets: rows('buckets', 'userId', user.id).filter((b) => !b.deleting).map((b) => bucketView(b)) }), { meta: { summary: 'List your buckets' } })

  r.post('/api/buckets', ({ user, body, req, requestId }) => {
    const o = asObject(body)
    required(o, 'name')
    if (typeof o.name !== 'string' || !BUCKET_RE.test(o.name)) throw bad('Bucket name must be 3-63 chars: lowercase letters, digits, hyphens')
    if (rows('buckets', 'name', o.name).length) throw new HttpError(409, 'Bucket name already taken')
    if (rows('buckets', 'userId', user.id).length >= L.maxBuckets) throw new HttpError(409, `Bucket limit reached (${L.maxBuckets})`)
    const region = o.region ?? L.regions[0]
    if (!L.regions.includes(region)) throw bad(`region must be one of ${L.regions.join(', ')}`)
    const versioning = o.versioning ?? 'disabled'
    if (versioning !== 'disabled' && versioning !== 'enabled') throw bad('versioning must be disabled or enabled')
    const acl = o.acl ?? 'private'
    if (!BUCKET_ACLS.includes(acl)) throw bad(`acl must be one of ${BUCKET_ACLS.join(', ')}`)
    const b = db.insert('buckets', { userId: user.id, name: o.name, region, versioning, acl, cors: [], lifecycle: [], website: null, tags: normTags(o.tags, 50), presignEpoch: 0 })
    audit({ req, requestId }, user.id, 'storage.bucket.create', `bucket:${b.name}`, { region, versioning, acl })
    return [201, bucketView(b, true)]
  }, { meta: { summary: 'Create a bucket', request: { name: 'my-bucket', region: 'rd-local', versioning: 'disabled', acl: 'private' } } })

  r.get('/api/buckets/:bucket', ({ user, params }) => bucketView(ownBucket(user, params.bucket), true), { meta: { summary: 'Bucket settings and statistics' } })
  r.add('HEAD', '/api/buckets/:bucket', ({ user, params, res }) => {
    ownBucket(user, params.bucket)
    res.writeHead(200, { 'content-length': 0 })
    res.end()
    return HANDLED
  }, { stream: true })

  r.patch('/api/buckets/:bucket', ({ user, params, body, req, requestId }) => {
    const b = ownBucket(user, params.bucket)
    const o = asObject(body)
    const patch = {}
    const cur = bset(b)
    if (o.region !== undefined && o.region !== cur.region) throw bad('A bucket region cannot be changed')
    if (o.versioning !== undefined) {
      if (!VERSIONING.includes(o.versioning)) throw bad(`versioning must be one of ${VERSIONING.join(', ')}`)
      if (o.versioning === 'disabled' && cur.versioning !== 'disabled') throw bad('Versioning can be suspended but not disabled again')
      patch.versioning = o.versioning
    }
    if (o.acl !== undefined) {
      if (!BUCKET_ACLS.includes(o.acl)) throw bad(`acl must be one of ${BUCKET_ACLS.join(', ')}`)
      patch.acl = o.acl
    }
    if (o.tags !== undefined) patch.tags = normTags(o.tags, 50)
    if (!Object.keys(patch).length) throw bad('Nothing to change (versioning, acl, tags)')
    const updated = db.update('buckets', b.id, patch)
    audit({ req, requestId }, user.id, 'storage.bucket.update', `bucket:${b.name}`, { ...patch, tags: undefined })
    return bucketView(updated, true)
  }, { meta: { summary: 'Change versioning, ACL or tags' } })

  r.delete('/api/buckets/:bucket', async ({ user, params, query, req, requestId }) => {
    const b = ownBucket(user, params.bucket)
    const force = query.get('force') === 'true' || query.get('force') === '1'
    const hasObjects = rows('objects', 'bucketId', b.id).length > 0 || rows('st_uploads', 'bucketId', b.id).length > 0
    if (hasObjects && !force) throw new HttpError(409, 'Bucket is not empty')
    if (hasObjects) {
      db.update('buckets', b.id, { deleting: true })
      await purgeBucket(b)
    } else db.remove('buckets', b.id)
    audit({ req, requestId }, user.id, 'storage.bucket.delete', `bucket:${b.name}`, { force })
    return { ok: true }
  }, { meta: { summary: 'Delete a bucket (409 when not empty; ?force=true removes its contents too)' } })

  // ---- settings sub-resources
  r.get('/api/buckets/:bucket/cors', ({ user, params }) => ({ rules: bset(ownBucket(user, params.bucket)).cors }))
  r.put('/api/buckets/:bucket/cors', ({ user, params, body, req, requestId }) => {
    const b = ownBucket(user, params.bucket)
    const rules = normCorsRules(body)
    db.update('buckets', b.id, { cors: rules })
    audit({ req, requestId }, user.id, 'storage.bucket.cors', `bucket:${b.name}`, { rules: rules.length })
    return { rules }
  }, { meta: { summary: 'Replace the CORS rules of a bucket', request: { rules: [{ allowedOrigins: ['https://app.example.com'], allowedMethods: ['GET', 'PUT'], allowedHeaders: ['*'], exposeHeaders: ['ETag'], maxAgeSeconds: 3600 }] } } })
  r.delete('/api/buckets/:bucket/cors', ({ user, params }) => { db.update('buckets', ownBucket(user, params.bucket).id, { cors: [] }); return { ok: true } })

  r.get('/api/buckets/:bucket/lifecycle', ({ user, params }) => ({ rules: bset(ownBucket(user, params.bucket)).lifecycle }))
  r.put('/api/buckets/:bucket/lifecycle', ({ user, params, body, req, requestId }) => {
    const b = ownBucket(user, params.bucket)
    const rules = normLifecycleRules(body)
    db.update('buckets', b.id, { lifecycle: rules })
    audit({ req, requestId }, user.id, 'storage.bucket.lifecycle', `bucket:${b.name}`, { rules: rules.length })
    return { rules }
  }, { meta: { summary: 'Replace the lifecycle rules of a bucket', request: { rules: [{ id: 'tmp', prefix: 'tmp/', expirationDays: 7, noncurrentExpirationDays: 30, abortIncompleteMultipartDays: 3 }] } } })
  r.delete('/api/buckets/:bucket/lifecycle', ({ user, params }) => { db.update('buckets', ownBucket(user, params.bucket).id, { lifecycle: [] }); return { ok: true } })
  r.post('/api/buckets/:bucket/lifecycle/run', ({ user, params, query, req, requestId }) => {
    const b = ownBucket(user, params.bucket)
    const dryRun = query.get('dryRun') === 'true' || query.get('dryRun') === '1'
    const rep = sweep({ bucketId: b.id, dryRun })
    if (!dryRun) audit({ req, requestId }, user.id, 'storage.lifecycle.run', `bucket:${b.name}`, { expired: rep.expired, noncurrent: rep.noncurrentRemoved, uploads: rep.uploadsAborted })
    return rep
  }, { meta: { summary: 'Run the lifecycle rules now (?dryRun=true only reports)' } })

  r.get('/api/buckets/:bucket/website', ({ user, params }) => {
    const w = bset(ownBucket(user, params.bucket)).website
    if (!w) throw new HttpError(404, 'Website hosting is not enabled')
    return { ...w, url: `${(process.env.RD_PUBLIC_URL ?? '').replace(/\/+$/, '')}/site/${params.bucket}/` }
  })
  r.put('/api/buckets/:bucket/website', ({ user, params, body, req, requestId }) => {
    const b = ownBucket(user, params.bucket)
    const w = normWebsite(body)
    db.update('buckets', b.id, { website: w })
    audit({ req, requestId }, user.id, 'storage.bucket.website', `bucket:${b.name}`, w)
    return { ...w, url: `${(process.env.RD_PUBLIC_URL ?? '').replace(/\/+$/, '')}/site/${b.name}/`, public: bset(b).acl === 'public-read' }
  }, { meta: { summary: 'Enable static website hosting (serves public objects at /site/<bucket>/)', request: { indexDocument: 'index.html', errorDocument: '404.html' } } })
  r.delete('/api/buckets/:bucket/website', ({ user, params }) => { db.update('buckets', ownBucket(user, params.bucket).id, { website: null }); return { ok: true } })

  r.get('/api/buckets/:bucket/tags', ({ user, params }) => ({ tags: bset(ownBucket(user, params.bucket)).tags }))
  r.put('/api/buckets/:bucket/tags', ({ user, params, body }) => {
    const b = ownBucket(user, params.bucket)
    const tags = normTags(asObject(body).tags, 50)
    db.update('buckets', b.id, { tags })
    return { tags }
  })

  /* ======================================================================================= routes: objects */
  r.get('/api/buckets/:bucket/objects', ({ user, params, query }) => {
    const b = ownBucket(user, params.bucket)
    meter(user.id, 1)
    const prefix = normPrefix(query.get('prefix') ?? '')
    const delimiter = query.get('delimiter') ?? ''
    if (delimiter.length > 16 || hasControl(delimiter)) throw bad('Invalid delimiter')
    const maxKeys = intQ(query, ['max-keys', 'limit'], L.maxListKeys, 1, L.maxListKeys)
    const tokenRaw = query.get('continuation-token') ?? query.get('cursor')
    const token = tokenRaw ? unb64url(tokenRaw, 'continuation token') : null
    if (token && typeof token.k !== 'string') throw bad('Invalid continuation token')
    const startAfter = query.get('start-after') ?? undefined
    const out = listObjects(b, { prefix, delimiter, maxKeys, token, startAfter })
    return {
      bucket: b.name, prefix, delimiter: delimiter || null, maxKeys, keyCount: out.objects.length + out.commonPrefixes.length, isTruncated: out.truncated,
      nextContinuationToken: out.next, nextCursor: out.next, objects: out.objects.map(view), commonPrefixes: out.commonPrefixes,
    }
  }, { meta: { summary: 'List objects (prefix, delimiter, max-keys, continuation-token)' } })

  const objectKey = (params) => normKey(params.key)
  const versionParam = (query) => {
    const v = query.get('versionId')
    if (v === null || v === '') return null
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(v)) throw bad('Invalid versionId')
    return v
  }

  r.put('/api/buckets/:bucket/objects/*key', async (rc) => {
    const { user, params, res } = rc
    const b = ownBucket(user, params.bucket)
    const key = objectKey(params)
    meter(user.id, 1)
    const rec = await putObject(rc, b, key, { trusted: true })
    res.setHeader('etag', `"${rec.etag}"`)
    if (rec.versionId !== 'null') res.setHeader('x-rd-version-id', rec.versionId)
    return [201, view(rec)]
  }, { stream: true, meta: { summary: 'Upload an object (raw body; headers: Content-Type, Content-MD5, x-rd-checksum-sha256, x-rd-meta-*, x-rd-acl, x-rd-tagging, If-None-Match: *)' } })

  const objectReader = (rc, mode) => {
    const { user, params, query } = rc
    const b = ownBucket(user, params.bucket)
    const key = objectKey(params)
    const vid = versionParam(query)
    let o
    if (vid) {
      o = versionsOf(b.id, key).find((v) => (v.versionId ?? 'null') === vid)
      if (!o) throw new HttpError(404, 'Version not found')
      if (o.deleteMarker) {
        const e = new HttpError(405, 'The specified version is a delete marker')
        e.headers = { 'x-rd-delete-marker': 'true', 'x-rd-version-id': o.versionId }
        throw e
      }
    } else {
      const latest = versionsOf(b.id, key).find((v) => v.isLatest !== false)
      if (!latest || latest.deleteMarker) {
        const e = new HttpError(404, 'Object not found')
        if (latest) e.headers = { 'x-rd-delete-marker': 'true', 'x-rd-version-id': latest.versionId }
        throw e
      }
      o = latest
    }
    return serveObject(rc, b, o, { mode })
  }
  r.get('/api/buckets/:bucket/objects/*key', (rc) => objectReader(rc, 'api'), { stream: true, meta: { summary: 'Download an object (Range, If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since, ?versionId=)' } })
  r.add('HEAD', '/api/buckets/:bucket/objects/*key', (rc) => objectReader(rc, 'api'), { stream: true })

  r.delete('/api/buckets/:bucket/objects/*key', ({ user, params, query, req, requestId }) => {
    const b = ownBucket(user, params.bucket)
    const key = objectKey(params)
    const vid = versionParam(query)
    meter(user.id, 1)
    if (vid) {
      const o = versionsOf(b.id, key).find((v) => (v.versionId ?? 'null') === vid)
      if (!o) throw new HttpError(404, 'Version not found')
      removeVersion(o)
      audit({ req, requestId }, user.id, 'storage.version.delete', `bucket:${b.name}/${key}`, { versionId: vid })
      emit('storage.object.deleted', { userId: user.id, bucket: b.name, key, versionId: vid, permanent: true })
      return { ok: true, key, versionId: vid, deleteMarker: !!o.deleteMarker }
    }
    if (!liveOf(b.id, key)) throw new HttpError(404, 'Object not found')
    const out = deleteCurrent(b, key)
    emit('storage.object.deleted', { userId: user.id, bucket: b.name, key, versionId: out.versionId, permanent: !out.deleteMarker })
    return { ok: true, key, ...out }
  }, { meta: { summary: 'Delete an object (a delete marker when versioning is enabled) or one version (?versionId=)' } })

  r.post('/api/buckets/:bucket/delete', ({ user, params, body, req, requestId }) => {
    const b = ownBucket(user, params.bucket)
    const o = asObject(body)
    const deleted = []
    const errors = []
    let truncated = false
    if (o.prefix !== undefined) {
      const prefix = normPrefix(o.prefix)
      if (!prefix) throw bad('prefix must not be empty')
      const keys = sortedLive(b, prefix).map((x) => x.key)
      truncated = keys.length > L.maxPrefixDelete
      for (const key of keys.slice(0, L.maxPrefixDelete)) deleted.push({ key, ...deleteCurrent(b, key) })
      meter(user.id, 1)
      audit({ req, requestId }, user.id, 'storage.prefix.delete', `bucket:${b.name}/${prefix}`, { count: deleted.length })
      return { deleted, errors, truncated }
    }
    if (!Array.isArray(o.objects) || !o.objects.length) throw bad('objects must be a non-empty array of { key, versionId? }')
    if (o.objects.length > L.maxBatch) throw bad(`At most ${L.maxBatch} objects per request`)
    meter(user.id, 1)
    for (const item of o.objects) {
      let key = null
      try {
        const it = asObject(item, 'objects[]')
        key = normKey(it.key)
        const vid = it.versionId === undefined ? null : String(it.versionId)
        if (vid !== null && !/^[A-Za-z0-9._-]{1,64}$/.test(vid)) throw bad('Invalid versionId')
        if (vid) {
          const v = versionsOf(b.id, key).find((x) => (x.versionId ?? 'null') === vid)
          if (v) removeVersion(v)
          deleted.push({ key, versionId: vid, deleteMarker: !!v?.deleteMarker })
        } else if (liveOf(b.id, key)) deleted.push({ key, ...deleteCurrent(b, key) })
        else deleted.push({ key, versionId: null, deleteMarker: false }) // batch deletes are idempotent, like S3
      } catch (e) {
        errors.push({ key: typeof item?.key === 'string' ? item.key.slice(0, 200) : null, error: e instanceof HttpError ? e.message : 'Internal error' })
        if (!(e instanceof HttpError)) logErr('batch delete failed', e)
      }
    }
    audit({ req, requestId }, user.id, 'storage.batch.delete', `bucket:${b.name}`, { requested: o.objects.length, deleted: deleted.length, errors: errors.length })
    if (o.quiet === true) return { deleted: [], errors }
    return { deleted, errors }
  }, { meta: { summary: 'Delete up to 1000 keys at once ({objects:[{key,versionId?}]}) or everything under {prefix}' } })

  // ---- metadata, tags, ACL
  const versionOrLive = (b, key, vid) => {
    const o = vid ? versionsOf(b.id, key).find((v) => (v.versionId ?? 'null') === vid) : liveOf(b.id, key)
    if (!o) throw new HttpError(404, vid ? 'Version not found' : 'Object not found')
    return o
  }
  r.get('/api/buckets/:bucket/meta/*key', ({ user, params, query }) => {
    const b = ownBucket(user, params.bucket)
    const o = versionOrLive(b, objectKey(params), versionParam(query))
    if (!o.deleteMarker) etagOf(o)
    return view(o)
  }, { meta: { summary: 'Object properties as JSON (size, ETag, metadata, tags, ACL, version)' } })

  r.get('/api/buckets/:bucket/tagging/*key', ({ user, params, query }) => ({ tags: versionOrLive(ownBucket(user, params.bucket), objectKey(params), versionParam(query)).tags ?? {} }))
  r.put('/api/buckets/:bucket/tagging/*key', ({ user, params, query, body }) => {
    const o = versionOrLive(ownBucket(user, params.bucket), objectKey(params), versionParam(query))
    if (o.deleteMarker) throw bad('A delete marker cannot be tagged')
    const tags = normTags(asObject(body).tags, 10)
    db.update('objects', o.id, { tags })
    return { tags }
  }, { meta: { summary: 'Replace the tags of an object ({tags:{k:v}}, max 10)' } })
  r.delete('/api/buckets/:bucket/tagging/*key', ({ user, params, query }) => {
    const o = versionOrLive(ownBucket(user, params.bucket), objectKey(params), versionParam(query))
    db.update('objects', o.id, { tags: {} })
    return { ok: true }
  })

  r.get('/api/buckets/:bucket/acl/*key', ({ user, params, query }) => {
    const b = ownBucket(user, params.bucket)
    const o = versionOrLive(b, objectKey(params), versionParam(query))
    return { acl: o.acl ?? 'inherit', bucketAcl: bset(b).acl, public: !o.deleteMarker && isPublic(b, o) }
  })
  r.put('/api/buckets/:bucket/acl/*key', ({ user, params, query, body, req, requestId }) => {
    const b = ownBucket(user, params.bucket)
    const key = objectKey(params)
    const o = versionOrLive(b, key, versionParam(query))
    if (o.deleteMarker) throw bad('A delete marker has no ACL')
    const acl = asObject(body).acl
    if (!OBJECT_ACLS.includes(acl)) throw bad(`acl must be one of ${OBJECT_ACLS.join(', ')}`)
    db.update('objects', o.id, { acl })
    audit({ req, requestId }, user.id, 'storage.object.acl', `bucket:${b.name}/${key}`, { acl })
    return { acl, bucketAcl: bset(b).acl, public: isPublic(b, { ...o, acl }) }
  }, { meta: { summary: 'Set the object ACL: inherit (bucket), private, or public-read' } })

  // ---- versions
  r.get('/api/buckets/:bucket/versions', ({ user, params, query }) => {
    const b = ownBucket(user, params.bucket)
    meter(user.id, 1)
    const exact = query.get('key') ? normKey(query.get('key')) : null
    const prefix = normPrefix(query.get('prefix') ?? '')
    const maxKeys = intQ(query, ['max-keys', 'limit'], L.maxListKeys, 1, L.maxListKeys)
    const tokenRaw = query.get('continuation-token') ?? query.get('cursor')
    const token = tokenRaw ? unb64url(tokenRaw, 'continuation token') : null
    if (token && (typeof token.k !== 'string' || typeof token.s !== 'number')) throw bad('Invalid continuation token')
    let list = exact ? versionsOf(b.id, exact) : rows('objects', 'bucketId', b.id).filter((o) => o.key.startsWith(prefix))
    list = list.slice().sort((x, y) => keyCompare(x.key, y.key) || (y.seq ?? 0) - (x.seq ?? 0))
    if (token) list = list.filter((o) => keyCompare(o.key, token.k) > 0 || (o.key === token.k && (o.seq ?? 0) < token.s))
    const page = list.slice(0, maxKeys)
    const truncated = list.length > maxKeys
    const last = page[page.length - 1]
    const next = truncated ? b64url({ k: last.key, s: last.seq ?? 0 }) : null
    return { bucket: b.name, versioning: bset(b).versioning, isTruncated: truncated, nextContinuationToken: next, nextCursor: next, versions: page.map(view) }
  }, { meta: { summary: 'List all versions and delete markers (?key= exact key, ?prefix=)' } })

  r.post('/api/buckets/:bucket/restore', async ({ user, params, body, req, requestId }) => {
    const b = ownBucket(user, params.bucket)
    const o = asObject(body)
    const key = normKey(o.key)
    const vid = String(o.versionId ?? '')
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(vid)) throw bad('versionId is required')
    const src = versionsOf(b.id, key).find((v) => (v.versionId ?? 'null') === vid)
    if (!src) throw new HttpError(404, 'Version not found')
    if (src.deleteMarker) throw bad('A delete marker cannot be restored; delete the marker instead')
    meter(user.id, 1)
    const rec = await copyInto(user, b, key, src, b, key, { directive: 'COPY' }, { restoring: true })
    audit({ req, requestId }, user.id, 'storage.version.restore', `bucket:${b.name}/${key}`, { from: vid, to: rec.versionId })
    return [201, view(rec)]
  }, { meta: { summary: 'Make an old version current again by copying it to a new version' } })

  // ---- server-side copy
  /** Copies `src` (a stored version) to dest bucket/key. Data is copied chunk by chunk, so memory use is one chunk. */
  async function copyInto(user, srcBucket, srcKey, src, destBucket, destKey, o, { restoring = false } = {}) {
    const unversioned = bset(destBucket).versioning !== 'enabled'
    const replaced = unversioned ? versionsOf(destBucket.id, destKey).find((v) => (v.versionId ?? 'null') === 'null') : null
    const resv = new Reservation(user.id, replaced?.size ?? 0)
    let chunks = null
    try {
      resv.ensure(src.size)
      checkObjectBudget(user.id, replaced ? 0 : 1)
      chunks = await copyChunks(chunksOf(src))
      if (!db.get('buckets', destBucket.id) || destBucket.deleting || !db.get('objects', src.id)) throw new HttpError(404, 'Source or destination disappeared during the copy')
      const again = unversioned ? versionsOf(destBucket.id, destKey).find((v) => (v.versionId ?? 'null') === 'null') : null
      resv.commitCheck(src.size, again?.size ?? 0)
      const replace = o.directive === 'REPLACE'
      const fields = {
        size: src.size, etag: etagOf(src), sha256: src.sha256 ?? undefined, partCount: src.partCount ?? undefined,
        contentType: replace && o.contentType ? contentTypeFor(o.contentType, destKey) : src.contentType,
        metadata: replace ? normMetadata(o.metadata) : { ...(src.metadata ?? {}) },
        tags: o.tags !== undefined ? normTags(o.tags) : { ...(src.tags ?? {}) },
        ...(o.acl ? { acl: o.acl } : {}),
        ...(replace ? {} : { cacheControl: src.cacheControl, contentDisposition: src.contentDisposition, contentEncoding: src.contentEncoding, contentLanguage: src.contentLanguage }),
        ...(replace ? { cacheControl: o.cacheControl, contentDisposition: o.contentDisposition, contentEncoding: o.contentEncoding, contentLanguage: o.contentLanguage } : {}),
        ...(chunks.length === 1 ? { blobId: chunks[0].blobId } : { chunks }),
      }
      for (const k of Object.keys(fields)) if (fields[k] === undefined || fields[k] === null) delete fields[k]
      const { rec, freed } = writeVersion(destBucket, destKey, fields)
      adoptChunks(chunks)
      chunks = null
      freeChunks(freed)
      emit('storage.object.created', { userId: user.id, bucket: destBucket.name, key: destKey, versionId: rec.versionId, size: rec.size, etag: rec.etag, copiedFrom: restoring ? 'restore' : `${srcBucket.name}/${srcKey}` })
      return rec
    } catch (e) {
      if (chunks) freeChunks(chunks)
      throw e
    } finally { resv.release() }
  }
  r.post('/api/buckets/:bucket/copy', async ({ user, params, body, req, requestId }) => {
    const dest = ownBucket(user, params.bucket)
    const o = asObject(body)
    const s = asObject(o.source, 'source')
    const srcBucket = s.bucket === undefined ? dest : ownBucket(user, s.bucket)
    const srcKey = normKey(s.key, 'source.key')
    const dstKey = normKey(asObject(o.destination, 'destination').key, 'destination.key')
    const directive = o.metadataDirective ?? 'COPY'
    if (directive !== 'COPY' && directive !== 'REPLACE') throw bad('metadataDirective must be COPY or REPLACE')
    if (o.acl !== undefined && !OBJECT_ACLS.includes(o.acl)) throw bad(`acl must be one of ${OBJECT_ACLS.join(', ')}`)
    const vid = s.versionId === undefined ? null : String(s.versionId)
    if (vid !== null && !/^[A-Za-z0-9._-]{1,64}$/.test(vid)) throw bad('Invalid versionId')
    const src = vid ? versionsOf(srcBucket.id, srcKey).find((v) => (v.versionId ?? 'null') === vid) : liveOf(srcBucket.id, srcKey)
    if (!src || src.deleteMarker) throw new HttpError(404, 'Source object not found')
    if (srcBucket.id === dest.id && srcKey === dstKey && directive === 'COPY' && bset(dest).versioning !== 'enabled') {
      throw bad('Source and destination are identical; use metadataDirective REPLACE to change metadata, or enable versioning')
    }
    meter(user.id, 1)
    const rec = await copyInto(user, srcBucket, srcKey, src, dest, dstKey, {
      directive, contentType: o.contentType, metadata: o.metadata, tags: o.tags, acl: o.acl,
      cacheControl: headerText('cacheControl', o.cacheControl), contentDisposition: headerText('contentDisposition', o.contentDisposition),
      contentEncoding: headerText('contentEncoding', o.contentEncoding), contentLanguage: headerText('contentLanguage', o.contentLanguage),
    })
    audit({ req, requestId }, user.id, 'storage.object.copy', `bucket:${dest.name}/${dstKey}`, { from: `${srcBucket.name}/${srcKey}` })
    return [201, view(rec)]
  }, { meta: { summary: 'Server-side copy ({source:{bucket?,key,versionId?}, destination:{key}, metadataDirective: COPY|REPLACE})' } })

  /* ======================================================================================= routes: multipart uploads */
  const uploadOf = (user, b, id) => {
    const u = typeof id === 'string' ? db.get('st_uploads', id) : null
    if (!u || u.userId !== user.id || u.bucketId !== b.id) throw new HttpError(404, 'Upload not found')
    return u
  }
  const partView = (p) => ({ partNumber: p.partNumber, size: p.size, etag: `"${p.etag}"`, createdAt: p.createdAt })
  const uploadView = (u) => ({ uploadId: u.id, key: u.key, contentType: u.contentType, metadata: u.metadata, createdAt: u.createdAt })

  r.post('/api/buckets/:bucket/uploads', ({ user, params, body, req, requestId }) => {
    const b = ownBucket(user, params.bucket)
    const o = asObject(body)
    const key = normKey(o.key)
    if (o.acl !== undefined && !OBJECT_ACLS.includes(o.acl)) throw bad(`acl must be one of ${OBJECT_ACLS.join(', ')}`)
    if (rows('st_uploads', 'userId', user.id).length >= L.maxOpenUploads) throw new HttpError(409, `Too many open multipart uploads (${L.maxOpenUploads}); complete or abort some`)
    meter(user.id, 1)
    const u = db.insert('st_uploads', {
      userId: user.id, bucketId: b.id, key, seq: nextSeq(), contentType: contentTypeFor(o.contentType, key), metadata: normMetadata(o.metadata), tags: normTags(o.tags),
      ...(o.acl ? { acl: o.acl } : {}), ...(o.cacheControl ? { cacheControl: headerText('cacheControl', o.cacheControl) } : {}),
      ...(o.contentDisposition ? { contentDisposition: headerText('contentDisposition', o.contentDisposition) } : {}),
      ...(o.contentEncoding ? { contentEncoding: headerText('contentEncoding', o.contentEncoding) } : {}), ...(o.contentLanguage ? { contentLanguage: headerText('contentLanguage', o.contentLanguage) } : {}),
    })
    audit({ req, requestId }, user.id, 'storage.upload.create', `bucket:${b.name}/${key}`, { uploadId: u.id })
    return [201, { bucket: b.name, ...uploadView(u), minPartBytes: L.minPartBytes, maxPartBytes: L.maxPartBytes, maxParts: L.maxParts }]
  }, { meta: { summary: 'Start a multipart upload ({key, contentType?, metadata?, tags?, acl?})' } })

  r.get('/api/buckets/:bucket/uploads', ({ user, params, query }) => {
    const b = ownBucket(user, params.bucket)
    const prefix = normPrefix(query.get('prefix') ?? '')
    const max = intQ(query, ['max-uploads', 'limit'], 100, 1, 1000)
    const tokenRaw = query.get('cursor') ?? query.get('continuation-token')
    const token = tokenRaw ? unb64url(tokenRaw, 'cursor') : null
    let list = rows('st_uploads', 'bucketId', b.id).filter((u) => u.key.startsWith(prefix)).sort((x, y) => x.seq - y.seq)
    if (token) list = list.filter((u) => u.seq > Number(token.s))
    const page = list.slice(0, max)
    const next = list.length > max ? b64url({ s: page[page.length - 1].seq }) : null
    return { uploads: page.map((u) => ({ ...uploadView(u), partCount: rows('st_parts', 'uploadId', u.id).length, size: rows('st_parts', 'uploadId', u.id).reduce((s, p) => s + p.size, 0) })), isTruncated: !!next, nextCursor: next }
  }, { meta: { summary: 'List in-progress multipart uploads' } })

  r.put('/api/buckets/:bucket/uploads/:uploadId/parts/:partNumber', (rc) => guardBody(rc, async () => {
    const { user, params, req, res } = rc
    const b = ownBucket(user, params.bucket)
    const u = uploadOf(user, b, params.uploadId)
    if (!/^\d{1,5}$/.test(params.partNumber)) throw bad('partNumber must be an integer')
    const n = Number(params.partNumber)
    if (n < 1 || n > L.maxParts) throw bad(`partNumber must be between 1 and ${L.maxParts}`)
    meter(user.id, 1)
    const declared = declaredLength(req)
    if (declared !== null && declared > L.maxPartBytes) throw new HttpError(413, `Part too large (limit ${L.maxPartBytes} bytes)`)
    const existing = rows('st_parts', 'uploadId', u.id).find((p) => p.partNumber === n)
    const resv = new Reservation(user.id, existing?.size ?? 0)
    let release = null
    let body = null
    try {
      resv.ensure(declared ?? 0)
      release = acquireSlot()
      body = await ingest(req, { maxBytes: L.maxPartBytes, resv, declared })
      verifyChecksums(req, body)
      const live = db.get('st_uploads', u.id)
      if (!live) throw new HttpError(404, 'Upload not found') // completed or aborted while the part was streaming in
      const mine = rows('st_parts', 'uploadId', u.id)
      const old = mine.find((p) => p.partNumber === n)
      if (mine.length - (old ? 1 : 0) + 1 > L.maxParts) throw bad(`At most ${L.maxParts} parts`)
      const total = mine.reduce((s, p) => s + p.size, 0) - (old?.size ?? 0) + body.size
      if (total > L.maxObjectBytes) throw new HttpError(413, `The upload would exceed the object size limit (${L.maxObjectBytes} bytes)`)
      resv.commitCheck(body.size, old?.size ?? 0)
      const part = db.transaction(() => {
        if (old) db.remove('st_parts', old.id)
        return db.insert('st_parts', { userId: user.id, uploadId: u.id, partNumber: n, size: body.size, etag: body.md5.toString('hex'), md5: body.md5.toString('hex'), sha256: body.sha256, chunks: body.chunks })
      })
      adoptChunks(body.chunks)
      if (old) freeChunks(old.chunks)
      body = null
      res.setHeader('etag', `"${part.etag}"`)
      return [200, partView(part)]
    } catch (e) {
      if (body) freeChunks(body.chunks)
      throw e
    } finally { resv.release(); release?.() }
  }), { stream: true, meta: { summary: 'Upload one part (raw body, Content-MD5 / x-rd-checksum-sha256 verified); re-sending a part number replaces it' } })

  r.get('/api/buckets/:bucket/uploads/:uploadId/parts', ({ user, params, query }) => {
    const b = ownBucket(user, params.bucket)
    const u = uploadOf(user, b, params.uploadId)
    const max = intQ(query, ['max-parts', 'limit'], 1000, 1, 1000)
    const marker = intQ(query, ['part-number-marker'], 0, 0, 100_000)
    const list = rows('st_parts', 'uploadId', u.id).filter((p) => p.partNumber > marker).sort((x, y) => x.partNumber - y.partNumber)
    const page = list.slice(0, max)
    return { ...uploadView(u), parts: page.map(partView), isTruncated: list.length > max, nextPartNumberMarker: list.length > max ? page[page.length - 1].partNumber : null }
  }, { meta: { summary: 'List the parts uploaded so far' } })

  r.post('/api/buckets/:bucket/uploads/:uploadId/complete', ({ user, params, body, req, requestId }) => {
    const b = ownBucket(user, params.bucket)
    const u = uploadOf(user, b, params.uploadId)
    const o = asObject(body)
    if (!Array.isArray(o.parts) || !o.parts.length) throw bad('parts must be a non-empty array of { partNumber, etag }')
    if (o.parts.length > L.maxParts) throw bad(`At most ${L.maxParts} parts`)
    const stored = new Map(rows('st_parts', 'uploadId', u.id).map((p) => [p.partNumber, p]))
    const chosen = []
    let prev = 0
    o.parts.forEach((item, i) => {
      const it = asObject(item, 'parts[]')
      if (!Number.isInteger(it.partNumber) || it.partNumber <= prev) throw bad('parts must be listed in ascending partNumber order without duplicates')
      prev = it.partNumber
      const p = stored.get(it.partNumber)
      if (!p) throw bad(`Part ${it.partNumber} has not been uploaded (InvalidPart)`)
      if (typeof it.etag !== 'string' || it.etag.replace(/"/g, '').toLowerCase() !== p.etag) throw bad(`ETag of part ${it.partNumber} does not match (InvalidPart)`)
      if (i < o.parts.length - 1 && p.size < L.minPartBytes) throw bad(`Part ${it.partNumber} is smaller than the ${L.minPartBytes}-byte minimum (EntityTooSmall)`)
      chosen.push(p)
    })
    const size = chosen.reduce((s, p) => s + p.size, 0)
    if (size > L.maxObjectBytes) throw new HttpError(413, `Object too large (limit ${L.maxObjectBytes} bytes)`)
    const chunks = chosen.flatMap((p) => p.chunks)
    if (chunks.length > L.maxChunksPerObject) throw new HttpError(413, 'Object has too many chunks; use larger parts')
    const current = liveOf(b.id, u.key)
    checkWritePreconditions(req, current)
    const unversioned = bset(b).versioning !== 'enabled'
    const replaced = unversioned ? versionsOf(b.id, u.key).find((v) => (v.versionId ?? 'null') === 'null') : null
    checkObjectBudget(user.id, replaced ? 0 : 1)
    const etag = `${crypto.createHash('md5').update(Buffer.concat(chosen.map((p) => Buffer.from(p.md5, 'hex')))).digest('hex')}-${chosen.length}`
    const unused = [...stored.values()].filter((p) => !chosen.includes(p))
    const { rec, freed } = db.transaction(() => {
      const out = writeVersion(b, u.key, {
        size, etag, partCount: chosen.length, contentType: u.contentType, metadata: u.metadata, tags: u.tags,
        ...(u.acl ? { acl: u.acl } : {}), ...(u.cacheControl ? { cacheControl: u.cacheControl } : {}), ...(u.contentDisposition ? { contentDisposition: u.contentDisposition } : {}),
        ...(u.contentEncoding ? { contentEncoding: u.contentEncoding } : {}), ...(u.contentLanguage ? { contentLanguage: u.contentLanguage } : {}),
        ...(chunks.length === 1 ? { blobId: chunks[0].blobId } : { chunks }),
      })
      for (const p of stored.values()) db.remove('st_parts', p.id)
      db.remove('st_uploads', u.id)
      return out
    })
    freeChunks(freed)
    for (const p of unused) freeChunks(p.chunks)
    meter(user.id, 1)
    audit({ req, requestId }, user.id, 'storage.upload.complete', `bucket:${b.name}/${u.key}`, { uploadId: u.id, parts: chosen.length, size })
    emit('storage.object.created', { userId: user.id, bucket: b.name, key: u.key, versionId: rec.versionId, size, etag, multipart: true })
    return [201, view(rec)]
  }, { meta: { summary: 'Complete a multipart upload ({parts:[{partNumber, etag}]}); the object is a manifest of the part chunks, no data is copied' } })

  r.delete('/api/buckets/:bucket/uploads/:uploadId', ({ user, params }) => {
    const b = ownBucket(user, params.bucket)
    const u = uploadOf(user, b, params.uploadId)
    meter(user.id, 1)
    dropUpload(u)
    return { ok: true }
  }, { meta: { summary: 'Abort a multipart upload and free its parts' } })

  /* ======================================================================================= routes: presign */
  r.post('/api/buckets/:bucket/presign', ({ user, params, body, req, requestId }) => {
    const b = ownBucket(user, params.bucket)
    const o = asObject(body)
    const key = normKey(o.key)
    const method = String(o.method ?? 'GET').toUpperCase()
    if (!['GET', 'PUT', 'DELETE'].includes(method)) throw bad('method must be GET, PUT or DELETE')
    const expiresIn = o.expiresIn === undefined ? 3600 : o.expiresIn
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > L.presignMaxSeconds) throw bad(`expiresIn must be an integer between 1 and ${L.presignMaxSeconds} seconds`)
    const versionId = o.versionId === undefined || o.versionId === null ? '' : String(o.versionId)
    if (versionId && (method !== 'GET' || !/^[A-Za-z0-9._-]{1,64}$/.test(versionId))) throw bad('versionId is only valid for GET and must be a version id')
    const contentType = o.contentType === undefined || o.contentType === null ? '' : contentTypeFor(o.contentType, key)
    if (contentType && method !== 'PUT') throw bad('contentType is only valid for PUT')
    const disposition = o.disposition === undefined || o.disposition === null ? '' : String(o.disposition)
    if (disposition && (method !== 'GET' || !['attachment', 'inline'].includes(disposition))) throw bad('disposition is only valid for GET: attachment or inline')
    const expires = Math.floor(Date.now() / 1000) + expiresIn
    const sig = signPresign(b, { method, key, expires, versionId, contentType, disposition })
    const qs = new URLSearchParams({ expires: String(expires), signature: sig })
    if (versionId) qs.set('versionId', versionId)
    if (contentType) qs.set('contentType', contentType)
    if (disposition) qs.set('disposition', disposition)
    meter(user.id, 1)
    audit({ req, requestId }, user.id, 'storage.presign', `bucket:${b.name}/${key}`, { method, expiresIn, versionId: versionId || undefined })
    const path = `/presigned/${b.name}/${encodeKeyPath(key)}?${qs}`
    return [201, { method, key, expiresAt: new Date(expires * 1000).toISOString(), expiresIn, url: `${(process.env.RD_PUBLIC_URL ?? '').replace(/\/+$/, '')}${path}`, path }]
  }, { meta: { summary: 'Create a presigned URL (HMAC-SHA256 over method, bucket, key, expiry); anyone holding the URL can perform that one method until it expires' } })

  r.post('/api/buckets/:bucket/presign/revoke', ({ user, params, req, requestId }) => {
    const b = ownBucket(user, params.bucket)
    db.update('buckets', b.id, { presignEpoch: (b.presignEpoch ?? 0) + 1 })
    audit({ req, requestId }, user.id, 'storage.presign.revoke', `bucket:${b.name}`, {})
    return { ok: true }
  }, { meta: { summary: 'Invalidate every presigned URL issued for this bucket so far' } })

  /** Public: verifies a presigned URL and performs the signed method as the bucket owner. */
  const presigned = async (rc) => {
    const { req, res, params, query } = rc
    const forbidden = () => new HttpError(403, 'Invalid or expired signature')
    let key
    try { key = normKey(params.key) } catch { throw forbidden() }
    const b = bucketByName(params.bucket)
    const given = query.get('signature') ?? ''
    const expiresRaw = query.get('expires') ?? ''
    if (!b || !/^[0-9a-f]{64}$/.test(given) || !/^\d{1,12}$/.test(expiresRaw)) throw forbidden()
    const method = req.method === 'HEAD' ? 'GET' : req.method
    const versionId = query.get('versionId') ?? ''
    const contentType = query.get('contentType') ?? ''
    const disposition = query.get('disposition') ?? ''
    const expires = Number(expiresRaw)
    const want = Buffer.from(signPresign(b, { method, key, expires, versionId, contentType, disposition }), 'hex')
    if (!crypto.timingSafeEqual(want, Buffer.from(given, 'hex'))) throw forbidden()
    const nowS = Math.floor(Date.now() / 1000)
    if (expires < nowS) throw new HttpError(403, 'Invalid or expired signature')
    if (expires - nowS > L.presignMaxSeconds + 60) throw forbidden()
    if (method === 'GET') {
      let o
      if (versionId) o = versionsOf(b.id, key).find((v) => (v.versionId ?? 'null') === versionId)
      else o = liveOf(b.id, key)
      if (!o || o.deleteMarker) throw new HttpError(404, 'Object not found')
      return serveObject(rc, b, o, { mode: 'presigned', disposition: disposition || null })
    }
    if (method === 'PUT') {
      if (contentType && String(hdr(req, 'content-type') ?? '').trim().toLowerCase() !== contentType.toLowerCase()) throw new HttpError(403, 'Content-Type does not match the signed value')
      meter(b.userId, 1)
      const rec = await putObject(rc, b, key, { trusted: false })
      audit(rc, b.userId, 'storage.presigned.put', `bucket:${b.name}/${key}`, { size: rec.size, versionId: rec.versionId })
      res.setHeader('etag', `"${rec.etag}"`)
      return [200, { key, size: rec.size, etag: `"${rec.etag}"`, versionId: rec.versionId }]
    }
    // DELETE
    meter(b.userId, 1)
    if (!liveOf(b.id, key)) throw new HttpError(404, 'Object not found')
    const out = deleteCurrent(b, key)
    audit(rc, b.userId, 'storage.presigned.delete', `bucket:${b.name}/${key}`, out)
    return { ok: true, key, ...out }
  }
  for (const m of ['GET', 'HEAD', 'PUT', 'DELETE']) r.add(m, '/presigned/:bucket/*key', presigned, { public: true, stream: true, meta: { summary: 'Presigned object access (see POST /api/buckets/:bucket/presign)' } })
  r.add('OPTIONS', '/presigned/:bucket/*key', (rc) => preflight(bucketByName(rc.params.bucket), rc), { public: true, stream: true })

  /* ======================================================================================= routes: public-read + website */
  const notFoundText = (res, status = 404) => { const body = 'Not found\n'; res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length, 'x-content-type-options': 'nosniff', 'content-security-policy': INERT_CSP }); res.end(body); return HANDLED }

  r.add('GET', '/pub/:bucket/*key', async (rc) => {
    let key
    try { key = normKey(rc.params.key) } catch { throw new HttpError(404, 'Not found') }
    const b = bucketByName(rc.params.bucket)
    const o = b ? liveOf(b.id, key) : null
    if (!o || !isPublic(b, o)) throw new HttpError(404, 'Not found') // private and missing look the same
    return serveObject(rc, b, o, { mode: 'pub' })
  }, { public: true, stream: true, meta: { summary: 'Public download of a public-read object (no authentication)' } })
  r.add('HEAD', '/pub/:bucket/*key', async (rc) => {
    let key
    try { key = normKey(rc.params.key) } catch { throw new HttpError(404, 'Not found') }
    const b = bucketByName(rc.params.bucket)
    const o = b ? liveOf(b.id, key) : null
    if (!o || !isPublic(b, o)) throw new HttpError(404, 'Not found')
    return serveObject(rc, b, o, { mode: 'pub' })
  }, { public: true, stream: true })
  r.add('OPTIONS', '/pub/:bucket/*key', (rc) => preflight(bucketByName(rc.params.bucket), rc), { public: true, stream: true })

  const site = async (rc) => {
    const { res, params } = rc
    const b = bucketByName(params.bucket)
    const web = b ? bset(b).website : null
    if (!web) return notFoundText(res)
    const index = web.indexDocument
    let key = params.key ?? ''
    try {
      if (key === '' || key.endsWith('/')) key += index
      key = normKey(key)
    } catch { return notFoundText(res) }
    const o = liveOf(b.id, key)
    if (o && isPublic(b, o)) return serveObject(rc, b, o, { mode: 'site' })
    // "docs" -> "docs/" when docs/<index> exists: relative links inside that page need the trailing slash
    if (!o && !key.endsWith(`/${index}`) && key !== index) {
      const dir = liveOf(b.id, `${key}/${index}`)
      if (dir && isPublic(b, dir)) {
        res.writeHead(302, { location: `/site/${encodeURIComponent(b.name)}/${encodeKeyPath(key)}/`, 'content-length': 0 })
        res.end()
        return HANDLED
      }
    }
    if (web.errorDocument) {
      const err = liveOf(b.id, web.errorDocument)
      if (err && isPublic(b, err)) return serveObject(rc, b, err, { mode: 'site', status: 404 })
    }
    return notFoundText(res)
  }
  for (const m of ['GET', 'HEAD']) {
    r.add(m, '/site/:bucket', site, { public: true, stream: true, meta: { summary: 'Static website hosting: index document of a website-enabled bucket' } })
    r.add(m, '/site/:bucket/*key', site, { public: true, stream: true, meta: { summary: 'Static website hosting: serves public objects of a website-enabled bucket' } })
  }
  r.add('OPTIONS', '/site/:bucket/*key', (rc) => preflight(bucketByName(rc.params.bucket), rc), { public: true, stream: true })

  /* ======================================================================================= account deletion: rows + blobs are removed by security.js; nothing else to do here */
}
