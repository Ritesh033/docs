// Drive: versioned files, folders, trash, search, link + people sharing, chunked uploads, zip download, quotas.
// Compatible with the original API (PUT /api/drive/files?name=, versions, /api/drive/files/:id/share, public /s/:token).
// See docs/drive.md.
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { once } from 'node:events'
import { HttpError, readBody, readJson, HANDLED } from './http.js'

const GiB = 1024 ** 3
const envInt = (name, dflt, min, max) => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : dflt
}
const L = {
  quota: () => envInt('RD_DRIVE_QUOTA_BYTES', 5 * GiB, 1024, 2 ** 50),
  maxVersions: () => envInt('RD_DRIVE_MAX_VERSIONS', 50, 1, 1000),
  trashDays: () => envInt('RD_DRIVE_TRASH_DAYS', 30, 0, 3650),
  maxFolderDepth: 20,
  maxFiles: 100_000,
  maxZipEntries: 5000,
  maxZipBytes: 4 * GiB - 1,
  partMax: 16 * 1024 * 1024,
  maxParts: 10_000,
  maxUploadSize: 50 * GiB,
  uploadTtlMs: 24 * 3600_000,
  textExtractMax: 1024 * 1024,
  tokensPerFile: 2000,
  maxShares: 50,
  maxAcl: 50,
}
const INLINE_OK = /^(image\/(png|jpeg|gif|webp|avif|bmp)|application\/pdf|audio\/(mpeg|ogg|wav|mp4|webm)|video\/(mp4|webm|ogg)|text\/plain)$/
const TEXTY_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'html', 'htm', 'xml', 'log', 'yaml', 'yml', 'js', 'mjs', 'ts', 'py', 'css', 'sh', 'sql', 'ini', 'toml', 'rs', 'go', 'java', 'c', 'h', 'cpp'])
const iso = (t = Date.now()) => new Date(t).toISOString()
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

export function validName(raw) {
  if (typeof raw !== 'string') throw new HttpError(400, 'name must be a string')
  const name = raw.normalize('NFC').trim()
  if (!name || name.length > 255) throw new HttpError(400, 'name must be 1-255 characters')
  if (/[/\\\u0000-\u001f\u007f]/.test(name) || name === '.' || name === '..') throw new HttpError(400, 'name must not contain slashes or control characters')
  return name
}
function cleanType(t) {
  const v = String(t ?? '').split(';')[0].trim().toLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(v) ? v : 'application/octet-stream'
}
function tokenize(text, limit = L.tokensPerFile) {
  const out = new Set()
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]{2,40}/gu)) {
    out.add(m[0])
    if (out.size >= limit) break
  }
  return [...out]
}
function extractText(buf, type, name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  if (buf.length === 0 || buf.length > L.textExtractMax) return ''
  if (!(type.startsWith('text/') || /json|xml|csv|javascript|markdown|yaml/.test(type) || TEXTY_EXT.has(ext))) return ''
  let s = buf.toString('utf8')
  if (/html/.test(type) || ext === 'html' || ext === 'htm') s = s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  return s
}
const rfc5987 = (name) => `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\;]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`
const inlineDisp = (name) => rfc5987(name).replace(/^attachment/, 'inline')

