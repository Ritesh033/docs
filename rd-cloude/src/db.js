// RD Cloude storage engine: synchronous in-memory document store backed by a write-ahead log (WAL),
// periodic snapshots and a checksummed blob store. Zero dependencies (node:* only).
//
// Public API is synchronous and unchanged: insert/get/find/findOne/update/remove/removeWhere/id/
// putBlob/getBlob/deleteBlob/flush. Additions: findBy/index, transaction, compact, stats, backup,
// gcBlobs, verifyBlobs, close. See docs/storage-engine.md.
//
// On-disk layout of a data dir:
//   LOCK                        exclusive lock (pid, host, nonce); heartbeat-refreshed, stale-detected
//   snapshot-<gen>.rds          full state, checksummed lines + end marker, written atomically
//   wal-<gen>.log               append-only log of mutations since snapshot <gen>
//   blobs/<xx>/<blobId>         44-byte header (magic, length, sha256) + payload, written atomically
//
// Every WAL/snapshot line is `<crc32 hex8> <json>\n`. WAL records carry a gapless sequence number so a
// dropped or duplicated record is detected, not just a flipped byte.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

export const ENGINE = { name: 'rd-storage-engine', formatVersion: 1 }

const CORE_COLLECTIONS = [
  'users', 'sessions', 'apiKeys', 'projects', 'conversations', 'messages', 'artifacts',
  'instances', 'buckets', 'objects', 'files', 'shares', 'docs', 'usage',
]
const SNAPSHOT_FORMAT = 'rd-snapshot'
const WAL_FORMAT = 'rd-wal'
const MAX_RECORD_BYTES = 64 * 1024 * 1024 // one WAL record / transaction
const MAX_SNAPSHOT_LINE = 1024 * 1024 * 1024
const MAX_COLLECTIONS = 10_000
const MAX_INDEXES_PER_COLLECTION = 16
const REMOVE_CHUNK = 50_000
const BLOB_MAGIC = Buffer.from('RDB1')
const BLOB_HEADER = 44 // magic(4) + length u64 BE (8) + sha256 (32)
const BLOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const COL_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:@-]{0,127}$/
const FIELD_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/
const FSYNC_MODES = ['always', 'batch', 'never']
const NL = Buffer.from('\n')
const EMPTY = Buffer.alloc(0)

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------
export class DbError extends Error {
  constructor(message, code = 'EDB', details) {
    super(message)
    this.name = this.constructor.name
    this.code = code
    if (details !== undefined) this.details = details
  }
}
export class DbLockedError extends DbError {
  constructor(message, details) { super(message, 'EDBLOCKED', details) }
}
export class DbCorruptionError extends DbError {
  constructor(message, details) { super(message, 'EDBCORRUPT', details) }
}
export class BlobCorruptError extends DbError {
  constructor(id, reason) {
    super(`blob "${id}" is corrupt: ${reason}`, 'EBLOBCORRUPT', { id, reason })
    this.blobId = id
  }
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------
const crc32 = typeof zlib.crc32 === 'function' ? (b) => zlib.crc32(b) : (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c }
  return (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0 }
})()
const hex8 = (n) => (n >>> 0).toString(16).padStart(8, '0')
const pad = (n) => String(n).padStart(10, '0')
const snapName = (g) => `snapshot-${pad(g)}.rds`
const walName = (g) => `wal-${pad(g)}.log`
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const validId = (id) => (typeof id === 'string' ? id.length > 0 && id.length <= 512 : typeof id === 'number' && Number.isFinite(id))
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

function checkCol(col) {
  if (typeof col !== 'string' || !COL_RE.test(col)) throw new TypeError(`invalid collection name: ${JSON.stringify(String(col).slice(0, 80))}`)
}
function checkField(field) {
  if (typeof field !== 'string' || !FIELD_RE.test(field)) throw new TypeError(`invalid index field: ${JSON.stringify(String(field).slice(0, 80))}`)
}

function fsyncDir(dir) {
  let fd
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch (e) {
    if (!['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP', 'EBADF', 'EACCES'].includes(e.code)) throw e // not supported on some platforms
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch { /* ignore */ }
  }
}
function writeAll(fd, buf) {
  let off = 0
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off)
}
/** tmp + write + fsync + rename + dir fsync */
function atomicWriteFile(file, data, sync = true) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    writeAll(fd, data)
    if (sync) fs.fsyncSync(fd)
  } catch (e) {
    try { fs.closeSync(fd) } catch { /* ignore */ }
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw e
  }
  fs.closeSync(fd)
  fs.renameSync(tmp, file)
  if (sync) fsyncDir(path.dirname(file))
}

function encodeLine(json) {
  const n = Buffer.byteLength(json)
  const buf = Buffer.allocUnsafe(n + 10)
  buf.write(json, 9, 'utf8')
  buf.write(hex8(crc32(buf.subarray(9, 9 + n))), 0, 8, 'latin1')
  buf[8] = 0x20
  buf[9 + n] = 0x0a
  return buf
}
const BAD_SHORT = { ok: false, reason: 'record too short' }
function decodeLine(line) {
  if (line.length < 11) return BAD_SHORT
  if (line[8] !== 0x20) return { ok: false, reason: 'bad record framing' }
  const hex = line.toString('latin1', 0, 8)
  if (!/^[0-9a-f]{8}$/.test(hex)) return { ok: false, reason: 'bad checksum field' }
  const payload = line.subarray(9)
  if (crc32(payload) !== parseInt(hex, 16)) return { ok: false, reason: 'checksum mismatch' }
  try { return { ok: true, value: JSON.parse(payload.toString('utf8')) } } catch { return { ok: false, reason: 'invalid JSON' } }
}

/** Streams newline-terminated lines from a file in 1 MiB reads. Yielded buffers are only valid until the next iteration. */
function* readLines(file, maxLine) {
  const fd = fs.openSync(file, 'r')
  try {
    const chunk = Buffer.allocUnsafe(1 << 20)
    let pos = 0
    let lineStart = 0
    let parts = []
    let partsLen = 0
    let overflow = false
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos)
      if (n === 0) break
      const view = chunk.subarray(0, n)
      let from = 0
      for (;;) {
        const nl = view.indexOf(10, from)
        if (nl < 0) {
          if (!overflow && from < n) {
            parts.push(Buffer.from(view.subarray(from)))
            partsLen += n - from
            if (partsLen > maxLine) {
              overflow = true
              parts = []
              partsLen = 0
              yield { off: lineStart, end: pos + n, buf: EMPTY, nl: false, tooLong: true }
            }
          }
          break
        }
        const abs = pos + nl
        if (overflow) overflow = false
        else {
          let line = view.subarray(from, nl)
          if (parts.length) { parts.push(line); line = Buffer.concat(parts) }
          if (line.length > maxLine) yield { off: lineStart, end: abs + 1, buf: EMPTY, nl: true, tooLong: true }
          else yield { off: lineStart, end: abs + 1, buf: line, nl: true }
        }
        parts = []
        partsLen = 0
        lineStart = abs + 1
        from = nl + 1
      }
      pos += n
    }
    if (!overflow && partsLen > 0) yield { off: lineStart, end: pos, buf: Buffer.concat(parts), nl: false }
  } finally {
    fs.closeSync(fd)
  }
}

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------
function intOpt(optVal, envName, def, min, max) {
  const raw = optVal ?? process.env[envName]
  if (raw === undefined || raw === null || raw === '') return def
  const n = typeof raw === 'number' ? raw : /^\d+$/.test(String(raw).trim()) ? Number(raw) : NaN
  if (!Number.isInteger(n) || n < min || n > max) throw new RangeError(`${envName} must be an integer between ${min} and ${max} (got "${raw}")`)
  return n
}
function boolOpt(optVal, envName, def) {
  const raw = optVal ?? process.env[envName]
  if (raw === undefined || raw === null || raw === '') return def
  if (typeof raw === 'boolean') return raw
  const s = String(raw).toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(s)) return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  throw new RangeError(`${envName} must be a boolean (1/0, true/false), got "${raw}"`)
}
export function resolveConfig(opts = {}) {
  const fsync = String(opts.fsync ?? process.env.RD_FSYNC ?? 'batch').toLowerCase()
  if (!FSYNC_MODES.includes(fsync)) throw new RangeError(`RD_FSYNC must be one of ${FSYNC_MODES.join('|')} (got "${fsync}")`)
  const recover = String(opts.recover ?? process.env.RD_RECOVER ?? '').toLowerCase()
  if (recover && recover !== 'truncate') throw new RangeError(`RD_RECOVER must be empty or "truncate" (got "${recover}")`)
  return {
    fsync,
    fsyncIntervalMs: intOpt(opts.fsyncIntervalMs, 'RD_FSYNC_INTERVAL_MS', 100, 1, 60_000),
    compactMinBytes: intOpt(opts.compactMinBytes, 'RD_WAL_COMPACT_MIN_BYTES', 8 * 1024 * 1024, 1, 2 ** 40),
    compactMaxBytes: intOpt(opts.compactMaxBytes, 'RD_WAL_COMPACT_MAX_BYTES', 256 * 1024 * 1024, 1, 2 ** 40),
    keepGenerations: intOpt(opts.keepGenerations, 'RD_KEEP_GENERATIONS', 2, 1, 10),
    lockLeaseMs: intOpt(opts.lockLeaseMs, 'RD_LOCK_LEASE_MS', 30_000, 100, 3_600_000),
    blobMaxBytes: intOpt(opts.blobMaxBytes, 'RD_BLOB_MAX_BYTES', 256 * 1024 * 1024, 1, 2 ** 31),
    snapshotOnClose: boolOpt(opts.snapshotOnClose, 'RD_SNAPSHOT_ON_CLOSE', true),
    forceUnlock: boolOpt(opts.forceUnlock, 'RD_FORCE_UNLOCK', false),
    recover,
  }
}
const defaultLogger = {
  info: (m) => console.log(`[rd-db] ${m}`),
  warn: (m) => console.warn(`[rd-db] WARNING ${m}`),
  error: (m) => console.error(`[rd-db] ERROR ${m}`),
}

// ---------------------------------------------------------------------------------------------
// In-memory store: collections (insertion-ordered Maps), secondary indexes, op application
// ---------------------------------------------------------------------------------------------
class Bucket { constructor(a, b) { this.set = new Set([a, b]); this.dirty = false } }

class Index {
  constructor(field, rank) { this.field = field; this.rank = rank; this.map = new Map() }
  add(row, moved) {
    const v = row[this.field]
    if (v !== v) return // NaN is never === to anything, so it is never findable
    const cur = this.map.get(v)
    if (cur === undefined) { this.map.set(v, row); return }
    if (cur instanceof Bucket) { cur.set.add(row); if (moved) cur.dirty = true; return }
    if (cur === row) return
    const b = new Bucket(cur, row)
    if (moved && this.rank.get(row) < this.rank.get(cur)) b.dirty = true
    this.map.set(v, b)
  }
  remove(row, v) {
    if (v !== v) return
    const cur = this.map.get(v)
    if (cur === row) this.map.delete(v)
    else if (cur instanceof Bucket) {
      cur.set.delete(row)
      if (cur.set.size === 1) this.map.set(v, cur.set.values().next().value)
      else if (cur.set.size === 0) this.map.delete(v)
    }
  }
  /** Rows with row[field] === v, in collection insertion order. Entries made stale by out-of-band mutation are filtered. */
  lookup(v) {
    if (v !== v) return []
    const cur = this.map.get(v)
    if (cur === undefined) return []
    if (!(cur instanceof Bucket)) return cur[this.field] === v ? [cur] : []
    if (cur.dirty) {
      const rows = [...cur.set].sort((a, b) => this.rank.get(a) - this.rank.get(b))
      cur.set = new Set(rows)
      cur.dirty = false
    }
    const out = []
    for (const r of cur.set) if (r[this.field] === v) out.push(r)
    return out
  }
}

class Store {
  constructor() {
    this.cols = new Map() // collection -> Map(id -> row), insertion ordered
    this.idx = new Map() // collection -> Map(field -> Index)
    this.rank = new WeakMap() // row -> insertion rank (stable across updates)
    this.rankCounter = 0
    this.pendingReorder = new Set()
  }
  get(col, id) { return this.cols.get(col)?.get(id) ?? null }
  count() { let n = 0; for (const m of this.cols.values()) n += m.size; return n }
  checkInsert(col, row) {
    if (!validId(row.id)) throw new TypeError('document id must be a non-empty string or a finite number')
    const c = this.cols.get(col)
    if (c) { if (c.has(row.id)) throw new DbError(`duplicate id "${row.id}" in collection "${col}"`, 'EDBDUPLICATE') }
    else if (this.cols.size >= MAX_COLLECTIONS) throw new RangeError(`too many collections (max ${MAX_COLLECTIONS})`)
  }
  insertRow(col, row) {
    this.checkInsert(col, row)
    let c = this.cols.get(col)
    if (!c) this.cols.set(col, (c = new Map()))
    c.set(row.id, row)
    const reinserted = this.rank.has(row) // a rolled-back removal keeps its old rank, so it is not the newest row
    if (!reinserted) this.rank.set(row, ++this.rankCounter)
    const ix = this.idx.get(col)
    if (ix) for (const i of ix.values()) i.add(row, reinserted)
  }
  removeRow(col, row) {
    this.cols.get(col)?.delete(row.id)
    const ix = this.idx.get(col)
    if (ix) for (const i of ix.values()) i.remove(row, row[i.field])
  }
  /** Applies a validated patch. Returns an undo closure when requested. */
  patchRow(col, row, set, del, wantUndo) {
    let undo = null
    if (wantUndo) {
      const prev = []
      for (const k of Object.keys(set)) prev.push([k, hasOwn(row, k), row[k]])
      for (const k of del) prev.push([k, hasOwn(row, k), row[k]])
      undo = () => {
        const s = {}
        const d = []
        for (const [k, had, v] of prev) { if (had) s[k] = v; else d.push(k) }
        this.patchRow(col, row, s, d, false)
      }
    }
    const ix = this.idx.get(col)
    let olds = null
    if (ix && ix.size) { olds = []; for (const i of ix.values()) olds.push(row[i.field]) }
    for (const k of Object.keys(set)) { if (k !== 'id' && k !== '__proto__') row[k] = set[k] }
    for (const k of del) { if (k !== 'id' && k !== '__proto__') delete row[k] }
    if (olds) {
      let n = 0
      for (const i of ix.values()) {
        const ov = olds[n++]
        const nv = row[i.field]
        if (nv !== ov && !(nv !== nv && ov !== ov)) { i.remove(row, ov); i.add(row, true) }
      }
    }
    return undo
  }
  /** Applies one logged operation. Throws on malformed/inapplicable ops (callers pre-validate live ops). */
  applyOp(op, undo = null) {
    switch (op.o) {
      case 'i': {
        const { c, r } = op
        if (typeof c !== 'string' || !isObj(r)) throw new Error('malformed insert')
        this.insertRow(c, r)
        if (undo) undo.push(() => this.removeRow(c, r))
        return r
      }
      case 'u': {
        const row = this.get(op.c, op.i)
        if (!row) throw new Error(`update of missing document ${op.c}/${op.i}`)
        if ((op.p !== undefined && !isObj(op.p)) || (op.d !== undefined && !Array.isArray(op.d))) throw new Error('malformed update')
        const u = this.patchRow(op.c, row, op.p ?? {}, op.d ?? [], undo !== null)
        if (u) undo.push(u)
        return row
      }
      case 'r': {
        const row = this.get(op.c, op.i)
        if (!row) throw new Error(`remove of missing document ${op.c}/${op.i}`)
        this.#remove(op.c, row, undo)
        return true
      }
      case 'R': {
        if (!Array.isArray(op.ids)) throw new Error('malformed bulk remove')
        for (const id of op.ids) {
          const row = this.get(op.c, id)
          if (!row) throw new Error(`remove of missing document ${op.c}/${id}`)
          this.#remove(op.c, row, undo)
        }
        return op.ids.length
      }
      case 't': {
        if (!Array.isArray(op.ops)) throw new Error('malformed transaction')
        for (const sub of op.ops) this.applyOp(sub, undo)
        return null
      }
      default: throw new Error(`unknown operation "${String(op.o).slice(0, 20)}"`)
    }
  }
  #remove(col, row, undo) {
    this.removeRow(col, row)
    if (undo) undo.push(() => { this.insertRow(col, row); this.pendingReorder.add(col) })
  }
  /** Restores rank order of collections after rolled-back removals. */
  settleReorders() {
    for (const col of this.pendingReorder) {
      const m = this.cols.get(col)
      if (!m) continue
      const rows = [...m.values()].sort((a, b) => this.rank.get(a) - this.rank.get(b))
      m.clear()
      for (const r of rows) m.set(r.id, r)
    }
    this.pendingReorder.clear()
  }
  ensureIndex(col, field) {
    let ix = this.idx.get(col)
    if (!ix) {
      if (this.idx.size >= MAX_COLLECTIONS) return null
      this.idx.set(col, (ix = new Map()))
    }
    let i = ix.get(field)
    if (i) return i
    if (ix.size >= MAX_INDEXES_PER_COLLECTION) return null
    i = new Index(field, this.rank)
    const c = this.cols.get(col)
    if (c) for (const r of c.values()) i.add(r, false)
    ix.set(field, i)
    return i
  }
}

// ---------------------------------------------------------------------------------------------
// Snapshot files
// ---------------------------------------------------------------------------------------------
/** Writes a snapshot of `store` to `file` (not atomic by itself: callers write to a tmp name and rename). */
function writeSnapshotFile(file, store, { gen, seq }, sync) {
  const fd = fs.openSync(file, 'wx', 0o600)
  const hash = crypto.createHash('sha256')
  let bytes = 0
  let lines = 0
  let rows = 0
  const emit = (json, covered = true) => {
    const b = encodeLine(json)
    if (covered) hash.update(b)
    writeAll(fd, b)
    bytes += b.length
    lines++
  }
  try {
    emit(JSON.stringify({ t: 'hdr', fmt: SNAPSHOT_FORMAT, v: ENGINE.formatVersion, gen, seq, createdAt: new Date().toISOString() }))
    for (const [name, m] of store.cols) {
      const head = `{"t":"rows","c":${JSON.stringify(name)},"r":[`
      let parts = []
      let size = 0
      for (const row of m.values()) {
        const s = JSON.stringify(row)
        if (s.length > MAX_SNAPSHOT_LINE / 2) throw new RangeError(`document ${name}/${row.id} is too large to snapshot`)
        parts.push(s)
        size += s.length
        rows++
        if (size >= 1_000_000) { emit(`${head}${parts.join(',')}]}`); parts = []; size = 0 }
      }
      if (parts.length || m.size === 0) emit(`${head}${parts.join(',')}]}`)
    }
    const digest = hash.digest('hex')
    emit(JSON.stringify({ t: 'end', lines, rows, sha256: digest }), false)
    if (sync) fs.fsyncSync(fd)
  } catch (e) {
    try { fs.closeSync(fd) } catch { /* ignore */ }
    try { fs.unlinkSync(file) } catch { /* ignore */ }
    throw e
  }
  fs.closeSync(fd)
  return { bytes, rows, lines }
}

function corrupt(file, off, reason, extra = {}) {
  return new DbCorruptionError(`${path.basename(file)}: ${reason}${off !== null && off !== undefined ? ` (at byte ${off})` : ''}`, { file, offset: off, reason, ...extra })
}

/** Reads and fully validates a snapshot. Throws DbCorruptionError for any defect (snapshots are atomic: no partial acceptance). */
function loadSnapshotFile(file, expectedGen) {
  const store = new Store()
  const hash = crypto.createHash('sha256')
  let hdr = null
  let footer = null
  let lines = 0
  let rows = 0
  for (const ln of readLines(file, MAX_SNAPSHOT_LINE)) {
    if (footer) throw corrupt(file, ln.off, 'data after end marker')
    if (ln.tooLong) throw corrupt(file, ln.off, 'line too long')
    if (!ln.nl) throw corrupt(file, ln.off, 'unterminated final line (truncated snapshot)')
    const dec = decodeLine(ln.buf)
    if (!dec.ok) throw corrupt(file, ln.off, dec.reason)
    const v = dec.value
    if (!hdr) {
      if (v.t !== 'hdr' || v.fmt !== SNAPSHOT_FORMAT) throw corrupt(file, ln.off, 'not a snapshot header')
      if (v.v > ENGINE.formatVersion) throw corrupt(file, ln.off, `snapshot format v${v.v} is newer than this engine (v${ENGINE.formatVersion})`)
      if (v.gen !== expectedGen) throw corrupt(file, ln.off, `generation mismatch (file name says ${expectedGen}, header says ${v.gen})`)
      if (!Number.isInteger(v.seq) || v.seq < 0) throw corrupt(file, ln.off, 'bad sequence in header')
      hdr = v
    } else if (v.t === 'end') {
      footer = v
      continue
    } else if (v.t === 'rows' && typeof v.c === 'string' && Array.isArray(v.r)) {
      if (!store.cols.has(v.c)) store.cols.set(v.c, new Map())
      for (const row of v.r) {
        if (!isObj(row)) throw corrupt(file, ln.off, 'row is not an object')
        try { store.insertRow(v.c, row) } catch (e) { throw corrupt(file, ln.off, e.message) }
        rows++
      }
    } else throw corrupt(file, ln.off, 'unknown record type')
    hash.update(ln.buf)
    hash.update(NL)
    lines++
  }
  if (!hdr) throw corrupt(file, 0, 'empty snapshot')
  if (!footer) throw corrupt(file, null, 'missing end marker (truncated snapshot)')
  if (footer.lines !== lines || footer.rows !== rows) throw corrupt(file, null, `end marker mismatch (expected ${footer.lines} lines/${footer.rows} rows, read ${lines}/${rows})`)
  if (footer.sha256 !== hash.digest('hex')) throw corrupt(file, null, 'snapshot sha256 mismatch')
  return { store, gen: hdr.gen, seq: hdr.seq, rows, createdAt: hdr.createdAt, bytes: fs.statSync(file).size }
}