export function driveRoutes(r, db, ctx) {
  const by = (col, field, value) => (typeof db.findBy === 'function' ? db.findBy(col, field, value) : db.find(col, (x) => x[field] === value))
  const audit = (userId, action, resource, meta, req) => { try { ctx?.events?.emit('audit', { userId, action, resource, meta, req }) } catch { /* never fail a request over auditing */ } }
  const notify = (userId, n) => { try { ctx?.events?.emit('notification', { userId, source: 'drive', ...n }) } catch { /* ignore */ } }

  /* ------------------------------------------------------------------ records */
  const filesOf = (userId) => by('files', 'userId', userId)
  const foldersOf = (userId) => by('drive_folders', 'userId', userId)
  const versionsOf = (f) => {
    // lazy migration of pre-folder records: stable version numbers
    f.versions.forEach((v, i) => { if (v.n === undefined) v.n = i + 1 })
    return f.versions
  }
  const chunksOf = (v) => v.chunks ?? [{ blobId: v.blobId, size: v.size }]
  const latest = (f) => versionsOf(f).at(-1)
  const sizeOf = (f) => f.versions.reduce((s, v) => s + (v.size ?? 0), 0)

  function usedBytes(userId) {
    let n = filesOf(userId).reduce((s, f) => s + sizeOf(f), 0)
    for (const u of by('drive_uploads', 'userId', userId)) n += Object.values(u.parts ?? {}).reduce((s, p) => s + p.size, 0)
    return n
  }
  function checkQuota(userId, incoming) {
    if (usedBytes(userId) + incoming > L.quota()) throw new HttpError(413, `Drive quota exceeded (${Math.round(L.quota() / 1024 ** 2)} MB). Delete files or empty the trash.`)
    const q = ctx?.quotas?.check?.(userId, 'storage.bytes', incoming)
    if (q && q.allowed === false) throw new HttpError(413, q.message ?? 'Storage limit of your plan reached')
  }

  /* ------------------------------------------------------------------ access */
  function aclFor(file) { return by('drive_acl', 'fileId', file.id) }
  /** owner | editor | viewer | null for this user on this file (folder ACLs are inherited from ancestors). */
  function roleFor(userId, file) {
    if (file.userId === userId) return 'owner'
    let best = null
    const rank = { viewer: 1, editor: 2 }
    const consider = (e) => {
      if (e.principalType === 'user' && e.principalId === userId) { if ((rank[e.role] ?? 0) > (rank[best] ?? 0)) best = e.role }
      else if (e.principalType === 'org' && ctx?.access?.orgRole?.(userId, e.principalId)) { if ((rank[e.role] ?? 0) > (rank[best] ?? 0)) best = e.role }
    }
    for (const e of aclFor(file)) consider(e)
    let fid = file.folderId, depth = 0
    while (fid && depth++ < L.maxFolderDepth + 1) {
      const folder = db.get('drive_folders', fid)
      if (!folder) break
      for (const e of by('drive_acl', 'folderId', folder.id)) consider(e)
      fid = folder.parentId
    }
    return best
  }
  const need = { read: ['owner', 'editor', 'viewer'], write: ['owner', 'editor'], owner: ['owner'] }
  function getFile(user, id, perm = 'read', { allowTrashed = false } = {}) {
    const f = typeof id === 'string' ? db.get('files', id) : null
    const role = f && roleFor(user.id, f)
    if (!f || !role || (f.trashedAt && !allowTrashed)) throw new HttpError(404, 'File not found')
    if (!need[perm].includes(role)) throw new HttpError(403, `You need ${perm === 'owner' ? 'owner' : 'editor'} access`)
    return { f, role }
  }
  function getFolder(user, id, { allowTrashed = false } = {}) {
    const d = typeof id === 'string' ? db.get('drive_folders', id) : null
    if (!d || d.userId !== user.id || (d.trashedAt && !allowTrashed)) throw new HttpError(404, 'Folder not found')
    return d
  }
  function resolveFolder(user, id) {
    if (id === undefined || id === null || id === '' || id === 'root') return null
    return getFolder(user, id).id
  }
  const activity = (f, actor, action, meta) => {
    db.insert('drive_activity', { fileId: f.id, ownerId: f.userId, actorId: actor, action, meta: meta ?? null, ts: Date.now() })
    const rows = by('drive_activity', 'fileId', f.id)
    if (rows.length > 200) for (const old of rows.sort((a, b) => a.ts - b.ts).slice(0, rows.length - 200)) db.remove('drive_activity', old.id)
  }

  /* ------------------------------------------------------------------ views */
  const view = (f, role = 'owner') => {
    const v = latest(f)
    return {
      id: f.id, name: f.name, contentType: f.contentType, versionCount: f.versions.length, size: v?.size ?? 0, updatedAt: f.updatedAt ?? f.createdAt,
      folderId: f.folderId ?? null, starred: !!f.starred, tags: f.tags ?? [], trashed: !!f.trashedAt, role, sha256: v?.sha256 ?? null,
    }
  }
  const folderView = (d, counts) => ({ id: d.id, name: d.name, parentId: d.parentId ?? null, trashed: !!d.trashedAt, createdAt: d.createdAt, ...(counts ?? {}) })

  /* ------------------------------------------------------------------ search index (token -> fileIds, per user, built lazily) */
  const indexes = new Map()
  function indexOf(userId) {
    let ix = indexes.get(userId)
    if (ix) return ix
    ix = { tokens: new Map(), byFile: new Map() }
    for (const f of filesOf(userId)) addToIndex(ix, f)
    indexes.set(userId, ix)
    if (indexes.size > 500) indexes.delete(indexes.keys().next().value)
    return ix
  }
  function addToIndex(ix, f) {
    const toks = new Set([...(f.nameTokens ?? tokenize(f.name, 50)), ...(f.textTokens ?? [])])
    ix.byFile.set(f.id, toks)
    for (const t of toks) {
      let s = ix.tokens.get(t)
      if (!s) ix.tokens.set(t, (s = new Set()))
      s.add(f.id)
    }
  }
  function reindex(f) {
    const ix = indexes.get(f.userId)
    if (!ix) return
    for (const t of ix.byFile.get(f.id) ?? []) ix.tokens.get(t)?.delete(f.id)
    ix.byFile.delete(f.id)
    if (db.get('files', f.id)) addToIndex(ix, db.get('files', f.id))
  }

  /* ------------------------------------------------------------------ blob helpers */
  function readBlob(blobId) {
    let buf
    try { buf = db.getBlob(blobId) } catch (e) {
      console.error('[drive] blob read failed:', e.code ?? e.message)
      throw new HttpError(500, 'Stored data failed an integrity check')
    }
    if (!buf) throw new HttpError(410, 'The stored data for this file is missing')
    return buf
  }
  function dropVersionBlobs(v) { for (const c of chunksOf(v)) { try { db.deleteBlob(c.blobId) } catch { /* already gone */ } } }
  function newVersion(file, ver) {
    const n = (file.nextVersion ?? versionsOf(file).length + 1)
    const versions = [...versionsOf(file), { n, ...ver, at: iso() }]
    const keep = L.maxVersions()
    const pruned = []
    while (versions.length > keep) {
      const i = versions.findIndex((x, idx) => idx < versions.length - 1 && !x.label)
      if (i < 0) break
      pruned.push(...versions.splice(i, 1))
    }
    for (const p of pruned) dropVersionBlobs(p)
    return { versions, nextVersion: n + 1 }
  }

  function createOrVersion(user, { name, folderId, buf, type, chunks, size, digest }) {
    const nm = validName(name)
    const ct = cleanType(type)
    const existing = filesOf(user.id).find((f) => (f.folderId ?? null) === folderId && f.name === nm && !f.trashedAt)
    const text = buf ? extractText(buf, ct, nm) : ''
    const ver = chunks ? { chunks, size, sha256: digest } : (() => {
      const blobId = db.id('blob'); db.putBlob(blobId, buf)
      return { blobId, size: buf.length, sha256: digest ?? sha256(buf) }
    })()
    if (existing) {
      if (latest(existing).sha256 === ver.sha256 && latest(existing).size === ver.size) { dropVersionBlobs(ver); return { file: existing, status: 200, unchanged: true } }
      const upd = db.update('files', existing.id, { ...newVersion(existing, ver), contentType: ct, textTokens: text ? tokenize(text) : [] })
      reindex(upd)
      activity(upd, user.id, 'version', { n: latest(upd).n })
      return { file: upd, status: 200 }
    }
    if (filesOf(user.id).length >= L.maxFiles) { dropVersionBlobs(ver); throw new HttpError(409, 'File count limit reached') }
    const f = db.insert('files', {
      userId: user.id, name: nm, contentType: ct, folderId, starred: false, tags: [], nextVersion: 2, nameTokens: tokenize(nm, 50), textTokens: text ? tokenize(text) : [],
      versions: [{ n: 1, ...ver, at: iso() }],
    })
    reindex(f)
    activity(f, user.id, 'create', null)
    return { file: f, status: 201 }
  }

  /* ------------------------------------------------------------------ streaming download */
  async function sendVersion(req, res, file, v, { inline = false, name = file.name, type = file.contentType, extra = {} } = {}) {
    const total = v.size
    const etag = `"${v.sha256 ?? v.blobId ?? v.chunks?.[0]?.blobId}"`
    const okInline = inline && INLINE_OK.test(type)
    const outType = okInline && type === 'text/plain' ? 'text/plain; charset=utf-8' : okInline ? type : 'application/octet-stream'
    const headers = {
      'content-type': outType, etag, 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-cache',
      'content-disposition': okInline ? inlineDisp(name) : rfc5987(name), 'cross-origin-resource-policy': 'same-origin',
      'content-security-policy': okInline && type === 'application/pdf' ? "default-src 'none'" : "default-src 'none'; style-src 'unsafe-inline'; sandbox", ...extra,
    }
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); res.end(); return HANDLED }
    let start = 0, end = total - 1, status = 200
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
    if (range && (range[1] || range[2]) && total > 0) {
      if (range[1] === '') { start = Math.max(0, total - Number(range[2])) }
      else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])) }
      if (!(start <= end) || start >= total) { res.writeHead(416, { 'content-range': `bytes */${total}` }); res.end(); return HANDLED }
      status = 206
      headers['content-range'] = `bytes ${start}-${end}/${total}`
    }
    // verify the data is readable before committing to a status line
    const chunks = chunksOf(v)
    for (const c of chunks) if (!db.hasBlob?.(c.blobId) && db.getBlob(c.blobId) === null) throw new HttpError(410, 'The stored data for this file is missing')
    headers['content-length'] = Math.max(0, end - start + 1)
    res.writeHead(status, headers)
    if (req.method === 'HEAD' || total === 0) { res.end(); return HANDLED }
    let offset = 0
    try {
      for (const c of chunks) {
        const cs = offset, ce = offset + c.size - 1
        offset += c.size
        if (ce < start) continue
        if (cs > end) break
        const buf = readBlob(c.blobId)
        const slice = start > cs || end < ce ? buf.subarray(Math.max(0, start - cs), Math.min(buf.length, end - cs + 1)) : buf
        if (res.destroyed) return HANDLED
        if (!res.write(slice)) await once(res, 'drain')
      }
    } catch { res.destroy(); return HANDLED }
    res.end()
    return HANDLED
  }

  /* ------------------------------------------------------------------ listing & browsing */
  const sortFiles = (arr, sort) => {
    const key = { name: (f) => f.name.toLowerCase(), size: (f) => latest(f)?.size ?? 0, updated: (f) => Date.parse(f.updatedAt ?? f.createdAt) }[sort] ?? ((f) => f.name.toLowerCase())
    return arr.sort((a, b) => (key(a) > key(b) ? (sort === 'name' || !sort ? 1 : -1) : key(a) < key(b) ? (sort === 'name' || !sort ? -1 : 1) : 0))
  }
  r.get('/api/drive/files', ({ user, query }) => {
    const folder = query.get('folder')
    let list = filesOf(user.id).filter((f) => !f.trashedAt)
    if (folder === 'root') list = list.filter((f) => !f.folderId)
    else if (folder) list = list.filter((f) => f.folderId === folder)
    if (query.get('starred') === '1') list = list.filter((f) => f.starred)
    if (query.get('tag')) list = list.filter((f) => (f.tags ?? []).includes(query.get('tag')))
    return { files: sortFiles(list, query.get('sort')).map((f) => view(f)) }
  })

  r.get('/api/drive/browse', ({ user, query }) => {
    const id = query.get('folder')
    const current = id && id !== 'root' ? getFolder(user, id) : null
    const parent = current?.id ?? null
    const crumbs = []
    for (let d = current, i = 0; d && i < L.maxFolderDepth + 2; d = d.parentId ? db.get('drive_folders', d.parentId) : null, i++) crumbs.unshift({ id: d.id, name: d.name })
    const folders = foldersOf(user.id).filter((d) => !d.trashedAt && (d.parentId ?? null) === parent)
    const files = filesOf(user.id).filter((f) => !f.trashedAt && (f.folderId ?? null) === parent)
    return { folder: current ? folderView(current) : null, breadcrumbs: crumbs, folders: folders.sort((a, b) => a.name.localeCompare(b.name)).map((d) => folderView(d)), files: sortFiles(files, query.get('sort')).map((f) => view(f)) }
  })

  r.get('/api/drive/usage', ({ user }) => {
    const all = filesOf(user.id)
    const trash = all.filter((f) => f.trashedAt).reduce((s, f) => s + sizeOf(f), 0)
    return { used: usedBytes(user.id), quota: L.quota(), files: all.filter((f) => !f.trashedAt).length, trashBytes: trash, maxVersions: L.maxVersions(), trashRetentionDays: L.trashDays() }
  })

  /* ------------------------------------------------------------------ upload */
  r.put('/api/drive/files', ({ user, query, raw, req }) => {
    const name = query.get('name')
    if (!name) throw new HttpError(400, 'Missing ?name=')
    const folderId = resolveFolder(user, query.get('folder'))
    checkQuota(user.id, raw.length)
    const out = createOrVersion(user, { name, folderId, buf: raw, type: req.headers['content-type'] })
    audit(user.id, 'drive.file.upload', out.file.id, { size: raw.length, unchanged: !!out.unchanged }, req)
    return [out.status, { ...view(out.file), unchanged: out.unchanged ?? undefined }]
  }, { raw: true })

  // Replace content of an existing file (owner or editor)
  r.put('/api/drive/files/:id/content', ({ user, params, raw, req }) => {
    const { f, role } = getFile(user, params.id, 'write')
    const owner = db.get('users', f.userId)
    checkQuota(f.userId, raw.length)
    const out = createOrVersion({ id: f.userId, email: owner?.email }, { name: f.name, folderId: f.folderId ?? null, buf: raw, type: req.headers['content-type'] || f.contentType })
    if (role !== 'owner') activity(out.file, user.id, 'edit', null)
    return view(out.file, role)
  }, { raw: true })

  // Resumable chunked uploads for large files
  r.post('/api/drive/uploads', ({ user, body }) => {
    const name = validName(body.name)
    const size = body.size
    if (!Number.isInteger(size) || size < 0 || size > L.maxUploadSize) throw new HttpError(400, 'size must be an integer number of bytes')
    const folderId = resolveFolder(user, body.folderId)
    if (by('drive_uploads', 'userId', user.id).length >= 20) throw new HttpError(429, 'Too many unfinished uploads')
    checkQuota(user.id, size)
    const u = db.insert('drive_uploads', { userId: user.id, name, folderId, size, contentType: cleanType(body.contentType), parts: {}, expiresAt: Date.now() + L.uploadTtlMs })
    return [201, { uploadId: u.id, partSizeMax: L.partMax, expiresAt: iso(u.expiresAt) }]
  })
  const getUpload = (user, id) => {
    const u = typeof id === 'string' ? db.get('drive_uploads', id) : null
    if (!u || u.userId !== user.id) throw new HttpError(404, 'Upload not found')
    return u
  }
  r.put('/api/drive/uploads/:id/parts/:n', ({ user, params, raw }) => {
    const u = getUpload(user, params.id)
    const n = Number(params.n)
    if (!Number.isInteger(n) || n < 1 || n > L.maxParts) throw new HttpError(400, `Part number must be 1-${L.maxParts}`)
    if (raw.length === 0 || raw.length > L.partMax) throw new HttpError(400, `Parts must be 1 byte to ${L.partMax} bytes`)
    const sofar = Object.entries(u.parts).filter(([k]) => Number(k) !== n).reduce((s, [, p]) => s + p.size, 0)
    if (sofar + raw.length > u.size) throw new HttpError(400, 'Parts exceed the declared size')
    const prev = u.parts[n]
    const blobId = db.id('blob')
    db.putBlob(blobId, raw)
    db.update('drive_uploads', u.id, { parts: { ...u.parts, [n]: { blobId, size: raw.length, sha256: sha256(raw) } }, expiresAt: Date.now() + L.uploadTtlMs })
    if (prev) try { db.deleteBlob(prev.blobId) } catch { /* ok */ }
    return { part: n, size: raw.length, received: sofar + raw.length }
  }, { raw: true })
  r.get('/api/drive/uploads/:id', ({ user, params }) => {
    const u = getUpload(user, params.id)
    return { uploadId: u.id, name: u.name, size: u.size, parts: Object.entries(u.parts).map(([n, p]) => ({ part: Number(n), size: p.size })).sort((a, b) => a.part - b.part), expiresAt: iso(u.expiresAt) }
  })
  r.post('/api/drive/uploads/:id/complete', ({ user, params, req }) => {
    const u = getUpload(user, params.id)
    const nums = Object.keys(u.parts).map(Number).sort((a, b) => a - b)
    if (!nums.length && u.size > 0) throw new HttpError(400, 'No parts uploaded')
    nums.forEach((n, i) => { if (n !== i + 1) throw new HttpError(400, `Part ${i + 1} is missing`) })
    const total = nums.reduce((s, n) => s + u.parts[n].size, 0)
    if (total !== u.size) throw new HttpError(400, `Uploaded ${total} bytes but ${u.size} were declared`)
    const h = crypto.createHash('sha256')
    for (const n of nums) h.update(readBlob(u.parts[n].blobId))
    const digest = h.digest('hex')
    const chunks = nums.map((n) => ({ blobId: u.parts[n].blobId, size: u.parts[n].size }))
    db.remove('drive_uploads', u.id) // parts now belong to the version
    let out
    try { out = createOrVersion(user, { name: u.name, folderId: u.folderId, type: u.contentType, chunks, size: total, digest }) } catch (e) { for (const c of chunks) try { db.deleteBlob(c.blobId) } catch { /* ok */ } throw e }
    audit(user.id, 'drive.file.upload', out.file.id, { size: total, chunked: true }, req)
    return [out.status, view(out.file)]
  })
  r.delete('/api/drive/uploads/:id', ({ user, params }) => {
    const u = getUpload(user, params.id)
    for (const p of Object.values(u.parts)) try { db.deleteBlob(p.blobId) } catch { /* ok */ }
    db.remove('drive_uploads', u.id)
    return { ok: true }
  })

  /* ------------------------------------------------------------------ file operations */
  r.get('/api/drive/files/:id', async ({ user, params, query, req, res }) => {
    const { f } = getFile(user, params.id)
    const n = query.get('version') ? Number(query.get('version')) : null
    const v = n ? versionsOf(f).find((x) => x.n === n) : latest(f)
    if (!v) throw new HttpError(404, 'Version not found')
    return sendVersion(req, res, f, v, { inline: query.get('inline') === '1' })
  }, { stream: true })

  r.get('/api/drive/files/:id/meta', ({ user, params }) => { const { f, role } = getFile(user, params.id); return view(f, role) })
  r.get('/api/drive/files/:id/versions', ({ user, params }) => {
    const { f } = getFile(user, params.id)
    return { versions: versionsOf(f).map((v) => ({ version: v.n, size: v.size, at: v.at, label: v.label ?? null, sha256: v.sha256 ?? null })) }
  })
  r.patch('/api/drive/files/:id/versions/:n', ({ user, params, body }) => {
    const { f } = getFile(user, params.id, 'owner')
    const v = versionsOf(f).find((x) => x.n === Number(params.n))
    if (!v) throw new HttpError(404, 'Version not found')
    if (body.label !== null && (typeof body.label !== 'string' || body.label.length > 120)) throw new HttpError(400, 'label must be a string of at most 120 characters or null')
    db.update('files', f.id, { versions: f.versions.map((x) => (x.n === v.n ? { ...x, label: body.label || undefined } : x)) })
    return { version: v.n, label: body.label || null }
  })
  r.post('/api/drive/files/:id/versions/:n/restore', ({ user, params }) => {
    const { f } = getFile(user, params.id, 'owner')
    const v = versionsOf(f).find((x) => x.n === Number(params.n))
    if (!v) throw new HttpError(404, 'Version not found')
    checkQuota(user.id, v.size)
    // copy the bytes so deleting/pruning either version never affects the other
    const chunks = chunksOf(v).map((c) => { const blobId = db.id('blob'); db.putBlob(blobId, readBlob(c.blobId)); return { blobId, size: c.size } })
    const upd = db.update('files', f.id, newVersion(f, { chunks, size: v.size, sha256: v.sha256, label: `Restored from v${v.n}` }))
    activity(upd, user.id, 'restore', { from: v.n })
    return view(upd)
  })
  r.patch('/api/drive/files/:id', ({ user, params, body }) => {
    const { f } = getFile(user, params.id, 'owner')
    const patch = {}
    if (body.name !== undefined) patch.name = validName(body.name)
    if (body.folderId !== undefined) patch.folderId = resolveFolder(user, body.folderId)
    if (body.starred !== undefined) patch.starred = body.starred === true
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags) || body.tags.length > 20 || body.tags.some((t) => typeof t !== 'string' || !t.trim() || t.length > 40)) throw new HttpError(400, 'tags must be up to 20 strings of at most 40 characters')
      patch.tags = [...new Set(body.tags.map((t) => t.trim()))]
    }
    const name = patch.name ?? f.name, folderId = 'folderId' in patch ? patch.folderId : f.folderId ?? null
    if ((patch.name !== undefined || 'folderId' in patch) && filesOf(user.id).some((x) => x.id !== f.id && !x.trashedAt && (x.folderId ?? null) === folderId && x.name === name)) throw new HttpError(409, 'A file with that name already exists in the folder')
    if (patch.name !== undefined) patch.nameTokens = tokenize(patch.name, 50)
    const upd = db.update('files', f.id, patch)
    reindex(upd)
    if (patch.name !== undefined || 'folderId' in patch) activity(upd, user.id, 'move', { name, folderId })
    return view(upd)
  })
  r.post('/api/drive/files/:id/copy', ({ user, params, body }) => {
    const { f } = getFile(user, params.id, 'read')
    const v = latest(f)
    checkQuota(user.id, v.size)
    const folderId = body.folderId === undefined ? f.folderId ?? null : resolveFolder(user, body.folderId)
    let name = body.name !== undefined ? validName(body.name) : `Copy of ${f.name}`.slice(0, 255)
    const taken = new Set(filesOf(user.id).filter((x) => !x.trashedAt && (x.folderId ?? null) === folderId).map((x) => x.name))
    for (let i = 2; taken.has(name); i++) name = `${(body.name !== undefined ? validName(body.name) : `Copy of ${f.name}`).slice(0, 240)} (${i})`
    const chunks = chunksOf(v).map((c) => { const blobId = db.id('blob'); db.putBlob(blobId, readBlob(c.blobId)); return { blobId, size: c.size } })
    const out = createOrVersion(user, { name, folderId, type: f.contentType, chunks, size: v.size, digest: v.sha256 })
    return [201, view(out.file)]
  })

  /* ------------------------------------------------------------------ trash */
  r.delete('/api/drive/files/:id', ({ user, params, query, req }) => {
    const { f } = getFile(user, params.id, 'owner', { allowTrashed: true })
    if (query.get('permanent') === '1') { purgeFile(f); audit(user.id, 'drive.file.purge', f.id, { name: f.name }, req); return { ok: true, purged: true } }
    if (f.trashedAt) return { ok: true, trashed: true }
    db.update('files', f.id, { trashedAt: Date.now() })
    reindex(db.get('files', f.id))
    activity(f, user.id, 'trash', null)
    audit(user.id, 'drive.file.trash', f.id, { name: f.name }, req)
    return { ok: true, trashed: true }
  })
  function purgeFile(f) {
    for (const v of f.versions) dropVersionBlobs(v)
    db.removeWhere('shares', (s) => s.fileId === f.id)
    db.removeWhere('drive_acl', (a) => a.fileId === f.id)
    db.removeWhere('drive_activity', (a) => a.fileId === f.id)
    db.remove('files', f.id)
    const ix = indexes.get(f.userId)
    if (ix) { for (const t of ix.byFile.get(f.id) ?? []) ix.tokens.get(t)?.delete(f.id); ix.byFile.delete(f.id) }
  }
  r.post('/api/drive/files/:id/restore', ({ user, params }) => {
    const { f } = getFile(user, params.id, 'owner', { allowTrashed: true })
    if (!f.trashedAt) throw new HttpError(409, 'File is not in the trash')
    let folderId = f.folderId ?? null
    if (folderId && db.get('drive_folders', folderId)?.trashedAt) folderId = null // parent still trashed: restore to the root
    let name = f.name
    const taken = new Set(filesOf(user.id).filter((x) => !x.trashedAt && (x.folderId ?? null) === folderId).map((x) => x.name))
    for (let i = 2; taken.has(name); i++) name = `${f.name} (restored ${i})`.slice(0, 255)
    const upd = db.update('files', f.id, { trashedAt: null, trashedWith: null, folderId, name, nameTokens: tokenize(name, 50) })
    reindex(upd)
    return view(upd)
  })
  r.get('/api/drive/trash', ({ user }) => ({
    files: filesOf(user.id).filter((f) => f.trashedAt).map((f) => ({ ...view(f), trashedAt: iso(f.trashedAt), purgesAt: L.trashDays() ? iso(f.trashedAt + L.trashDays() * 86_400_000) : null })),
    folders: foldersOf(user.id).filter((d) => d.trashedAt && !d.trashedWith).map((d) => ({ ...folderView(d), trashedAt: iso(d.trashedAt) })),
  }))
  r.delete('/api/drive/trash', ({ user, req }) => {
    let n = 0
    for (const f of filesOf(user.id).filter((x) => x.trashedAt)) { purgeFile(f); n++ }
    db.removeWhere('drive_folders', (d) => d.userId === user.id && d.trashedAt)
    audit(user.id, 'drive.trash.empty', null, { files: n }, req)
    return { ok: true, purged: n }
  })
  function sweepTrash(now = Date.now()) {
    const days = L.trashDays()
    if (!days) return 0
    let n = 0
    for (const f of db.find('files', (x) => x.trashedAt && now - x.trashedAt > days * 86_400_000)) { purgeFile(f); n++ }
    db.removeWhere('drive_folders', (d) => d.trashedAt && now - d.trashedAt > days * 86_400_000)
    return n
  }
  function sweepUploads(now = Date.now()) {
    let n = 0
    for (const u of db.find('drive_uploads', (x) => x.expiresAt < now)) {
      for (const p of Object.values(u.parts)) try { db.deleteBlob(p.blobId) } catch { /* ok */ }
      db.remove('drive_uploads', u.id); n++
    }
    return n
  }

  /* ------------------------------------------------------------------ folders */
  const depthOf = (id) => { let d = 0; for (let x = id; x && d < 100; x = db.get('drive_folders', x)?.parentId) d++; return d }
  const isDescendant = (candidate, ancestorId) => { for (let x = candidate, i = 0; x && i < 100; x = db.get('drive_folders', x)?.parentId, i++) if (x === ancestorId) return true; return false }
  r.get('/api/drive/folders', ({ user }) => ({ folders: foldersOf(user.id).filter((d) => !d.trashedAt).sort((a, b) => a.name.localeCompare(b.name)).map((d) => folderView(d)) }))
  r.post('/api/drive/folders', ({ user, body }) => {
    const name = validName(body.name)
    const parentId = resolveFolder(user, body.parentId)
    if (depthOf(parentId) >= L.maxFolderDepth) throw new HttpError(400, `Folders can be nested at most ${L.maxFolderDepth} levels deep`)
    if (foldersOf(user.id).length >= 10_000) throw new HttpError(409, 'Folder limit reached')
    if (foldersOf(user.id).some((d) => !d.trashedAt && (d.parentId ?? null) === parentId && d.name === name)) throw new HttpError(409, 'A folder with that name already exists here')
    return [201, folderView(db.insert('drive_folders', { userId: user.id, name, parentId }))]
  })
  r.patch('/api/drive/folders/:id', ({ user, params, body }) => {
    const d = getFolder(user, params.id)
    const patch = {}
    if (body.name !== undefined) patch.name = validName(body.name)
    if (body.parentId !== undefined) {
      const parentId = resolveFolder(user, body.parentId)
      if (parentId === d.id || (parentId && isDescendant(parentId, d.id))) throw new HttpError(400, 'A folder cannot be moved into itself')
      if (depthOf(parentId) + 1 > L.maxFolderDepth) throw new HttpError(400, 'Too deeply nested')
      patch.parentId = parentId
    }
    const name = patch.name ?? d.name, parentId = 'parentId' in patch ? patch.parentId : d.parentId ?? null
    if (foldersOf(user.id).some((x) => x.id !== d.id && !x.trashedAt && (x.parentId ?? null) === parentId && x.name === name)) throw new HttpError(409, 'A folder with that name already exists here')
    return folderView(db.update('drive_folders', d.id, patch))
  })
  const descendants = (userId, id) => {
    const all = foldersOf(userId), out = [], stack = [id]
    while (stack.length) { const cur = stack.pop(); for (const d of all) if ((d.parentId ?? null) === cur) { out.push(d); stack.push(d.id) } }
    return out
  }
  r.delete('/api/drive/folders/:id', ({ user, params, query, req }) => {
    const d = getFolder(user, params.id, { allowTrashed: true })
    const subs = descendants(user.id, d.id)
    const ids = new Set([d.id, ...subs.map((x) => x.id)])
    if (query.get('permanent') === '1') {
      for (const f of filesOf(user.id).filter((x) => ids.has(x.folderId))) purgeFile(f)
      db.removeWhere('drive_acl', (a) => ids.has(a.folderId))
      db.removeWhere('drive_folders', (x) => ids.has(x.id))
      return { ok: true, purged: true }
    }
    const now = Date.now()
    db.update('drive_folders', d.id, { trashedAt: now })
    for (const s of subs) db.update('drive_folders', s.id, { trashedAt: now, trashedWith: d.id })
    for (const f of filesOf(user.id).filter((x) => ids.has(x.folderId) && !x.trashedAt)) { db.update('files', f.id, { trashedAt: now, trashedWith: d.id }); reindex(db.get('files', f.id)) }
    audit(user.id, 'drive.folder.trash', d.id, { name: d.name }, req)
    return { ok: true, trashed: true }
  })
  r.post('/api/drive/folders/:id/restore', ({ user, params }) => {
    const d = getFolder(user, params.id, { allowTrashed: true })
    if (!d.trashedAt) throw new HttpError(409, 'Folder is not in the trash')
    const parentTrashed = d.parentId && db.get('drive_folders', d.parentId)?.trashedAt
    db.update('drive_folders', d.id, { trashedAt: null, trashedWith: null, ...(parentTrashed ? { parentId: null } : {}) })
    for (const s of foldersOf(user.id).filter((x) => x.trashedWith === d.id)) db.update('drive_folders', s.id, { trashedAt: null, trashedWith: null })
    for (const f of filesOf(user.id).filter((x) => x.trashedWith === d.id)) { db.update('files', f.id, { trashedAt: null, trashedWith: null }); reindex(db.get('files', f.id)) }
    return folderView(db.get('drive_folders', d.id))
  })

  /* ------------------------------------------------------------------ search, duplicates, shared-with-me */
  r.get('/api/drive/search', ({ user, query }) => {
    const q = (query.get('q') ?? '').trim().slice(0, 200)
    if (!q) throw new HttpError(400, 'Missing ?q=')
    const ix = indexOf(user.id)
    const toks = tokenize(q, 10)
    let ids = null
    for (const t of toks) {
      const hit = new Set(ix.tokens.get(t) ?? [])
      let scanned = 0
      if (t.length >= 2) for (const [k, set] of ix.tokens) { if (++scanned > 50_000) break; if (k !== t && k.startsWith(t)) for (const id of set) hit.add(id) }
      ids = ids ? new Set([...ids].filter((id) => hit.has(id))) : hit
    }
    const lower = q.toLowerCase()
    const results = filesOf(user.id).filter((f) => !f.trashedAt && ((ids?.has(f.id)) || f.name.toLowerCase().includes(lower)) && (!toks.length || ids?.has(f.id) || f.name.toLowerCase().includes(lower)))
    results.sort((a, b) => (b.name.toLowerCase().includes(lower) - a.name.toLowerCase().includes(lower)) || Date.parse(b.updatedAt ?? b.createdAt) - Date.parse(a.updatedAt ?? a.createdAt))
    return { query: q, files: results.slice(0, 100).map((f) => view(f)) }
  })
  r.get('/api/drive/duplicates', ({ user }) => {
    const groups = new Map()
    for (const f of filesOf(user.id).filter((x) => !x.trashedAt)) { const v = latest(f); if (v?.sha256 && v.size > 0) groups.set(v.sha256, [...(groups.get(v.sha256) ?? []), f]) }
    return { groups: [...groups.entries()].filter(([, a]) => a.length > 1).map(([sha, a]) => ({ sha256: sha, size: latest(a[0]).size, files: a.map((f) => view(f)) })) }
  })
  r.get('/api/drive/shared', ({ user }) => {
    const orgs = new Set(ctx?.access?.listOrgIds?.(user.id) ?? [])
    const seen = new Map()
    for (const e of by('drive_acl', 'principalId', user.id)) if (e.principalType === 'user' && e.fileId) seen.set(e.fileId, e)
    for (const org of orgs) for (const e of by('drive_acl', 'principalId', org)) if (e.principalType === 'org' && e.fileId) seen.set(e.fileId, e)
    const out = []
    for (const id of seen.keys()) {
      const f = db.get('files', id)
      if (f && !f.trashedAt && f.userId !== user.id) { const role = roleFor(user.id, f); if (role) out.push({ ...view(f, role), owner: db.get('users', f.userId)?.name ?? null }) }
    }
    return { files: out }
  })

  /* ------------------------------------------------------------------ activity */
  r.get('/api/drive/files/:id/activity', ({ user, params }) => {
    const { f } = getFile(user, params.id)
    return { activity: by('drive_activity', 'fileId', f.id).sort((a, b) => b.ts - a.ts).slice(0, 100).map((a) => ({ action: a.action, by: a.actorId === user.id ? 'you' : db.get('users', a.actorId)?.name ?? 'someone', meta: a.meta, at: iso(a.ts) })) }
  })

  /* ------------------------------------------------------------------ people sharing */
  r.get('/api/drive/files/:id/acl', ({ user, params }) => {
    const { f } = getFile(user, params.id, 'owner')
    return { acl: aclFor(f).map((e) => ({ id: e.id, principalType: e.principalType, role: e.role, email: e.principalType === 'user' ? db.get('users', e.principalId)?.email ?? null : null, orgId: e.principalType === 'org' ? e.principalId : null })) }
  })
  r.post('/api/drive/files/:id/acl', ({ user, params, body, req }) => {
    const { f } = getFile(user, params.id, 'owner')
    const role = body.role === 'editor' ? 'editor' : body.role === 'viewer' || body.role === undefined ? 'viewer' : null
    if (!role) throw new HttpError(400, 'role must be viewer or editor')
    if (aclFor(f).length >= L.maxAcl) throw new HttpError(409, 'Too many people on this file')
    if (typeof body.orgId === 'string') {
      if (!ctx?.access?.orgRole?.(user.id, body.orgId)) throw new HttpError(404, 'Organization not found')
      if (!aclFor(f).some((e) => e.principalType === 'org' && e.principalId === body.orgId)) db.insert('drive_acl', { ownerId: user.id, fileId: f.id, principalType: 'org', principalId: body.orgId, role })
      return { ok: true }
    }
    if (typeof body.email !== 'string') throw new HttpError(400, 'Provide email or orgId')
    const email = body.email.trim().toLowerCase()
    const target = db.findOne('users', (u) => u.email === email)
    // same answer whether or not the account exists (no account enumeration)
    if (target && target.id !== user.id) {
      const existing = aclFor(f).find((e) => e.principalType === 'user' && e.principalId === target.id)
      if (existing) db.update('drive_acl', existing.id, { role })
      else {
        db.insert('drive_acl', { ownerId: user.id, fileId: f.id, principalType: 'user', principalId: target.id, role })
        notify(target.id, { title: `${user.name ?? user.email} shared "${f.name}" with you`, level: 'info', link: '#drive/shared' })
      }
      audit(user.id, 'drive.acl.add', f.id, { role }, req)
    }
    return { ok: true, note: 'If an account exists for that address it now has access.' }
  })
  r.delete('/api/drive/files/:id/acl/:aclId', ({ user, params }) => {
    const { f } = getFile(user, params.id, 'owner')
    const e = db.get('drive_acl', params.aclId)
    if (!e || e.fileId !== f.id) throw new HttpError(404, 'Not found')
    db.remove('drive_acl', e.id)
    return { ok: true }
  })

  /* ------------------------------------------------------------------ link sharing */
  const hashPw = (pw, salt = crypto.randomBytes(12).toString('hex')) => `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`
  const checkPw = (pw, stored) => { const [salt, h] = String(stored).split(':'); const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(String(pw), salt, 32); return a.length === b.length && crypto.timingSafeEqual(a, b) }
  const shareView = (s) => ({ token: s.token, url: `/s/${s.token}`, permission: s.permission ?? 'download', expiresAt: s.expiresAt ? iso(s.expiresAt) : null, passwordProtected: !!s.passwordHash, maxDownloads: s.maxDownloads ?? null, downloads: s.downloads ?? 0, createdAt: s.createdAt })
  r.post('/api/drive/files/:id/share', ({ user, params, body, req }) => {
    const { f } = getFile(user, params.id, 'owner')
    if (by('shares', 'fileId', f.id).length >= L.maxShares) throw new HttpError(409, 'Too many share links for this file')
    const permission = body.permission === 'view' ? 'view' : 'download'
    let expiresAt = null
    if (body.expiresInHours !== undefined && body.expiresInHours !== null) {
      if (typeof body.expiresInHours !== 'number' || !(body.expiresInHours > 0) || body.expiresInHours > 24 * 365) throw new HttpError(400, 'expiresInHours must be between 0 and 8760')
      expiresAt = Date.now() + body.expiresInHours * 3600_000
    }
    let maxDownloads = null
    if (body.maxDownloads !== undefined && body.maxDownloads !== null) {
      if (!Number.isInteger(body.maxDownloads) || body.maxDownloads < 1 || body.maxDownloads > 1_000_000) throw new HttpError(400, 'maxDownloads must be a positive integer')
      maxDownloads = body.maxDownloads
    }
    if (body.password !== undefined && body.password !== null && (typeof body.password !== 'string' || body.password.length < 4 || body.password.length > 200)) throw new HttpError(400, 'password must be 4-200 characters')
    const token = crypto.randomBytes(24).toString('base64url')
    const s = db.insert('shares', { userId: user.id, fileId: f.id, token, permission, expiresAt, maxDownloads, downloads: 0, ...(body.password ? { passwordHash: hashPw(body.password) } : {}) })
    audit(user.id, 'drive.share.create', f.id, { permission, expires: !!expiresAt, passwordProtected: !!body.password }, req)
    return [201, shareView(s)]
  })
  r.get('/api/drive/files/:id/shares', ({ user, params }) => {
    const { f } = getFile(user, params.id, 'owner')
    return { shares: by('shares', 'fileId', f.id).map((s) => ({ ...shareView(s), accessLog: by('drive_share_log', 'shareId', s.id).sort((a, b) => b.ts - a.ts).slice(0, 20).map((l) => ({ at: iso(l.ts), ok: l.ok, ip: l.ip })) })) }
  })
  r.delete('/api/drive/shares/:token', ({ user, params, req }) => {
    const s = db.findOne('shares', (x) => x.token === params.token)
    if (!s) throw new HttpError(404, 'Share not found')
    getFile(user, s.fileId, 'owner', { allowTrashed: true })
    db.remove('shares', s.id)
    db.removeWhere('drive_share_log', (l) => l.shareId === s.id)
    audit(user.id, 'drive.share.revoke', s.fileId, null, req)
    return { ok: true }
  })

  // Public download. Password via the x-share-password header (never the URL). Failed guesses are rate limited per token+ip.
  const attempts = new Map()
  const ipOf = (req) => (req.socket?.remoteAddress ?? '').slice(0, 64)
  async function publicDownload(req, res, token, password) {
    const s = typeof token === 'string' ? db.findOne('shares', (x) => x.token === token) : null
    const f = s && db.get('files', s.fileId)
    const dead = !s || !f || f.trashedAt || (s.expiresAt && s.expiresAt < Date.now()) || (s.maxDownloads && (s.downloads ?? 0) >= s.maxDownloads)
    if (dead) throw new HttpError(404, 'Link not found')
    const ip = ipOf(req)
    const log = (ok) => { db.insert('drive_share_log', { shareId: s.id, ts: Date.now(), ok, ip }); const rows = by('drive_share_log', 'shareId', s.id); if (rows.length > 200) for (const o of rows.sort((a, b) => a.ts - b.ts).slice(0, rows.length - 200)) db.remove('drive_share_log', o.id) }
    if (s.passwordHash) {
      const key = `${s.id}|${ip}`
      const a = attempts.get(key) ?? { n: 0, first: Date.now() }
      if (Date.now() - a.first > 600_000) { a.n = 0; a.first = Date.now() }
      if (a.n >= 10) throw new HttpError(429, 'Too many attempts. Try again later.')
      if (!password || !checkPw(password, s.passwordHash)) {
        a.n++; attempts.set(key, a); if (attempts.size > 5000) attempts.clear()
        log(false)
        const e = new HttpError(401, password ? 'Wrong password' : 'This link is password protected')
        e.headers = { 'x-share-password-required': '1' }
        throw e
      }
    }
    const v = latest(f)
    db.update('shares', s.id, { downloads: (s.downloads ?? 0) + (req.method === 'HEAD' ? 0 : 1) })
    log(true)
    activity(f, null, 'shared-download', null)
    return sendVersion(req, res, f, v, { inline: s.permission === 'view', extra: { 'referrer-policy': 'no-referrer' } })
  }
  r.get('/s/:token', ({ params, req, res }) => publicDownload(req, res, params.token, req.headers['x-share-password']), { public: true, stream: true })
  r.post('/api/drive/public/:token/download', async ({ params, req, res }) => {
    let pw
    try { pw = readJson(await readBody(req, 4096)).password } catch { /* no body */ }
    return publicDownload(req, res, params.token, typeof pw === 'string' ? pw : undefined)
  }, { public: true, stream: true })

  /* ------------------------------------------------------------------ zip */
  const crc = (buf, prev = 0) => zlib.crc32(buf, prev)
  function dosTime(t) { const d = new Date(t); return [((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff, (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff] }
  r.post('/api/drive/zip', async ({ user, req, res }) => {
    let body
    try { body = readJson(await readBody(req, 256 * 1024)) } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, 'Invalid body') }
    const fileIds = Array.isArray(body.fileIds) ? body.fileIds : [], folderIds = Array.isArray(body.folderIds) ? body.folderIds : []
    if (!fileIds.length && !folderIds.length) throw new HttpError(400, 'Provide fileIds and/or folderIds')
    if (fileIds.length + folderIds.length > 1000) throw new HttpError(400, 'Too many items')
    const entries = []
    const pathOf = (folderId) => { const parts = []; for (let d = folderId && db.get('drive_folders', folderId), i = 0; d && i < 25; d = d.parentId ? db.get('drive_folders', d.parentId) : null, i++) parts.unshift(d.name); return parts }
    const used = new Set()
    const add = (f, base) => {
      let p = [...base, f.name].join('/')
      for (let i = 2; used.has(p); i++) p = [...base, `${f.name} (${i})`].join('/')
      used.add(p); entries.push({ path: p, f, v: latest(f) })
    }
    for (const id of fileIds) { const { f } = getFile(user, id, 'read'); add(f, []) }
    for (const id of folderIds) {
      const d = getFolder(user, id)
      const ids = new Set([d.id, ...descendants(user.id, d.id).map((x) => x.id)])
      const parentPath = pathOf(d.parentId ?? null)
      for (const f of filesOf(user.id).filter((x) => !x.trashedAt && ids.has(x.folderId))) add(f, [...parentPath.slice(0, 0), ...pathOf(f.folderId).slice(pathOf(d.parentId).length)])
    }
    if (entries.length > L.maxZipEntries) throw new HttpError(400, `At most ${L.maxZipEntries} files per archive`)
    const totalSize = entries.reduce((s, e) => s + e.v.size, 0)
    if (totalSize > L.maxZipBytes) throw new HttpError(413, 'Archive too large (4 GB limit)')
    for (const e of entries) for (const c of chunksOf(e.v)) if (db.getBlob(c.blobId) === null) throw new HttpError(410, `The stored data for "${e.f.name}" is missing`)
    res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': rfc5987(body.name && typeof body.name === 'string' ? validName(body.name.replace(/\.zip$/i, '') + '.zip') : 'drive.zip'), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    let offset = 0
    const write = async (buf) => { offset += buf.length; if (!res.write(buf)) await once(res, 'drain') }
    const central = []
    for (const e of entries) {
      const name = Buffer.from(e.path, 'utf8')
      const [dt, dd] = dosTime(Date.parse(e.f.updatedAt ?? e.f.createdAt) || Date.now())
      const lh = Buffer.alloc(30)
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0808, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(dt, 10); lh.writeUInt16LE(dd, 12); lh.writeUInt16LE(name.length, 26)
      const headerOffset = offset
      await write(Buffer.concat([lh, name]))
      let crcv = 0, usize = 0, csize = 0
      async function* source() { for (const c of chunksOf(e.v)) { const b = readBlob(c.blobId); crcv = crc(b, crcv); usize += b.length; yield b } }
      const sink = new Writable({ write(chunk, _enc, cb) { csize += chunk.length; offset += chunk.length; if (res.write(chunk)) cb(); else res.once('drain', cb) } })
      await pipeline(Readable.from(source(), { objectMode: false }), zlib.createDeflateRaw({ level: 6 }), sink)
      const dd32 = Buffer.alloc(16)
      dd32.writeUInt32LE(0x08074b50, 0); dd32.writeUInt32LE(crcv >>> 0, 4); dd32.writeUInt32LE(csize, 8); dd32.writeUInt32LE(usize, 12)
      await write(dd32)
      central.push({ name, dt, dd, crc: crcv >>> 0, csize, usize, headerOffset })
    }
    const cdStart = offset
    for (const c of central) {
      const h = Buffer.alloc(46)
      h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0808, 8); h.writeUInt16LE(8, 10); h.writeUInt16LE(c.dt, 12); h.writeUInt16LE(c.dd, 14)
      h.writeUInt32LE(c.crc, 16); h.writeUInt32LE(c.csize, 20); h.writeUInt32LE(c.usize, 24); h.writeUInt16LE(c.name.length, 28); h.writeUInt32LE(c.headerOffset, 42)
      await write(Buffer.concat([h, c.name]))
    }
    const cdSize = offset - cdStart
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10); end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(cdStart, 16)
    await write(end)
    res.end()
    audit(user.id, 'drive.zip', null, { files: entries.length })
    return HANDLED
  }, { stream: true })

  /* ------------------------------------------------------------------ housekeeping */
  const timer = setInterval(() => { try { sweepTrash(); sweepUploads() } catch (e) { console.error('[drive] sweep failed:', e.message) } }, 3600_000)
  timer.unref?.()
  if (ctx) {
    ctx.events.on('shutdown', () => clearInterval(timer))
    ctx.driveSweep = { trash: sweepTrash, uploads: sweepUploads }
    ctx.blobRefs?.set('drive', function* () {
      for (const f of db.find('files', () => true)) for (const v of f.versions ?? []) for (const c of chunksOf(v)) yield c.blobId
      for (const u of db.find('drive_uploads', () => true)) for (const p of Object.values(u.parts ?? {})) yield p.blobId
    })
    ctx.events.on('account.deleted', ({ userId }) => {
      for (const f of filesOf(userId)) for (const v of f.versions ?? []) dropVersionBlobs(v)
      for (const u of by('drive_uploads', 'userId', userId)) for (const p of Object.values(u.parts ?? {})) try { db.deleteBlob(p.blobId) } catch { /* ok */ }
      for (const col of ['files', 'drive_folders', 'drive_uploads', 'shares']) db.removeWhere(col, (x) => x.userId === userId)
      db.removeWhere('drive_acl', (a) => a.ownerId === userId || a.principalId === userId)
      indexes.delete(userId)
    })
  }
}