// ---------------------------------------------------------------------------------------------
// Directory scanning, WAL replay, state recovery
// ---------------------------------------------------------------------------------------------
function scanDir(dir) {
  const out = { snapshots: [], wals: [], tmp: [] }
  let names
  try { names = fs.readdirSync(dir) } catch (e) { if (e.code === 'ENOENT') return out; throw e }
  for (const n of names) {
    let m
    if ((m = /^snapshot-(\d{10})\.rds$/.exec(n))) out.snapshots.push({ gen: Number(m[1]), file: path.join(dir, n), name: n })
    else if ((m = /^wal-(\d{10})\.log$/.exec(n))) out.wals.push({ gen: Number(m[1]), file: path.join(dir, n), name: n })
    else if (/^(snapshot-\d{10}\.rds|db\.json)\.tmp$/.test(n)) out.tmp.push(path.join(dir, n)) // engine-owned temp files only: other modules keep files here too
  }
  out.snapshots.sort((a, b) => a.gen - b.gen)
  out.wals.sort((a, b) => a.gen - b.gen)
  return out
}

/** `empty` = the database state at baseSeq is the empty database, i.e. "no snapshot + this log chain" is a complete history. */
const walHeaderLine = (gen, baseSeq, empty) => encodeLine(JSON.stringify({ t: 'hdr', fmt: WAL_FORMAT, v: ENGINE.formatVersion, gen, baseSeq, empty, createdAt: new Date().toISOString() }))

/**
 * Replays one WAL file into `store`. A bad record with no valid record after it is a torn tail (allowed on the
 * last file only: reported as a truncate action). A bad record followed by valid ones, a sequence gap or an
 * inapplicable record is corruption: thrown, or (RD_RECOVER=truncate) turned into a truncate-and-stop action.
 */
function replayWal(w, store, startSeq, { isLast, recover, emptyBase }) {
  const { file, gen } = w
  const res = { seq: startSeq, records: 0, validEnd: 0, hdr: false, needsHeader: false, needsNewline: false, action: null, stop: false, warnings: [] }
  const size = fs.statSync(file).size
  if (size === 0) {
    if (!isLast) throw corrupt(file, 0, 'empty log file (missing header)')
    res.needsHeader = true
    return res
  }
  let bad = null
  let validAfterBad = false
  let semantic = null
  for (const ln of readLines(file, MAX_RECORD_BYTES + 128)) {
    const dec = ln.tooLong ? { ok: false, reason: 'record too long' } : decodeLine(ln.buf)
    if (bad) { if (dec.ok) { validAfterBad = true; break } continue }
    if (!dec.ok) { bad = { off: ln.off, reason: dec.reason }; continue }
    const v = dec.value
    try {
      if (!res.hdr) {
        if (v.t !== 'hdr' || v.fmt !== WAL_FORMAT) throw new Error('not a WAL header')
        if (v.v > ENGINE.formatVersion) throw new Error(`WAL format v${v.v} is newer than this engine`)
        if (v.gen !== gen) throw new Error(`generation mismatch (file name says ${gen}, header says ${v.gen})`)
        if (v.baseSeq !== res.seq) throw new Error(`log does not continue the previous state (header base sequence ${v.baseSeq}, expected ${res.seq}): a snapshot or log file is missing`)
        if (emptyBase && v.empty !== true) throw new Error('this log builds on a snapshot that is missing or unreadable, so it cannot be replayed onto an empty database')
        res.hdr = true
      } else {
        if (v.s !== res.seq + 1) throw new Error(`sequence gap: expected record ${res.seq + 1}, found ${v.s} (a record was lost or duplicated)`)
        store.applyOp(v)
        res.seq = v.s
        res.records++
      }
    } catch (e) {
      semantic = { off: ln.off, reason: e.message }
      break
    }
    res.validEnd = ln.end
    if (!ln.nl) res.needsNewline = true
  }
  if (semantic || (bad && (validAfterBad || !isLast))) {
    const at = semantic ?? bad
    const why = semantic ? at.reason : validAfterBad ? `${at.reason}; valid records follow it, so this is damage in the middle of the log, not a torn tail` : `${at.reason} in a log file that is not the newest one`
    if (recover !== 'truncate') {
      throw corrupt(file, at.off, `${why}. Refusing to start. Run "node scripts/backup.mjs verify <dataDir>" and restore a backup, or start once with RD_RECOVER=truncate to discard everything from this record on (data loss)`, { recordsReplayed: res.records })
    }
    res.action = { type: 'truncate', file, at: at.off, bytes: size - at.off, kind: 'corruption', preserve: true, reason: why }
    res.validEnd = at.off
    res.stop = true
    res.needsNewline = false
    res.needsHeader = at.off === 0
    res.warnings.push(`RD_RECOVER=truncate: discarding ${size - at.off} bytes of ${path.basename(file)} from byte ${at.off} (${why})`)
  } else if (bad) {
    res.action = { type: 'truncate', file, at: bad.off, bytes: size - bad.off, kind: 'torn-tail', preserve: false, reason: bad.reason }
    res.validEnd = bad.off
    res.needsNewline = false
    res.needsHeader = bad.off === 0
    res.warnings.push(`discarded torn tail of ${path.basename(file)}: ${size - bad.off} bytes (${bad.reason})`)
  }
  return res
}

/**
 * Recovers state from a data dir without modifying it. Returns the store plus the actions the opener must
 * perform (truncate torn tails, quarantine bad snapshots). Throws DbCorruptionError when unrecoverable.
 */
function loadState(dir, { recover = '' } = {}) {
  const scan = scanDir(dir)
  const out = {
    store: null, seq: 0, baseGen: 0, baseSeq: 0, activeGen: 1, activeRecords: 0, snapshot: null, needsHeader: false, needsNewline: false,
    actions: [], warnings: [], snapshotReport: [], walReport: [], fellBack: false, replayed: 0, tornBytes: 0,
  }
  const failures = []
  for (const s of [...scan.snapshots].reverse()) {
    try {
      const snap = loadSnapshotFile(s.file, s.gen)
      out.store = snap.store
      out.baseGen = s.gen
      out.baseSeq = snap.seq
      out.snapshot = { file: s.file, gen: s.gen, seq: snap.seq, rows: snap.rows, bytes: snap.bytes, createdAt: snap.createdAt }
      out.snapshotReport.push({ file: s.name, gen: s.gen, ok: true, rows: snap.rows, seq: snap.seq, bytes: snap.bytes })
      break
    } catch (e) {
      if (!(e instanceof DbCorruptionError)) throw e
      failures.push(e.message)
      out.snapshotReport.push({ file: s.name, gen: s.gen, ok: false, error: e.message })
      out.actions.push({ type: 'quarantine', file: s.file, reason: e.message })
      out.warnings.push(`snapshot ${s.name} is unreadable (${e.message}); falling back to an older generation`)
      out.fellBack = true
    }
  }
  if (!out.store) out.store = new Store()
  const wals = scan.wals.filter((w) => w.gen >= out.baseGen)
  let seq = out.baseSeq
  try {
    for (let i = 0; i < wals.length; i++) {
      const w = wals[i]
      const r = replayWal(w, out.store, seq, { isLast: i === wals.length - 1, recover, emptyBase: i === 0 && !out.snapshot })
      seq = r.seq
      out.replayed += r.records
      out.warnings.push(...r.warnings)
      out.walReport.push({ file: w.name, gen: w.gen, records: r.records, validBytes: r.validEnd, action: r.action?.kind ?? null })
      if (r.action) { out.actions.push(r.action); if (r.action.kind === 'torn-tail') out.tornBytes += r.action.bytes }
      if (i === wals.length - 1 || r.stop) {
        out.activeGen = w.gen
        out.activeRecords = r.records
        out.needsHeader = r.needsHeader
        out.needsNewline = r.needsNewline
      }
      if (r.stop) {
        for (const later of wals.slice(i + 1)) out.actions.push({ type: 'quarantine', file: later.file, reason: 'follows discarded records (RD_RECOVER=truncate)' })
        break
      }
    }
  } catch (e) {
    if (e instanceof DbCorruptionError && failures.length) e.message += ` [also: ${failures.join('; ')}]`
    throw e
  }
  if (!out.snapshot && failures.length && !out.walReport.some((r) => r.records > 0 || r.validBytes > 0)) {
    throw new DbCorruptionError(`no readable snapshot (${failures.join('; ')}) and no log to rebuild from. Refusing to start empty: restore a backup with "node scripts/backup.mjs restore"`, { failures })
  }
  if (!wals.length) { out.activeGen = Math.max(out.baseGen, 1); out.needsHeader = true }
  out.seq = seq
  return out
}

// ---------------------------------------------------------------------------------------------
// Lock file
// ---------------------------------------------------------------------------------------------
const heldLocks = new Map() // lock file -> { nonce, onExit }
let exitHooked = false
function hookExit() {
  if (exitHooked) return
  exitHooked = true
  process.on('exit', () => {
    for (const [file, h] of heldLocks) {
      try { h.onExit?.() } catch { /* ignore */ }
      try { if (readLockInfo(file)?.nonce === h.nonce) fs.unlinkSync(file) } catch { /* ignore */ }
    }
  })
}
function readLockInfo(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isObj(v) && typeof v.nonce === 'string' ? v : null
  } catch { return null }
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code !== 'ESRCH' }
}
function inspectLock(file, cfg) {
  let st
  try { st = fs.statSync(file) } catch (e) { if (e.code === 'ENOENT') return { state: 'gone' }; throw e }
  const info = readLockInfo(file)
  const age = Date.now() - st.mtimeMs
  if (!info) return age < 5000 ? { state: 'unknown' } : { state: 'stale', info: null, reason: 'unreadable lock file' }
  const held = heldLocks.get(file)
  if (held && held.nonce === info.nonce) return { state: 'live', info, reason: 'open in this process' }
  if (info.host === os.hostname()) {
    if (info.pid === process.pid) return { state: 'stale', info, reason: `left by an earlier process that had the same pid ${info.pid}` }
    if (!pidAlive(info.pid)) return { state: 'stale', info, reason: `process ${info.pid} is not running` }
  }
  if (age > cfg.lockLeaseMs) return { state: 'stale', info, reason: `no heartbeat for ${Math.round(age / 1000)}s (lease ${Math.round(cfg.lockLeaseMs / 1000)}s)` }
  return { state: 'live', info, reason: 'heartbeat is fresh' }
}
/** Removes a stale lock under a short-lived claim file so two starters cannot both decide "stale" and both delete. */
function takeoverStale(file, expectedNonce, force) {
  const claim = `${file}.claim`
  let have = false
  for (let i = 0; i < 60 && !have; i++) {
    try { fs.closeSync(fs.openSync(claim, 'wx', 0o600)); have = true } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try { if (Date.now() - fs.statSync(claim).mtimeMs > 10_000) fs.unlinkSync(claim) } catch { /* raced */ }
      sleepSync(50)
    }
  }
  if (!have) throw new DbLockedError('could not take over a stale lock: another process is doing so')
  try {
    const cur = readLockInfo(file)
    if (!force && cur && cur.nonce !== expectedNonce) return // someone else already replaced it: re-inspect
    try { fs.unlinkSync(file) } catch (e) { if (e.code !== 'ENOENT') throw e }
  } finally {
    try { fs.unlinkSync(claim) } catch { /* ignore */ }
  }
}
function acquireLock(dir, cfg, log) {
  const file = path.join(dir, 'LOCK')
  const nonce = crypto.randomBytes(8).toString('hex')
  const body = JSON.stringify({ pid: process.pid, host: os.hostname(), nonce, startedAt: new Date().toISOString(), node: process.version })
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600)
      try { fs.writeSync(fd, body) } finally { fs.closeSync(fd) }
      heldLocks.set(file, { nonce })
      hookExit()
      return {
        file,
        nonce,
        info: JSON.parse(body),
        setOnExit(fn) { const h = heldLocks.get(file); if (h) h.onExit = fn },
        /** true while the lock file still carries our nonce (recreates it if it vanished) */
        verify() {
          const cur = readLockInfo(file)
          if (cur) return cur.nonce === nonce
          try { const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeSync(fd, body) } finally { fs.closeSync(fd) }; return true } catch { return false }
        },
        touch() { const t = new Date(); fs.utimesSync(file, t, t) },
        release() {
          heldLocks.delete(file)
          try { if (readLockInfo(file)?.nonce === nonce) fs.unlinkSync(file) } catch { /* ignore */ }
        },
      }
    } catch (e) { if (e.code !== 'EEXIST') throw e }
    const v = inspectLock(file, cfg)
    if (v.state === 'gone') continue
    if (v.state === 'unknown') { sleepSync(50); continue }
    if (v.state === 'live' && !cfg.forceUnlock) {
      const i = v.info
      throw new DbLockedError(`data directory ${dir} is in use by pid ${i.pid} on ${i.host} since ${i.startedAt} (${v.reason}). Stop that process, or if it is certainly dead remove ${file} (or set RD_FORCE_UNLOCK=1)`, { pid: i.pid, host: i.host, startedAt: i.startedAt })
    }
    if (v.state === 'live') log.warn(`RD_FORCE_UNLOCK: overriding live lock held by pid ${v.info.pid} on ${v.info.host}`)
    else log.warn(`removing stale lock: ${v.reason}`)
    takeoverStale(file, v.info?.nonce, v.state === 'live')
  }
  throw new DbLockedError(`could not acquire ${file}`)
}

// ---------------------------------------------------------------------------------------------
// Blob files (header + payload, sha256 verified on read, atomic writes)
// ---------------------------------------------------------------------------------------------
function shardOf(id) {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h & 0xff).toString(16).padStart(2, '0')
}
const blobFile = (blobDir, id) => path.join(blobDir, shardOf(id), id)
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (typeof data === 'string') return Buffer.from(data)
  throw new TypeError('blob data must be a Buffer, Uint8Array or string')
}
function parseBlob(buf, id) {
  if (buf.length < BLOB_HEADER || !buf.subarray(0, 4).equals(BLOB_MAGIC)) throw new BlobCorruptError(id, 'missing or damaged header')
  const len = Number(buf.readBigUInt64BE(4))
  if (buf.length - BLOB_HEADER !== len) throw new BlobCorruptError(id, `size mismatch (header says ${len} bytes, file holds ${buf.length - BLOB_HEADER})`)
  const payload = buf.subarray(BLOB_HEADER)
  if (!crypto.createHash('sha256').update(payload).digest().equals(buf.subarray(12, BLOB_HEADER))) throw new BlobCorruptError(id, 'sha256 mismatch')
  return payload
}
/** Writes a blob atomically. Returns { size, sha256, createdShard }. */
function writeBlobFile(blobDir, id, data, sync) {
  const shard = shardOf(id)
  const dir = path.join(blobDir, shard)
  const created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined
  const sha = crypto.createHash('sha256').update(data).digest()
  const header = Buffer.alloc(BLOB_HEADER)
  BLOB_MAGIC.copy(header, 0)
  header.writeBigUInt64BE(BigInt(data.length), 4)
  sha.copy(header, 12)
  const final = path.join(dir, id)
  const tmp = path.join(dir, `.${id}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    writeAll(fd, header)
    writeAll(fd, data)
    if (sync) fs.fsyncSync(fd)
  } catch (e) {
    try { fs.closeSync(fd) } catch { /* ignore */ }
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw e
  }
  fs.closeSync(fd)
  try { fs.renameSync(tmp, final) } catch (e) { try { fs.unlinkSync(tmp) } catch { /* ignore */ } throw e }
  return { size: data.length, sha256: sha.toString('hex'), dir, createdShard: created }
}
function readBlobFile(blobDir, id) {
  let buf
  try { buf = fs.readFileSync(blobFile(blobDir, id)) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
  return parseBlob(buf, id)
}
function* blobFiles(blobDir) {
  let shards
  try { shards = fs.readdirSync(blobDir, { withFileTypes: true }) } catch (e) { if (e.code === 'ENOENT') return; throw e }
  for (const s of shards) {
    if (!s.isDirectory() || !/^[0-9a-f]{2}$/.test(s.name)) continue
    const sd = path.join(blobDir, s.name)
    let files
    try { files = fs.readdirSync(sd, { withFileTypes: true }) } catch { continue }
    for (const f of files) {
      if (!f.isFile()) continue
      yield { name: f.name, file: path.join(sd, f.name), isTmp: f.name.startsWith('.') && f.name.endsWith('.tmp') }
    }
  }
}
/** Wraps blobs written by the pre-WAL engine (flat blobs/<id> files without checksum) into the new format. */
function migrateLegacyBlobs(blobDir, log, sync) {
  let entries
  try { entries = fs.readdirSync(blobDir, { withFileTypes: true }) } catch { return 0 }
  let n = 0
  for (const e of entries) {
    if (!e.isFile()) continue
    if (!BLOB_ID_RE.test(e.name)) { log.warn(`ignoring unexpected file in blobs/: ${e.name}`); continue }
    const flat = path.join(blobDir, e.name)
    const data = fs.readFileSync(flat)
    writeBlobFile(blobDir, e.name, data, sync)
    fs.unlinkSync(flat)
    n++
  }
  if (n) log.info(`migrated ${n} legacy blob(s) to the checksummed layout`)
  return n
}

// ---------------------------------------------------------------------------------------------
// Legacy db.json migration
// ---------------------------------------------------------------------------------------------
function uniqueName(file) {
  if (!fs.existsSync(file)) return file
  return `${file}.${stamp()}`
}
function migrateLegacyDb(dir, cfg, log, newId) {
  const legacy = path.join(dir, 'db.json')
  if (!fs.existsSync(legacy)) return null
  const scan = scanDir(dir)
  if (scan.snapshots.length || scan.wals.length) {
    const aside = uniqueName(`${legacy}.ignored`)
    log.warn(`legacy db.json found next to engine data; ignoring it (renamed to ${path.basename(aside)}). If it is a completed migration this is expected.`)
    fs.renameSync(legacy, aside)
    return null
  }
  let parsed
  try { parsed = JSON.parse(fs.readFileSync(legacy, 'utf8')) } catch (e) {
    throw new DbCorruptionError(`legacy ${legacy} is not valid JSON (${e.message}). Refusing to start; fix or move the file`, { file: legacy })
  }
  if (!isObj(parsed)) throw new DbCorruptionError(`legacy ${legacy} must contain a JSON object of collections`, { file: legacy })
  const store = new Store()
  for (const name of CORE_COLLECTIONS) store.cols.set(name, new Map())
  let rows = 0
  let dropped = 0
  for (const [name, list] of Object.entries(parsed)) {
    if (!COL_RE.test(name) || !Array.isArray(list)) { log.warn(`legacy migration: skipping "${name}" (not a collection)`); dropped++; continue }
    if (!store.cols.has(name)) store.cols.set(name, new Map())
    for (const row of list) {
      if (!isObj(row)) { dropped++; continue }
      if (row.id === undefined || row.id === null) row.id = newId(name.slice(0, 3))
      try { store.insertRow(name, row); rows++ } catch (e) { dropped++; log.warn(`legacy migration: dropping a row in "${name}": ${e.message}`) }
    }
  }
  const sync = cfg.fsync !== 'never'
  const final = path.join(dir, snapName(1))
  const tmp = `${final}.tmp`
  writeSnapshotFile(tmp, store, { gen: 1, seq: 0 }, sync)
  fs.renameSync(tmp, final)
  if (sync) fsyncDir(dir)
  const aside = uniqueName(`${legacy}.migrated`)
  fs.renameSync(legacy, aside)
  if (sync) fsyncDir(dir)
  log.info(`migrated legacy db.json: ${rows} document(s) in ${store.cols.size} collection(s)${dropped ? `, ${dropped} unusable entr${dropped === 1 ? 'y' : 'ies'} skipped` : ''}; original kept as ${path.basename(aside)}`)
  return { rows, collections: store.cols.size, dropped, backup: aside }
}

// ---------------------------------------------------------------------------------------------
// createDb
// ---------------------------------------------------------------------------------------------
const alwaysTrue = () => true
/** Creates the data dir (mode 0700) if needed and resolves symlinks so every path to it maps to one lock file. */
function resolveDataDir(dataDir) {
  const abs = path.resolve(String(dataDir))
  fs.mkdirSync(abs, { recursive: true, mode: 0o700 })
  if (!fs.statSync(abs).isDirectory()) throw new DbError(`${abs} is not a directory`)
  return fs.realpathSync(abs)
}
const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`

/**
 * createDb(dataDir?, opts?) -> db. Without dataDir the store is purely in-memory.
 * opts: { fsync, fsyncIntervalMs, compactMinBytes, keepGenerations, lockLeaseMs, blobMaxBytes, snapshotOnClose,
 *         forceUnlock, recover, logger, onFatal }  (each also settable via RD_* env vars, see docs/storage-engine.md)
 */
export function createDb(dataDir, opts = {}) {
  const cfg = resolveConfig(opts)
  const log = { ...defaultLogger, ...(opts.logger ?? {}) }
  const persistent = Boolean(dataDir)
  const dir = persistent ? resolveDataDir(dataDir) : null
  const blobDir = persistent ? path.join(dir, 'blobs') : null
  const memBlobs = new Map() // in-memory mode: id -> { buf, at }
  const startedAt = Date.now()

  let store = null
  let lock = null
  let heartbeat = null
  let walFd = -1
  let gen = 1
  let seq = 0
  let walBytes = 0
  let walRecords = 0
  let walDirty = false
  let fsyncInFlight = false
  let fsyncTimer = null
  let compactScheduled = false
  let compactBackoffUntil = 0
  let snap = { gen: 0, bytes: 0, seq: 0, rows: 0, createdAt: null, durationMs: null }
  let recovery = null
  let closed = false
  let failed = null
  let tx = null
  const pendingDirs = new Set()
  const counters = {
    inserts: 0, updates: 0, removes: 0, transactions: 0, rollbacks: 0, fsyncs: 0, lastFsyncAt: null,
    compactions: 0, lastCompactionAt: null, lastCompactionMs: null, lastCompactionError: null, blobPuts: 0, blobGets: 0, blobDeletes: 0,
  }
  let blobStats = null // lazily initialised { count, bytes }

  // ----- failure handling ---------------------------------------------------------------------
  function fail(msg, err) {
    if (failed) return
    failed = new DbError(`storage engine failed: ${msg}`, 'EDBFAILED')
    if (err) failed.cause = err
    log.error(`${failed.message}${err ? ` (${err.message})` : ''}; refusing further writes, restart required`)
    clearTimeout(fsyncTimer)
    clearInterval(heartbeat)
    try { opts.onFatal?.(failed) } catch { /* ignore */ }
  }
  function assertWritable() {
    if (closed) throw new DbError('database is closed', 'EDBCLOSED')
    if (failed) throw failed
  }

  // ----- durability ---------------------------------------------------------------------------
  function flushPendingDirs() {
    for (const d of pendingDirs) { try { fsyncDir(d) } catch (e) { fail('directory fsync failed', e); throw e } }
    pendingDirs.clear()
  }
  function syncNow() {
    if (!persistent || walFd < 0) return
    try {
      flushPendingDirs()
      if (walDirty || fsyncInFlight) {
        fs.fsyncSync(walFd)
        walDirty = false
        counters.fsyncs++
        counters.lastFsyncAt = Date.now()
      }
    } catch (e) {
      fail('fsync of the write-ahead log failed', e)
      throw e
    }
  }
  function scheduleFsync() {
    if (fsyncTimer || cfg.fsync !== 'batch') return
    fsyncTimer = setTimeout(() => {
      fsyncTimer = null
      if (closed || failed || walFd < 0 || !walDirty) return
      try { flushPendingDirs() } catch { return }
      const fd = walFd
      walDirty = false
      fsyncInFlight = true
      fs.fsync(fd, (err) => {
        fsyncInFlight = false
        if (fd !== walFd || closed) return
        if (err) return fail('fsync of the write-ahead log failed', err)
        counters.fsyncs++
        counters.lastFsyncAt = Date.now()
        if (walDirty) scheduleFsync()
      })
    }, cfg.fsyncIntervalMs)
    fsyncTimer.unref?.()
  }
  function markDirDirty(d) {
    if (cfg.fsync === 'always') fsyncDir(d)
    else if (cfg.fsync === 'batch') { pendingDirs.add(d); scheduleFsync() }
  }

  // ----- WAL ----------------------------------------------------------------------------------
  function writeWal(line) {
    try { writeAll(walFd, line) } catch (e) {
      try { fs.ftruncateSync(walFd, walBytes) } catch (e2) { fail('log write failed and the partial record could not be removed', e2) }
      throw e
    }
    walBytes += line.length
    walRecords++
    walDirty = true
    if (cfg.fsync === 'always') {
      try { fs.fsyncSync(walFd); walDirty = false; counters.fsyncs++; counters.lastFsyncAt = Date.now() } catch (e) { fail('fsync of the write-ahead log failed', e); throw e }
    } else if (cfg.fsync === 'batch') scheduleFsync()
  }
  /** Appends one record (json is an op object serialised as `{...}`); assigns the next sequence number. */
  function appendRecord(json) {
    const s = seq + 1
    if (persistent) {
      const line = encodeLine(`{"s":${s},${json.slice(1)}`)
      if (line.length > MAX_RECORD_BYTES + 64) throw new RangeError(`record too large (${line.length} bytes, max ${MAX_RECORD_BYTES})`)
      writeWal(line)
    }
    seq = s
  }
  // compact once the log outgrows the snapshot (amortised O(1) per byte), but never before MIN and never beyond MAX (bounds replay time)
  const compactThreshold = () => Math.min(Math.max(cfg.compactMinBytes, snap.bytes), Math.max(cfg.compactMinBytes, cfg.compactMaxBytes))
  function afterAppend() {
    if (!persistent || walBytes < compactThreshold() || Date.now() < compactBackoffUntil) return
    if (walBytes >= compactThreshold() * 4) { try { compact() } catch { /* logged + backoff in compact() */ } return }
    if (compactScheduled) return
    compactScheduled = true
    setImmediate(() => {
      compactScheduled = false
      if (closed || failed || tx || walBytes < compactThreshold()) return // already compacted since this was scheduled
      try { compact() } catch { /* logged + backoff in compact() */ }
    }).unref?.()
  }
  function commit(op) {
    assertWritable()
    const json = JSON.stringify(op)
    if (json.length > MAX_RECORD_BYTES) throw new RangeError(`record too large (${json.length} bytes, max ${MAX_RECORD_BYTES})`)
    if (tx) {
      tx.bytes += json.length
      if (tx.bytes > MAX_RECORD_BYTES) throw new RangeError(`transaction too large (max ${MAX_RECORD_BYTES} bytes)`)
      const res = store.applyOp(op, tx.undo)
      tx.parts.push(json)
      return res
    }
    appendRecord(json)
    let res
    try { res = store.applyOp(op) } catch (e) { fail('a logged operation could not be applied in memory', e); throw e }
    afterAppend()
    return res
  }

  // ----- compaction ---------------------------------------------------------------------------
  function pruneGenerations() {
    const scan = scanDir(dir)
    const snaps = [...scan.snapshots].sort((a, b) => b.gen - a.gen)
    const keep = snaps.slice(0, cfg.keepGenerations)
    const minGen = keep.length ? keep[keep.length - 1].gen : 0
    for (const s of snaps.slice(keep.length)) fs.rmSync(s.file, { force: true })
    for (const w of scan.wals) if (w.gen < minGen && w.gen !== gen) fs.rmSync(w.file, { force: true })
  }
  function compact() {
    if (!persistent) return null
    assertWritable()
    if (tx) throw new DbError('cannot compact inside a transaction')
    const t0 = process.hrtime.bigint()
    const sync = cfg.fsync !== 'never'
    const newGen = gen + 1
    const snapTmp = path.join(dir, `${snapName(newGen)}.tmp`)
    try {
      syncNow()
      // 1. start the next log first, so a failure below leaves a valid chain (old snapshot + wal-N + wal-N+1)
      const newWal = path.join(dir, walName(newGen))
      const nfd = fs.openSync(newWal, 'wx', 0o600)
      try {
        writeAll(nfd, walHeaderLine(newGen, seq, seq === 0 && store.count() === 0))
        if (sync) { fs.fsyncSync(nfd); fsyncDir(dir) }
      } catch (e) { try { fs.closeSync(nfd) } catch { /* ignore */ } try { fs.unlinkSync(newWal) } catch { /* ignore */ } throw e }
      const oldFd = walFd
      walFd = nfd
      gen = newGen
      walBytes = fs.fstatSync(nfd).size
      walRecords = 0
      try { fs.closeSync(oldFd) } catch { /* ignore */ }
      // 2. write the snapshot of the state at this sequence: tmp + fsync + rename + dir fsync
      const info = writeSnapshotFile(snapTmp, store, { gen: newGen, seq }, sync)
      fs.renameSync(snapTmp, path.join(dir, snapName(newGen)))
      if (sync) fsyncDir(dir)
      snap = { gen: newGen, bytes: info.bytes, seq, rows: info.rows, createdAt: new Date().toISOString(), durationMs: null }
      pruneGenerations()
      const ms = Number(process.hrtime.bigint() - t0) / 1e6
      snap.durationMs = Math.round(ms * 100) / 100
      counters.compactions++
      counters.lastCompactionAt = Date.now()
      counters.lastCompactionMs = snap.durationMs
      counters.lastCompactionError = null
      return { gen: newGen, snapshotBytes: info.bytes, rows: info.rows, durationMs: snap.durationMs }
    } catch (e) {
      counters.lastCompactionError = e.message
      compactBackoffUntil = Date.now() + 30_000
      log.error(`compaction failed (will retry later): ${e.message}`)
      try { fs.rmSync(snapTmp, { force: true }) } catch { /* ignore */ }
      throw e
    }
  }

  // ----- open ---------------------------------------------------------------------------------
  function applyRecoveryActions(st) {
    for (const a of st.actions) {
      if (a.type === 'truncate') {
        if (a.preserve) {
          const keep = `${a.file}.corrupt-${stamp()}`
          const src = fs.openSync(a.file, 'r')
          try {
            const len = Math.min(a.bytes, 64 * 1024 * 1024)
            const buf = Buffer.alloc(len)
            fs.readSync(src, buf, 0, len, a.at)
            fs.writeFileSync(keep, buf, { mode: 0o600 })
          } finally { fs.closeSync(src) }
          log.warn(`discarded log bytes preserved in ${path.basename(keep)}`)
        }
        const fd = fs.openSync(a.file, 'r+')
        try { fs.ftruncateSync(fd, a.at); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      } else if (a.type === 'quarantine') {
        fs.renameSync(a.file, `${a.file}.corrupt-${stamp()}`)
      }
    }
    if (st.actions.length) fsyncDir(dir)
  }
  function openPersistent() {
    lock = acquireLock(dir, cfg, log)
    const t0 = process.hrtime.bigint()
    try {
      for (const t of scanDir(dir).tmp) { try { fs.rmSync(t, { force: true }) } catch { /* ignore */ } }
      const migrated = migrateLegacyDb(dir, cfg, log, newId)
      const st = loadState(dir, { recover: cfg.recover })
      for (const w of st.warnings) log.warn(w)
      applyRecoveryActions(st)
      store = st.store
      for (const name of CORE_COLLECTIONS) if (!store.cols.has(name)) store.cols.set(name, new Map())
      seq = st.seq
      gen = st.activeGen
      const walPath = path.join(dir, walName(gen))
      const sync = cfg.fsync !== 'never'
      walFd = fs.openSync(walPath, 'a', 0o600)
      if (st.needsNewline) writeAll(walFd, NL)
      if (st.needsHeader || fs.fstatSync(walFd).size === 0) { writeAll(walFd, walHeaderLine(gen, seq, seq === 0 && store.count() === 0)); if (sync) { fs.fsyncSync(walFd); fsyncDir(dir) } }
      else if (st.needsNewline && sync) fs.fsyncSync(walFd)
      walBytes = fs.fstatSync(walFd).size
      walRecords = st.activeRecords
      if (st.snapshot) snap = { gen: st.snapshot.gen, bytes: st.snapshot.bytes, seq: st.snapshot.seq, rows: st.snapshot.rows, createdAt: st.snapshot.createdAt, durationMs: null }
      fs.mkdirSync(blobDir, { recursive: true, mode: 0o700 })
      const legacyBlobs = migrateLegacyBlobs(blobDir, log, sync)
      recovery = {
        durationMs: Math.round(Number(process.hrtime.bigint() - t0) / 1e4) / 100,
        replayedRecords: st.replayed,
        tornTailBytes: st.tornBytes,
        quarantined: st.actions.filter((a) => a.type === 'quarantine').length,
        fellBackToOlderSnapshot: st.fellBack,
        migratedLegacyDb: migrated,
        migratedLegacyBlobs: legacyBlobs,
        truncatedCorruption: st.actions.some((a) => a.kind === 'corruption'),
      }
      if (st.replayed || st.tornBytes || st.fellBack) log.info(`recovered: ${st.replayed} log record(s) replayed${st.tornBytes ? `, ${st.tornBytes} torn byte(s) discarded` : ''}${st.fellBack ? ', fell back to an older snapshot' : ''} in ${recovery.durationMs}ms`)
      lock.setOnExit(() => { if (walFd >= 0 && !closed) { try { fs.fsyncSync(walFd) } catch { /* ignore */ } } })
      const hb = Math.max(250, Math.floor(cfg.lockLeaseMs / 3))
      heartbeat = setInterval(() => {
        try {
          if (!lock.verify()) return fail('lost the data directory lock (another process took it over)')
          lock.touch()
        } catch (e) { log.warn(`lock heartbeat failed: ${e.message}`) }
      }, hb)
      heartbeat.unref?.()
      if (st.fellBack) compact() // re-anchor on a good snapshot right away
      else afterAppend()
    } catch (e) {
      try { if (walFd >= 0) fs.closeSync(walFd) } catch { /* ignore */ }
      walFd = -1
      clearInterval(heartbeat)
      lock.release()
      lock = null
      throw e
    }
  }
  if (persistent) openPersistent()
  else {
    store = new Store()
    for (const name of CORE_COLLECTIONS) store.cols.set(name, new Map())
  }

  // ----- document API -------------------------------------------------------------------------
  function ensureBlobStats() {
    if (blobStats) return blobStats
    blobStats = { count: 0, bytes: 0 }
    if (!persistent) { for (const b of memBlobs.values()) { blobStats.count++; blobStats.bytes += b.buf.length }; return blobStats }
    for (const f of blobFiles(blobDir)) {
      if (f.isTmp) continue
      try { blobStats.count++; blobStats.bytes += Math.max(0, fs.statSync(f.file).size - BLOB_HEADER) } catch { blobStats.count-- }
    }
    return blobStats
  }
  function runTransaction(fn) {
    if (typeof fn !== 'function') throw new TypeError('transaction(fn) needs a function')
    assertWritable()
    if (tx) { // nested: acts as a savepoint inside the outer transaction
      const mark = { undo: tx.undo.length, parts: tx.parts.length, bytes: tx.bytes }
      try {
        const out = fn()
        if (out && typeof out.then === 'function') { out.then?.(undefined, () => {}); throw new TypeError('transaction callbacks must be synchronous') }
        return out
      } catch (e) {
        while (tx.undo.length > mark.undo) tx.undo.pop()()
        tx.parts.length = mark.parts
        tx.bytes = mark.bytes
        store.settleReorders()
        throw e
      }
    }
    tx = { undo: [], parts: [], bytes: 0 }
    let out
    try {
      out = fn()
      if (out && typeof out.then === 'function') { out.then?.(undefined, () => {}); throw new TypeError('transaction callbacks must be synchronous') }
      if (tx.parts.length) appendRecord(`{"o":"t","ops":[${tx.parts.join(',')}]}`)
    } catch (e) {
      const t = tx
      tx = null
      while (t.undo.length) t.undo.pop()()
      store.settleReorders()
      counters.rollbacks++
      throw e
    }
    const n = tx.parts.length
    tx = null
    if (n) { counters.transactions++; afterAppend() }
    return out
  }

  function blobCountAdd(deltaCount, deltaBytes) { if (blobStats) { blobStats.count += deltaCount; blobStats.bytes += deltaBytes } }
  function checkBlobId(id) { if (typeof id !== 'string' || !BLOB_ID_RE.test(id)) throw new TypeError(`invalid blob id: ${JSON.stringify(String(id).slice(0, 80))}`) }

  const db = {
    persistent,
    dataDir: dir,
    id(prefix = 'id') {
      if (typeof prefix !== 'string') throw new TypeError('id prefix must be a string')
      return newId(prefix)
    },

    insert(col, doc) {
      checkCol(col)
      if (doc != null && !isObj(doc)) throw new TypeError('document must be an object')
      const now = new Date().toISOString()
      let rid = doc?.id ?? newId(col.slice(0, 3))
      const c = store.cols.get(col)
      if (c && doc?.id === undefined) while (c.has(rid)) rid = newId(col.slice(0, 3))
      const row = { id: rid, createdAt: now, ...doc, id: rid }
      if (row.createdAt === undefined) row.createdAt = now
      store.checkInsert(col, row)
      commit({ o: 'i', c: col, r: row })
      counters.inserts++
      return row
    },
    get: (col, rid) => store.get(col, rid),
    find(col, pred = alwaysTrue) {
      const c = store.cols.get(col)
      const out = []
      if (!c) return out
      let i = 0
      for (const r of c.values()) if (pred(r, i++)) out.push(r)
      return out
    },
    findOne(col, pred) {
      const c = store.cols.get(col)
      if (!c) return null
      let i = 0
      for (const r of c.values()) if (pred(r, i++)) return r
      return null
    },
    count(col, pred) {
      const c = store.cols.get(col)
      if (!c) return 0
      if (!pred) return c.size
      let n = 0
      let i = 0
      for (const r of c.values()) if (pred(r, i++)) n++
      return n
    },
    collections: () => [...store.cols.keys()],
    update(col, rid, patch) {
      const row = store.get(col, rid)
      if (!row) return null
      if (patch != null && !isObj(patch)) throw new TypeError('patch must be an object')
      const set = {}
      const del = []
      if (patch) {
        for (const k of Object.keys(patch)) {
          if (k === 'id' || k === '__proto__' || k === 'updatedAt') continue
          if (patch[k] === undefined) del.push(k)
          else set[k] = patch[k]
        }
      }
      set.updatedAt = new Date().toISOString()
      const op = { o: 'u', c: col, i: rid, p: set }
      if (del.length) op.d = del
      commit(op)
      counters.updates++
      return row
    },
    remove(col, rid) {
      if (!store.get(col, rid)) return false
      commit({ o: 'r', c: col, i: rid })
      counters.removes++
      return true
    },
    removeWhere(col, pred) {
      if (typeof pred !== 'function') throw new TypeError('removeWhere needs a predicate function')
      const c = store.cols.get(col)
      if (!c) return 0
      const ids = []
      let i = 0
      for (const r of c.values()) if (pred(r, i++)) ids.push(r.id)
      if (!ids.length) return 0
      if (ids.length <= REMOVE_CHUNK) commit({ o: 'R', c: col, ids })
      else runTransaction(() => { for (let k = 0; k < ids.length; k += REMOVE_CHUNK) commit({ o: 'R', c: col, ids: ids.slice(k, k + REMOVE_CHUNK) }) })
      counters.removes += ids.length
      return ids.length
    },

    /** Atomic group of writes: one log record (all or nothing after a crash), in-memory rollback if fn throws. fn must be synchronous. */
    transaction: runTransaction,

    // ----- secondary indexes -------------------------------------------------------------
    index(col, field) {
      checkCol(col)
      checkField(field)
      const i = store.ensureIndex(col, field)
      if (!i) throw new RangeError(`too many indexes on "${col}" (max ${MAX_INDEXES_PER_COLLECTION})`)
      return { collection: col, field, keys: i.map.size }
    },
    dropIndex(col, field) { return store.idx.get(col)?.delete(field) ?? false },
    /** Rebuilds an index (or all indexes of a collection), e.g. after mutating indexed fields outside update(). */
    reindex(col, field) {
      const ix = store.idx.get(col)
      if (!ix) return 0
      const fields = field ? [field] : [...ix.keys()]
      for (const f of fields) { ix.delete(f); store.ensureIndex(col, f) }
      return fields.length
    },
    /** Same result as find(col, r => r[field] === value) (including order), O(1) once indexed. Indexes are created on first use. */
    findBy(col, field, value) {
      checkField(field)
      if (field === 'id') { const r = store.get(col, value); return r ? [r] : [] }
      if (!store.cols.has(col) && !store.idx.get(col)?.has(field)) return []
      const i = store.idx.get(col)?.get(field) ?? store.ensureIndex(col, field)
      if (i) return i.lookup(value)
      return db.find(col, (r) => r[field] === value) // index quota exhausted: correct but linear
    },
    findOneBy(col, field, value) { return db.findBy(col, field, value)[0] ?? null },

    // ----- blobs -------------------------------------------------------------------------
    putBlob(bid, data) {
      assertWritable()
      checkBlobId(bid)
      const buf = toBuffer(data)
      if (buf.length > cfg.blobMaxBytes) throw new RangeError(`blob too large (${buf.length} bytes, max ${cfg.blobMaxBytes})`)
      let prev = 0
      let existed = false
      if (!persistent) {
        const old = memBlobs.get(bid)
        if (old) { existed = true; prev = old.buf.length }
        memBlobs.set(bid, { buf: Buffer.from(buf), at: Date.now() })
        counters.blobPuts++
        blobCountAdd(existed ? 0 : 1, buf.length - prev)
        return { id: bid, size: buf.length }
      }
      if (blobStats) { try { prev = fs.statSync(blobFile(blobDir, bid)).size - BLOB_HEADER; existed = true } catch { /* new blob */ } }
      const w = writeBlobFile(blobDir, bid, buf, cfg.fsync !== 'never')
      if (w.createdShard) markDirDirty(blobDir)
      markDirDirty(w.dir)
      counters.blobPuts++
      blobCountAdd(existed ? 0 : 1, buf.length - prev)
      return { id: bid, size: w.size, sha256: w.sha256 }
    },
    /** Buffer | null. Throws BlobCorruptError when the stored bytes fail verification. */
    getBlob(bid) {
      if (typeof bid !== 'string' || !BLOB_ID_RE.test(bid)) return null
      counters.blobGets++
      if (!persistent) return memBlobs.get(bid)?.buf ?? null
      return readBlobFile(blobDir, bid)
    },
    hasBlob(bid) {
      if (typeof bid !== 'string' || !BLOB_ID_RE.test(bid)) return false
      return persistent ? fs.existsSync(blobFile(blobDir, bid)) : memBlobs.has(bid)
    },
    /** Size/checksum from the header only (does not read or verify the payload). */
    statBlob(bid) {
      if (typeof bid !== 'string' || !BLOB_ID_RE.test(bid)) return null
      if (!persistent) { const b = memBlobs.get(bid); return b ? { id: bid, size: b.buf.length, sha256: crypto.createHash('sha256').update(b.buf).digest('hex'), mtimeMs: b.at } : null }
      let fd
      try {
        fd = fs.openSync(blobFile(blobDir, bid), 'r')
        const h = Buffer.alloc(BLOB_HEADER)
        const n = fs.readSync(fd, h, 0, BLOB_HEADER, 0)
        const st = fs.fstatSync(fd)
        if (n < BLOB_HEADER || !h.subarray(0, 4).equals(BLOB_MAGIC)) throw new BlobCorruptError(bid, 'missing or damaged header')
        return { id: bid, size: Number(h.readBigUInt64BE(4)), sha256: h.subarray(12).toString('hex'), mtimeMs: st.mtimeMs }
      } catch (e) { if (e.code === 'ENOENT') return null; throw e } finally { if (fd !== undefined) fs.closeSync(fd) }
    },
    deleteBlob(bid) {
      if (typeof bid !== 'string' || !BLOB_ID_RE.test(bid)) return false
      if (!persistent) { const old = memBlobs.get(bid); if (!old) return false; memBlobs.delete(bid); blobCountAdd(-1, -old.buf.length); counters.blobDeletes++; return true }
      assertWritable()
      const p = blobFile(blobDir, bid)
      let size = 0
      if (blobStats) { try { size = fs.statSync(p).size - BLOB_HEADER } catch { return false } }
      try { fs.unlinkSync(p) } catch (e) { if (e.code === 'ENOENT') return false; throw e }
      counters.blobDeletes++
      blobCountAdd(-1, -size)
      return true
    },
    listBlobs() {
      const out = []
      if (!persistent) { for (const [id, b] of memBlobs) out.push({ id, size: b.buf.length, mtimeMs: b.at }); return out }
      for (const f of blobFiles(blobDir)) {
        if (f.isTmp || !BLOB_ID_RE.test(f.name)) continue
        try { const st = fs.statSync(f.file); out.push({ id: f.name, size: Math.max(0, st.size - BLOB_HEADER), mtimeMs: st.mtimeMs }) } catch { /* deleted meanwhile */ }
      }
      return out
    },
    /** Reads every blob and verifies its checksum. Returns { checked, bytes, corrupt: [{id, reason}] }. */
    verifyBlobs() {
      const res = { checked: 0, bytes: 0, corrupt: [] }
      if (!persistent) { res.checked = memBlobs.size; for (const b of memBlobs.values()) res.bytes += b.buf.length; return res }
      for (const f of blobFiles(blobDir)) {
        if (f.isTmp || !BLOB_ID_RE.test(f.name)) continue
        try { res.bytes += parseBlob(fs.readFileSync(f.file), f.name).length; res.checked++ } catch (e) {
          if (e instanceof BlobCorruptError) { res.checked++; res.corrupt.push({ id: f.name, reason: e.details.reason }) } else if (e.code !== 'ENOENT') throw e
        }
      }
      return res
    },
    /**
     * Deletes blobs that isReferenced(blobId) reports as unreferenced AND that are older than graceMs (protects a
     * blob that was uploaded but whose row is not inserted yet). isReferenced MUST return a boolean; anything else
     * aborts before deleting. The engine never runs this on its own: it cannot know where modules store blob ids.
     */
    gcBlobs(isReferenced, { graceMs = 300_000, dryRun = false } = {}) {
      if (typeof isReferenced !== 'function') throw new TypeError('gcBlobs(isReferenced) needs a function returning true for referenced blob ids')
      if (!dryRun) assertWritable()
      const now = Date.now()
      const res = { scanned: 0, referenced: 0, removed: 0, removedBytes: 0, skippedRecent: 0, staleTmpRemoved: 0, dryRun, candidates: [] }
      const doomed = []
      const consider = (id, size, mtimeMs) => {
        res.scanned++
        const ref = isReferenced(id)
        if (typeof ref !== 'boolean') throw new TypeError(`gcBlobs: isReferenced must return a boolean (got ${typeof ref} for "${id}"); nothing was deleted`)
        if (ref) { res.referenced++; return }
        if (now - mtimeMs < graceMs) { res.skippedRecent++; return }
        doomed.push({ id, size })
      }
      if (!persistent) for (const [id, b] of memBlobs) consider(id, b.buf.length, b.at)
      else {
        for (const f of blobFiles(blobDir)) {
          let st
          try { st = fs.statSync(f.file) } catch { continue }
          if (f.isTmp) {
            if (now - st.mtimeMs > 3_600_000) { res.candidates.push(f.name); if (!dryRun) { try { fs.unlinkSync(f.file); res.staleTmpRemoved++ } catch { /* ignore */ } } }
            continue
          }
          if (!BLOB_ID_RE.test(f.name)) continue
          consider(f.name, Math.max(0, st.size - BLOB_HEADER), st.mtimeMs)
        }
      }
      for (const d of doomed) {
        res.candidates.push(d.id)
        if (dryRun) continue
        if (db.deleteBlob(d.id)) { res.removed++; res.removedBytes += d.size }
      }
      if (dryRun) { res.removed = doomed.length; res.removedBytes = doomed.reduce((s, d) => s + d.size, 0) }
      return res
    },

    // ----- durability / lifecycle --------------------------------------------------------
    /** Makes every acknowledged write durable now (fsync). */
    flush() {
      if (!persistent || closed || walFd < 0) return
      if (failed) throw failed
      syncNow()
    },
    /** Writes a snapshot and starts a fresh log. Normally automatic. */
    compact,
    /** Flushes, writes a final snapshot (if there were writes), stops timers and releases the lock. Idempotent. */
    close() {
      if (closed) return
      if (!persistent) { closed = true; return }
      clearTimeout(fsyncTimer)
      clearInterval(heartbeat)
      try {
        if (!failed) {
          if (tx) throw new DbError('close() called inside a transaction')
          syncNow()
          if (cfg.snapshotOnClose && walRecords > 0) compact()
        }
      } catch (e) {
        log.error(`error while closing: ${e.message}`)
      }
      closed = true
      try { if (walFd >= 0) fs.closeSync(walFd) } catch { /* ignore */ }
      walFd = -1
      lock?.release()
      lock = null
    },
    health: () => ({ ok: !failed && !closed, closed, failed: failed ? failed.message : null }),

    stats() {
      const collections = {}
      for (const [name, m] of store.cols) collections[name] = { count: m.size, indexes: [...(store.idx.get(name)?.keys() ?? [])] }
      const b = ensureBlobStats()
      return {
        mode: persistent ? 'persistent' : 'memory',
        dataDir: dir,
        fsync: persistent ? cfg.fsync : null,
        uptimeMs: Date.now() - startedAt,
        collections,
        totals: { collections: store.cols.size, docs: store.count() },
        writes: { inserts: counters.inserts, updates: counters.updates, removes: counters.removes, transactions: counters.transactions, rollbacks: counters.rollbacks },
        wal: persistent ? { gen, seq, bytes: walBytes, records: walRecords, fsyncs: counters.fsyncs, lastFsyncAt: counters.lastFsyncAt, pendingFsync: walDirty || fsyncInFlight, compactThresholdBytes: compactThreshold() } : null,
        snapshot: persistent ? { ...snap } : null,
        compactions: { count: counters.compactions, lastAt: counters.lastCompactionAt, lastDurationMs: counters.lastCompactionMs, lastError: counters.lastCompactionError },
        blobs: { count: b.count, bytes: b.bytes, puts: counters.blobPuts, gets: counters.blobGets, deletes: counters.blobDeletes },
        recovery,
        lock: lock ? { pid: lock.info.pid, host: lock.info.host, since: lock.info.startedAt } : null,
        health: { ok: !failed && !closed, closed, failed: failed ? failed.message : null },
      }
    },

    /**
     * Writes a consistent, independently openable copy of the current state into destDir (empty or new):
     * snapshot + empty log + every blob (checksum-verified) + MANIFEST.json. Synchronous: blocks while it runs.
     * { link: true } hard-links blobs instead of copying (same filesystem only; protects against deletes, not disk loss).
     */
    backup(destDir, { link = false } = {}) {
      if (tx) throw new DbError('cannot back up inside a transaction')
      if (!persistent) { /* in-memory databases can be exported too */ } else { assertWritable(); syncNow() }
      return writeBackup(path.resolve(String(destDir)), {
        store,
        seq,
        srcDir: dir,
        link,
        blobs: () => (persistent ? Array.from(blobFiles(blobDir)).filter((f) => !f.isTmp && BLOB_ID_RE.test(f.name)).map((f) => ({ id: f.name, read: () => fs.readFileSync(f.file), file: f.file })) : [...memBlobs].map(([id, b]) => ({ id, read: () => b.buf, file: null }))),
        verifyBlob: (id, buf) => (persistent ? parseBlob(buf, id) : buf),
      })
    },
  }
  return db
}

// ---------------------------------------------------------------------------------------------
// Backup / verify / restore (also used by scripts/backup.mjs)
// ---------------------------------------------------------------------------------------------
function ensureEmptyDir(dest, what = 'destination') {
  if (fs.existsSync(dest)) {
    if (!fs.statSync(dest).isDirectory()) throw new DbError(`${what} ${dest} exists and is not a directory`)
    if (fs.readdirSync(dest).length) throw new DbError(`${what} ${dest} is not empty`)
  } else fs.mkdirSync(dest, { recursive: true, mode: 0o700 })
}
function writeManifest(dest, extra) {
  const m = { format: 'rd-backup', version: 1, createdAt: new Date().toISOString(), ...extra }
  atomicWriteFile(path.join(dest, 'MANIFEST.json'), JSON.stringify(m, null, 2) + '\n')
  return m
}

/** Files other modules keep in the data dir (e.g. secret.key) belong in a backup too; engine files, locks and temp files do not. */
const EXTRA_SKIP_RE = /^(LOCK(\.claim)?|MANIFEST\.json|blobs|snapshot-\d{10}\.rds|wal-\d{10}\.log|db\.json\.(migrated|ignored).*|.*\.tmp|.*\.corrupt-.*|.*\.pre-restore-.*|.*\.restoring-.*)$/
function copyExtras(src, dest) {
  let n = 0
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXTRA_SKIP_RE.test(e.name) || e.isSymbolicLink() || !(e.isFile() || e.isDirectory())) continue
    fs.cpSync(path.join(src, e.name), path.join(dest, e.name), { recursive: true, filter: (f) => !fs.lstatSync(f).isSymbolicLink() && !f.endsWith('.tmp') })
    n++
  }
  return n
}

function writeBackup(dest, { store, seq, srcDir, link, blobs, verifyBlob }) {
  if (srcDir && (dest === srcDir || dest.startsWith(srcDir + path.sep))) throw new DbError('backup destination must be outside the data directory')
  ensureEmptyDir(dest)
  const t0 = Date.now()
  const problems = []
  const snapFile = path.join(dest, snapName(1))
  const info = writeSnapshotFile(`${snapFile}.tmp`, store, { gen: 1, seq }, true)
  fs.renameSync(`${snapFile}.tmp`, snapFile)
  atomicWriteFile(path.join(dest, walName(1)), walHeaderLine(1, seq, false))
  let count = 0
  let bytes = 0
  const blobDest = path.join(dest, 'blobs')
  fs.mkdirSync(blobDest, { recursive: true, mode: 0o700 })
  for (const b of blobs()) {
    try {
      const buf = b.read()
      const payload = verifyBlob(b.id, buf)
      if (link && b.file) {
        const d = path.join(blobDest, shardOf(b.id))
        fs.mkdirSync(d, { recursive: true, mode: 0o700 })
        fs.linkSync(b.file, path.join(d, b.id))
      } else writeBlobFile(blobDest, b.id, payload, true)
      count++
      bytes += payload.length
    } catch (e) {
      if (e instanceof BlobCorruptError) problems.push({ blob: b.id, error: e.message })
      else if (e.code === 'ENOENT') continue
      else throw e
    }
  }
  for (const f of fs.readdirSync(blobDest)) fsyncDir(path.join(blobDest, f))
  fsyncDir(blobDest)
  const extras = srcDir ? copyExtras(srcDir, dest) : 0
  const collections = Object.fromEntries([...store.cols].map(([k, m]) => [k, m.size]))
  const manifest = writeManifest(dest, {
    seq, collections, docs: info.rows, snapshot: { file: snapName(1), bytes: info.bytes },
    blobs: { count, bytes }, extraFiles: extras, problems,
  })
  fsyncDir(dest)
  return { dest, ok: problems.length === 0, docs: info.rows, blobs: count, blobBytes: bytes, problems, durationMs: Date.now() - t0, manifest }
}

/** Read-only integrity check of a data dir or backup dir. Never modifies anything. */
export function verifyDataDir(dir, { blobs = true } = {}) {
  dir = path.resolve(String(dir))
  const rep = { ok: true, dir, errors: [], warnings: [], snapshots: [], wals: [], collections: {}, docs: 0, seq: 0, blobs: null, manifest: null, lock: null }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    rep.ok = false
    rep.errors.push(`${dir} is not a directory`)
    return rep
  }
  const scan = scanDir(dir)
  const lockState = inspectLock(path.join(dir, 'LOCK'), resolveConfig({}))
  if (lockState.info) {
    rep.lock = { pid: lockState.info.pid, host: lockState.info.host, startedAt: lockState.info.startedAt, live: lockState.state === 'live' }
    rep.warnings.push(lockState.state === 'live'
      ? `directory is in use by pid ${lockState.info.pid}@${lockState.info.host}; the log tail may be mid-write`
      : `stale lock from a process that is gone (${lockState.reason}); it is cleared on next start`)
  }
  if (fs.existsSync(path.join(dir, 'db.json'))) rep.warnings.push('legacy db.json present (not yet migrated; it will be on first server start)')
  if (!scan.snapshots.length && !scan.wals.length && !fs.existsSync(path.join(dir, 'db.json'))) rep.warnings.push('no snapshot or log files found: the database is empty')
  try {
    const st = loadState(dir, {})
    for (const s of scan.snapshots) {
      if (st.snapshotReport.some((r) => r.gen === s.gen)) continue
      try { const x = loadSnapshotFile(s.file, s.gen); st.snapshotReport.push({ file: s.name, gen: s.gen, ok: true, rows: x.rows, seq: x.seq, bytes: x.bytes }) } catch (e) { st.snapshotReport.push({ file: s.name, gen: s.gen, ok: false, error: e.message }) }
    }
    rep.snapshots = st.snapshotReport.sort((a, b) => a.gen - b.gen)
    rep.wals = st.walReport
    for (const s of rep.snapshots) if (!s.ok) rep.errors.push(`snapshot ${s.file}: ${s.error}`)
    for (const a of st.actions) if (a.type === 'truncate') rep.warnings.push(`${path.basename(a.file)}: ${a.bytes} byte(s) of ${a.kind} at offset ${a.at} would be discarded on open (${a.reason})`)
    rep.seq = st.seq
    for (const [k, m] of st.store.cols) rep.collections[k] = m.size
    rep.docs = st.store.count()
  } catch (e) {
    if (!(e instanceof DbCorruptionError)) throw e
    rep.errors.push(e.message)
  }
  const mp = path.join(dir, 'MANIFEST.json')
  if (fs.existsSync(mp)) {
    try {
      rep.manifest = JSON.parse(fs.readFileSync(mp, 'utf8'))
      if (rep.manifest.format !== 'rd-backup') rep.errors.push('MANIFEST.json is not an rd-backup manifest')
      else if (rep.errors.length === 0 && typeof rep.manifest.docs === 'number' && rep.manifest.docs !== rep.docs) {
        if (rep.manifest.seq === rep.seq) rep.errors.push(`manifest says ${rep.manifest.docs} documents but ${rep.docs} were recovered`)
        else rep.warnings.push(`directory has changed since the manifest was written (seq ${rep.manifest.seq} -> ${rep.seq})`)
      }
      if (rep.manifest.problems?.length) rep.warnings.push(`backup was created with ${rep.manifest.problems.length} unreadable blob(s): ${rep.manifest.problems.map((p) => p.blob).join(', ')}`)
    } catch (e) { rep.errors.push(`MANIFEST.json unreadable: ${e.message}`) }
  }
  const bd = path.join(dir, 'blobs')
  if (blobs && fs.existsSync(bd)) {
    const b = { checked: 0, bytes: 0, corrupt: [], legacyFlat: 0, strayTmp: 0 }
    for (const f of blobFiles(bd)) {
      if (f.isTmp) { b.strayTmp++; continue }
      if (!BLOB_ID_RE.test(f.name)) continue
      try { b.bytes += parseBlob(fs.readFileSync(f.file), f.name).length } catch (e) {
        if (!(e instanceof BlobCorruptError)) throw e
        b.corrupt.push({ id: f.name, reason: e.details.reason })
        rep.errors.push(`blob ${f.name}: ${e.details.reason}`)
      }
      b.checked++
    }
    for (const e of fs.readdirSync(bd, { withFileTypes: true })) if (e.isFile()) b.legacyFlat++
    if (b.legacyFlat) rep.warnings.push(`${b.legacyFlat} legacy un-checksummed blob file(s) in blobs/ (migrated on first server start)`)
    if (b.strayTmp) rep.warnings.push(`${b.strayTmp} leftover temporary blob file(s)`)
    if (rep.manifest?.blobs && typeof rep.manifest.blobs.count === 'number' && rep.manifest.blobs.count !== b.checked) rep.errors.push(`manifest says ${rep.manifest.blobs.count} blobs but ${b.checked} were found`)
    rep.blobs = b
  }
  rep.ok = rep.errors.length === 0
  return rep
}

function copyBlobTree(srcBlobs, destBlobs, { skipExisting = false } = {}) {
  let copied = 0
  for (const f of blobFiles(srcBlobs)) {
    if (f.isTmp || !BLOB_ID_RE.test(f.name)) continue
    const d = path.join(destBlobs, path.basename(path.dirname(f.file)))
    const target = path.join(d, f.name)
    if (skipExisting && fs.existsSync(target)) continue
    fs.mkdirSync(d, { recursive: true, mode: 0o700 })
    try { fs.copyFileSync(f.file, target); fs.chmodSync(target, 0o600); copied++ } catch (e) { if (e.code !== 'ENOENT') throw e }
  }
  return copied
}
/** Copies the engine files of a quiescent or live data dir. Returns the list of copied file names. */
function copyEngineFiles(src, dest) {
  const copied = []
  const scan = scanDir(src)
  // newest snapshots first: retention only keeps files >= the oldest kept generation, so copy snapshots then logs
  for (const s of scan.snapshots) { fs.copyFileSync(s.file, path.join(dest, s.name)); copied.push(s.name) }
  for (const w of scan.wals) { fs.copyFileSync(w.file, path.join(dest, w.name)); copied.push(w.name) }
  for (const n of copied) fs.chmodSync(path.join(dest, n), 0o600)
  return copied
}

/**
 * File-level backup of a data dir. With lock=true (default) it takes the data dir lock, so it refuses to run while
 * a server has the directory open (DbLockedError). With lock=false ("live") it copies while the server is running:
 * snapshots are immutable and the log tolerates a torn tail, so the copy is verified (and a torn tail trimmed)
 * afterwards; blobs are copied twice (before/after the log) to catch uploads that raced the copy.
 */
export function backupDataDir(src, dest, { lock = true, logger } = {}) {
  src = path.resolve(String(src))
  dest = path.resolve(String(dest))
  const log = { ...defaultLogger, ...(logger ?? {}) }
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new DbError(`${src} is not a directory`)
  if (dest === src || dest.startsWith(src + path.sep) || src.startsWith(dest + path.sep)) throw new DbError('source and destination must not be nested')
  ensureEmptyDir(dest)
  let held = null
  if (lock) held = acquireLock(src, resolveConfig({}), log)
  const t0 = Date.now()
  try {
    let lastError = null
    for (let attempt = 0; attempt < (lock ? 1 : 5); attempt++) {
      try {
        for (const f of fs.readdirSync(dest)) fs.rmSync(path.join(dest, f), { recursive: true, force: true })
        const destBlobs = path.join(dest, 'blobs')
        fs.mkdirSync(destBlobs, { recursive: true, mode: 0o700 })
        copyBlobTree(path.join(src, 'blobs'), destBlobs)
        copyEngineFiles(src, dest)
        copyBlobTree(path.join(src, 'blobs'), destBlobs, { skipExisting: true })
        const extras = copyExtras(src, dest)
        // trim a torn tail in the copy so the backup is a clean data dir
        const st = loadState(dest, {})
        for (const a of st.actions) {
          if (a.type !== 'truncate') continue
          const fd = fs.openSync(a.file, 'r+')
          try { fs.ftruncateSync(fd, a.at) } finally { fs.closeSync(fd) }
        }
        if (st.needsNewline) fs.appendFileSync(path.join(dest, walName(st.activeGen)), NL)
        const collections = Object.fromEntries([...st.store.cols].map(([k, m]) => [k, m.size]))
        const rep = verifyDataDir(dest, { blobs: true })
        if (!rep.ok) throw new DbError(`backup verification failed: ${rep.errors.join('; ')}`)
        const manifest = writeManifest(dest, { seq: st.seq, collections, docs: st.store.count(), blobs: { count: rep.blobs?.checked ?? 0, bytes: rep.blobs?.bytes ?? 0 }, extraFiles: extras, problems: [], live: !lock })
        for (const f of fs.readdirSync(dest)) { const p = path.join(dest, f); if (fs.statSync(p).isDirectory()) { for (const s of fs.readdirSync(p)) { const sp = path.join(p, s); if (fs.statSync(sp).isDirectory()) fsyncDir(sp) } fsyncDir(p) } }
        fsyncDir(dest)
        return { dest, ok: true, docs: manifest.docs, blobs: manifest.blobs.count, blobBytes: manifest.blobs.bytes, seq: st.seq, durationMs: Date.now() - t0, live: !lock, manifest }
      } catch (e) {
        lastError = e
        if (lock) break
        sleepSync(100 * (attempt + 1)) // a compaction may have pruned files mid-copy: retry
      }
    }
    throw lastError
  } finally {
    held?.release()
  }
}

/** Verifies a backup, then installs it as a data dir (atomic rename). dest must not exist/empty unless force. */
export function restoreBackup(src, dest, { force = false, logger } = {}) {
  src = path.resolve(String(src))
  dest = path.resolve(String(dest))
  const log = { ...defaultLogger, ...(logger ?? {}) }
  const rep = verifyDataDir(src, { blobs: true })
  if (!rep.ok) throw new DbCorruptionError(`backup ${src} failed verification: ${rep.errors.join('; ')}`, { report: rep })
  if (!rep.manifest) log.warn(`${src} has no MANIFEST.json; restoring it as a plain data directory`)
  if (dest === src || dest.startsWith(src + path.sep) || src.startsWith(dest + path.sep)) throw new DbError('source and destination must not be nested')
  let moved = null
  if (fs.existsSync(dest)) {
    if (!fs.statSync(dest).isDirectory()) throw new DbError(`${dest} exists and is not a directory`)
    if (fs.readdirSync(dest).length) {
      if (!force) throw new DbError(`${dest} is not empty; pass force to move it aside and restore into place`)
      const li = inspectLock(path.join(dest, 'LOCK'), resolveConfig({}))
      if (li.state === 'live') throw new DbLockedError(`${dest} is in use by pid ${li.info?.pid}; stop the server before restoring over it`)
    }
  }
  const staging = `${dest}.restoring-${crypto.randomBytes(4).toString('hex')}`
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 })
  try {
    copyEngineFiles(src, staging)
    copyExtras(src, staging)
    if (fs.existsSync(path.join(src, 'blobs'))) copyBlobTree(path.join(src, 'blobs'), path.join(staging, 'blobs'))
    const check = verifyDataDir(staging, { blobs: true })
    if (!check.ok) throw new DbCorruptionError(`restored copy failed verification: ${check.errors.join('; ')}`)
    if (fs.existsSync(dest) && fs.readdirSync(dest).length) {
      moved = `${dest}.pre-restore-${stamp()}`
      fs.renameSync(dest, moved)
    } else if (fs.existsSync(dest)) fs.rmdirSync(dest)
    fs.renameSync(staging, dest)
    fsyncDir(path.dirname(dest))
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw e
  }
  return { dest, docs: rep.docs, blobs: rep.blobs?.checked ?? 0, previousMovedTo: moved, report: rep }
}
