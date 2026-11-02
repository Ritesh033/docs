// Managed SQL databases on node:sqlite. Every database is a real SQLite file owned by a dedicated, killable child process
// (src/sql-worker.js) running with a scrubbed environment, an address-space limit and a file-size limit.
// User SQL is confined by src/sql-guard.js. See docs/sql.md for the threat model.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HttpError, required } from '../http.js'
import { record } from '../billing.js'
import { parseScript, GuardError, preview } from '../sql-guard.js'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKER = path.join(SRC, 'sql-worker.js')
const envInt = (name, dflt, min, max) => { const n = Number(process.env[name]); return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : dflt }
const CFG = {
  maxDbs: () => envInt('RD_SQL_MAX_DBS', 20, 1, 1000),
  maxDbBytes: () => envInt('RD_SQL_MAX_DB_BYTES', 64 * 1024 * 1024, 1024 * 1024, 8 * 1024 ** 3),
  timeoutMs: () => envInt('RD_SQL_TIMEOUT_MS', 5000, 100, 120_000),
  maxTimeoutMs: () => envInt('RD_SQL_MAX_TIMEOUT_MS', 30_000, 100, 600_000),
  memMb: () => envInt('RD_SQL_MEM_MB', 1536, 256, 16_384),
  maxProcs: () => envInt('RD_SQL_MAX_PROCS', 8, 1, 64),
  idleMs: () => envInt('RD_SQL_IDLE_MS', 30_000, 1000, 3600_000),
  perUser: 3, maxSnapshots: 10, maxHistory: 100, maxSaved: 100, importBytes: 5 * 1024 * 1024, importRows: 100_000,
}
const NAME_RE = /^[a-z][a-z0-9_-]{0,47}$/
const ID_RE = /^sqd_[0-9a-f]{16}$/
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export async function register(r, db, ctx) {
  const by = (col, field, value) => (typeof db.findBy === 'function' ? db.findBy(col, field, value) : db.find(col, (x) => x[field] === value))
  const audit = (userId, action, resource, meta) => { try { ctx.events.emit('audit', { userId, action, resource, meta }) } catch { /* ignore */ } }

  /* ------------------------------------------------------------------ storage layout */
  let baseDir = ctx.config.dataDir ? path.join(ctx.config.dataDir, 'sql') : fs.mkdtempSync(path.join(os.tmpdir(), 'rd-sql-'))
  const ephemeral = !ctx.config.dataDir
  fs.mkdirSync(path.join(baseDir, 'snapshots'), { recursive: true, mode: 0o700 })
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-sqlw-')) // empty cwd for workers
  const fileOf = (id) => { if (!ID_RE.test(id)) throw new HttpError(404, 'Database not found'); return path.join(baseDir, `${id}.sqlite`) }
  const snapPath = (id, sid) => path.join(baseDir, 'snapshots', `${id}-${sid}.sqlite`)

  let permissionFlags = []
  try {
    const probe = await new Promise((resolve) => {
      const c = spawn(process.execPath, ['--permission', '-e', '0'], { stdio: 'ignore' })
      c.on('exit', (code) => resolve(code === 0)); c.on('error', () => resolve(false))
    })
    if (probe && process.env.RD_SQL_NO_PERMISSION !== '1') permissionFlags = ['--permission', `--allow-fs-read=${SRC}`, `--allow-fs-read=${baseDir}`, `--allow-fs-write=${baseDir}`]
  } catch { /* run without the permission model */ }
  const hasSh = fs.existsSync('/bin/sh')

  /* ------------------------------------------------------------------ worker processes */
  const procs = new Map() // dbId -> Proc
  let active = 0
  const waiters = []
  class Proc {
    constructor(id) {
      this.id = id; this.pending = new Map(); this.seq = 0; this.queue = Promise.resolve(); this.busy = 0; this.lastUsed = Date.now(); this.dead = false; this.ready = null; this.stderr = ''
    }
    start() {
      const cfg = JSON.stringify({ maxDbBytes: CFG.maxDbBytes(), snapshotDir: path.join(baseDir, 'snapshots') })
      const nodeArgs = ['--disable-warning=ExperimentalWarning', '--max-old-space-size=96', ...permissionFlags, WORKER, fileOf(this.id), cfg]
      const memKb = CFG.memMb() * 1024
      const fsBlocks = Math.ceil((CFG.maxDbBytes() * 2) / 512) + 1024
      const [cmd, args] = hasSh ? ['/bin/sh', ['-c', 'ulimit -v "$1" 2>/dev/null; ulimit -f "$2" 2>/dev/null; shift 2; exec "$@"', 'sh', String(memKb), String(fsBlocks), process.execPath, ...nodeArgs]] : [process.execPath, nodeArgs]
      const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {}, cwd: workDir })
      this.child = child
      child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-2000) })
      this.ready = new Promise((resolve, reject) => { this._ready = resolve; this._fail = reject })
      child.on('message', (m) => {
        if (m?.type === 'ready') return this._ready()
        const p = this.pending.get(m?.id)
        if (!p) return
        this.pending.delete(m.id); clearTimeout(p.timer)
        m.ok ? p.resolve(m.result) : p.reject(m.error)
      })
      child.on('exit', (code, signal) => {
        this.dead = true
        if (procs.get(this.id) === this) procs.delete(this.id)
        const err = Object.assign(new Error(`The database worker stopped unexpectedly (${signal ?? `exit ${code}`}). A query probably used more memory or disk than allowed.`), { crashed: true })
        this._fail?.(err)
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err) }
        this.pending.clear()
        releaseSlot()
      })
      child.on('error', (e) => this._fail?.(e))
      return this.ready
    }
    kill() {
      // leave the pool immediately: the exit event arrives later and a new query must never be routed to a dying worker
      this.dead = true
      if (procs.get(this.id) === this) procs.delete(this.id)
      try { this.child?.kill('SIGKILL') } catch { /* already gone */ }
    }
    call(msg, timeoutMs) {
      const run = async () => {
        if (this.dead) throw Object.assign(new Error('worker is not running'), { restart: true })
        await this.ready
        return new Promise((resolve, reject) => {
          const id = ++this.seq
          const timer = setTimeout(() => {
            this.pending.delete(id)
            this.kill()
            reject(Object.assign(new Error(`Query exceeded ${timeoutMs} ms and was cancelled`), { timeout: true }))
          }, timeoutMs)
          this.pending.set(id, { resolve, reject, timer })
          this.child.send({ id, ...msg })
        })
      }
      this.busy++
      const p = this.queue.then(run, run).finally(() => { this.busy--; this.lastUsed = Date.now() })
      this.queue = p.catch(() => {})
      return p
    }
  }
  function releaseSlot() { active = Math.max(0, active - 1); const w = waiters.shift(); if (w) w() }

  async function acquire(id) {
    let p = procs.get(id)
    if (p && !p.dead) return p
    // make room: evict idle workers (least recently used) when at the cap
    while (procs.size >= CFG.maxProcs()) {
      const idle = [...procs.values()].filter((x) => !x.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0]
      if (idle) { idle.kill(); procs.delete(idle.id); continue }
      if (waiters.length >= 32) throw new HttpError(503, 'The database service is busy. Retry shortly.')
      await new Promise((res, rej) => { const t = setTimeout(() => rej(new HttpError(503, 'The database service is busy. Retry shortly.')), 5000); waiters.push(() => { clearTimeout(t); res() }) })
      p = procs.get(id)
      if (p && !p.dead) return p
    }
    p = new Proc(id)
    procs.set(id, p)
    active++
    try { await p.start() } catch (e) { procs.delete(id); p.kill(); throw new HttpError(500, `Could not start the database worker: ${p.stderr.split('\n').filter(Boolean).pop() ?? e.message}`.slice(0, 300)) }
    return p
  }

  const userActive = new Map()
  async function callDb(user, row, msg, timeoutMs = CFG.timeoutMs()) {
    const n = userActive.get(user.id) ?? 0
    if (n >= CFG.perUser) throw new HttpError(429, `At most ${CFG.perUser} concurrent queries per user`)
    userActive.set(user.id, n + 1)
    try {
      for (let attempt = 0; ; attempt++) {
        const p = await acquire(row.id)
        try { return await p.call(msg, timeoutMs) } catch (e) {
          if (e?.restart && attempt < 2) continue
          throw e
        }
      }
    } finally { userActive.set(user.id, (userActive.get(user.id) ?? 1) - 1) }
  }
  /** Map worker/process errors to HTTP errors. */
  function mapError(e) {
    if (e instanceof HttpError) return e
    if (e?.timeout) return new HttpError(408, e.message)
    if (e?.crashed) return new HttpError(500, e.message)
    if (e?.kind === 'guard') return new HttpError(400, e.message)
    if (e?.kind === 'sqlite') {
      const full = /database or disk is full|SQLITE_FULL/i.test(e.message)
      return Object.assign(new HttpError(full ? 413 : 400, e.message), { sqlite: true })
    }
    if (e instanceof GuardError) return new HttpError(400, e.message)
    return new HttpError(500, 'Database error')
  }
  const idleTimer = setInterval(() => {
    for (const p of procs.values()) if (!p.busy && Date.now() - p.lastUsed > CFG.idleMs()) { p.kill(); procs.delete(p.id) }
  }, 5000)
  idleTimer.unref?.()
  ctx.events.on('shutdown', () => {
    clearInterval(idleTimer)
    for (const p of procs.values()) p.kill()
    procs.clear()
    try { fs.rmSync(workDir, { recursive: true, force: true }) } catch { /* ignore */ }
    if (ephemeral) try { fs.rmSync(baseDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  /* ------------------------------------------------------------------ helpers */
  const own = (user, id) => {
    const row = typeof id === 'string' && ID_RE.test(id) ? db.get('sql_databases', id) : null
    if (!row || row.userId !== user.id) throw new HttpError(404, 'Database not found')
    return row
  }
  const view = (d) => ({ id: d.id, name: d.name, sizeBytes: d.sizeBytes ?? 0, maxBytes: CFG.maxDbBytes(), createdAt: d.createdAt })
  const timeoutOf = (v) => {
    if (v === undefined || v === null) return CFG.timeoutMs()
    if (!Number.isInteger(v) || v < 100) throw new HttpError(400, 'timeoutMs must be an integer of at least 100')
    return Math.min(v, CFG.maxTimeoutMs())
  }
  const limitOf = (v, dflt, max) => { if (v === undefined) return dflt; if (!Number.isInteger(v) || v < 1 || v > max) throw new HttpError(400, `limit must be 1-${max}`); return v }

  function history(row, user, entry) {
    db.insert('sql_history', { dbId: row.id, userId: user.id, ...entry, ts: Date.now() })
    const rows = by('sql_history', 'dbId', row.id)
    if (rows.length > CFG.maxHistory) for (const o of rows.sort((a, b) => a.ts - b.ts).slice(0, rows.length - CFG.maxHistory)) db.remove('sql_history', o.id)
  }

  async function runSql(user, row, body, { readOnly }) {
    const sql = body.sql
    if (typeof sql !== 'string' || !sql.trim()) throw new HttpError(400, 'sql is required')
    try { parseScript(sql, { readOnly }) } catch (e) { throw new HttpError(400, e.message) } // fail fast in the parent; the worker re-validates
    const t0 = Date.now()
    const maxRows = limitOf(body.maxRows, 1000, 10_000)
    try {
      const out = await callDb(user, row, { op: 'exec', sql, params: body.params, readOnly, transaction: body.transaction === true, maxRows }, timeoutOf(body.timeoutMs))
      if (out.sizeBytes !== undefined && out.sizeBytes !== row.sizeBytes) db.update('sql_databases', row.id, { sizeBytes: out.sizeBytes })
      record(db, user.id, 'sql.query', 1)
      history(row, user, { sql: preview(sql), ok: true, ms: Date.now() - t0, rows: out.results.reduce((s, x) => s + x.rowCount, 0) })
      return out
    } catch (e) {
      const he = mapError(e)
      history(row, user, { sql: preview(sql), ok: false, ms: Date.now() - t0, error: he.message.slice(0, 300) })
      throw he
    }
  }

  /* ------------------------------------------------------------------ database CRUD */
  r.get('/api/sql', ({ user }) => ({ databases: by('sql_databases', 'userId', user.id).sort((a, b) => a.name.localeCompare(b.name)).map(view), limits: { maxDatabases: CFG.maxDbs(), maxDbBytes: CFG.maxDbBytes(), timeoutMs: CFG.timeoutMs() } }))
  r.post('/api/sql', async ({ user, body }) => {
    required(body, 'name')
    if (typeof body.name !== 'string' || !NAME_RE.test(body.name)) throw new HttpError(400, 'Database names are 1-48 characters: lowercase letters, digits, "_" or "-", starting with a letter')
    const mine = by('sql_databases', 'userId', user.id)
    if (mine.length >= CFG.maxDbs()) throw new HttpError(409, `At most ${CFG.maxDbs()} databases`)
    if (mine.some((d) => d.name === body.name)) throw new HttpError(409, 'You already have a database with that name')
    const q = ctx.quotas?.check?.(user.id, 'sql.databases', 1)
    if (q && q.allowed === false) throw new HttpError(402, q.message ?? 'Database limit of your plan reached')
    const row = db.insert('sql_databases', { id: `sqd_${crypto.randomBytes(8).toString('hex')}`, userId: user.id, name: body.name, sizeBytes: 0 })
    try { const out = await callDb(user, row, { op: 'size' }); db.update('sql_databases', row.id, { sizeBytes: out.sizeBytes }) } catch (e) { db.remove('sql_databases', row.id); throw mapError(e) }
    audit(user.id, 'sql.database.create', row.id, { name: row.name })
    return [201, view(db.get('sql_databases', row.id))]
  })
  r.get('/api/sql/:id', ({ user, params }) => view(own(user, params.id)))
  r.delete('/api/sql/:id', ({ user, params }) => {
    const row = own(user, params.id)
    const p = procs.get(row.id); p?.kill(); procs.delete(row.id)
    for (const s of by('sql_snapshots', 'dbId', row.id)) { try { fs.rmSync(snapPath(row.id, s.id)) } catch { /* gone */ } db.remove('sql_snapshots', s.id) }
    for (const ext of ['', '-journal', '-wal', '-shm']) { try { fs.rmSync(fileOf(row.id) + ext, { force: true }) } catch { /* ignore */ } }
    for (const col of ['sql_history', 'sql_saved', 'sql_migrations']) db.removeWhere(col, (x) => x.dbId === row.id)
    db.remove('sql_databases', row.id)
    audit(user.id, 'sql.database.delete', row.id, { name: row.name })
    return { ok: true }
  })

  /* ------------------------------------------------------------------ queries */
  r.post('/api/sql/:id/query', async ({ user, params, body }) => runSql(user, own(user, params.id), body, { readOnly: body.readOnly === true }))
  // Read-only endpoint: usable with read-only API keys (GET). Enforced by the guard AND by PRAGMA query_only in the worker.
  r.get('/api/sql/:id/select', async ({ user, params, query }) => {
    let p
    if (query.get('params')) { try { p = JSON.parse(query.get('params')) } catch { throw new HttpError(400, 'params must be JSON') } }
    return runSql(user, own(user, params.id), { sql: query.get('sql'), params: p, maxRows: query.get('maxRows') ? Number(query.get('maxRows')) : undefined }, { readOnly: true })
  })
  r.post('/api/sql/:id/explain', async ({ user, params, body }) => {
    const row = own(user, params.id)
    if (typeof body.sql !== 'string') throw new HttpError(400, 'sql is required')
    const stmts = (() => { try { return parseScript(body.sql, { readOnly: false }) } catch (e) { throw new HttpError(400, e.message) } })()
    if (stmts.length !== 1) throw new HttpError(400, 'Explain one statement at a time')
    return runSql(user, row, { sql: `EXPLAIN QUERY PLAN ${stmts[0].text}`, params: body.params }, { readOnly: true })
  })

  r.get('/api/sql/:id/schema', async ({ user, params }) => {
    try { return await callDb(user, own(user, params.id), { op: 'schema' }) } catch (e) { throw mapError(e) }
  })
  r.get('/api/sql/:id/tables/:table', async ({ user, params, query }) => {
    try { return await callDb(user, own(user, params.id), { op: 'table', name: params.table, limit: Number(query.get('limit')) || 50, offset: Number(query.get('offset')) || 0 }) } catch (e) { throw mapError(e) }
  })

  /* ------------------------------------------------------------------ history & saved queries */
  r.get('/api/sql/:id/history', ({ user, params }) => ({ history: by('sql_history', 'dbId', own(user, params.id).id).sort((a, b) => b.ts - a.ts).map(({ sql, ok, ms, rows, error, ts }) => ({ sql, ok, ms, rows, error, at: new Date(ts).toISOString() })) }))
  r.delete('/api/sql/:id/history', ({ user, params }) => { const row = own(user, params.id); db.removeWhere('sql_history', (h) => h.dbId === row.id); return { ok: true } })
  r.get('/api/sql/:id/saved', ({ user, params }) => ({ saved: by('sql_saved', 'dbId', own(user, params.id).id).sort((a, b) => a.name.localeCompare(b.name)).map(({ id, name, sql }) => ({ id, name, sql })) }))
  r.post('/api/sql/:id/saved', ({ user, params, body }) => {
    const row = own(user, params.id)
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) throw new HttpError(400, 'name must be 1-80 characters')
    if (typeof body.sql !== 'string' || !body.sql.trim() || body.sql.length > 20_000) throw new HttpError(400, 'sql must be 1-20000 characters')
    if (by('sql_saved', 'dbId', row.id).length >= CFG.maxSaved) throw new HttpError(409, `At most ${CFG.maxSaved} saved queries`)
    const s = db.insert('sql_saved', { dbId: row.id, userId: user.id, name: body.name.trim(), sql: body.sql })
    return [201, { id: s.id, name: s.name, sql: s.sql }]
  })
  r.delete('/api/sql/:id/saved/:sid', ({ user, params }) => {
    const row = own(user, params.id)
    const s = db.get('sql_saved', params.sid)
    if (!s || s.dbId !== row.id) throw new HttpError(404, 'Saved query not found')
    db.remove('sql_saved', s.id)
    return { ok: true }
  })

  /* ------------------------------------------------------------------ import / export */
  function parseCsv(text) {
    const rows = []
    let row = [], field = '', inQ = false, i = 0
    for (; i < text.length; i++) {
      const c = text[i]
      if (inQ) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQ = false } else field += c; continue }
      if (c === '"' && field === '') inQ = true
      else if (c === ',') { row.push(field); field = '' }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; if (rows.length > CFG.importRows + 1) throw new HttpError(413, `At most ${CFG.importRows} rows per import`) }
      else field += c
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row) }
    if (inQ) throw new HttpError(400, 'Unterminated quoted CSV field')
    return rows
  }
  const sanitizeCol = (s, used) => {
    let n = String(s).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'col'
    if (/^[0-9]/.test(n)) n = `c_${n}`
    let out = n, i = 2
    while (used.has(out)) out = `${n}_${i++}`
    used.add(out)
    return out
  }
  function inferType(values) {
    let int = true, real = true, any = false
    for (const v of values) {
      if (v === null || v === '' || v === undefined) continue
      any = true
      const s = String(v)
      if (!/^-?\d{1,15}$/.test(s)) int = false
      if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) || !Number.isFinite(Number(s))) real = false
      if (!int && !real) break
    }
    return !any ? 'TEXT' : int ? 'INTEGER' : real ? 'REAL' : 'TEXT'
  }
  r.post('/api/sql/:id/import', async ({ user, params, query, raw, req }) => {
    const row = own(user, params.id)
    const table = query.get('table') ?? ''
    if (!IDENT_RE.test(table) || /^sqlite_/i.test(table)) throw new HttpError(400, 'table must be an identifier (letters, digits, "_")')
    if (raw.length === 0 || raw.length > CFG.importBytes) throw new HttpError(413, `Import body must be 1 byte to ${CFG.importBytes} bytes`)
    const format = query.get('format') || (String(req.headers['content-type'] ?? '').includes('json') ? 'json' : 'csv')
    const text = raw.toString('utf8')
    let header, data
    if (format === 'json') {
      let arr; try { arr = JSON.parse(text) } catch { throw new HttpError(400, 'Body is not valid JSON') }
      if (!Array.isArray(arr) || !arr.length || arr.some((o) => o === null || typeof o !== 'object' || Array.isArray(o))) throw new HttpError(400, 'JSON import needs a non-empty array of objects')
      if (arr.length > CFG.importRows) throw new HttpError(413, `At most ${CFG.importRows} rows per import`)
      const keys = [...new Set(arr.flatMap((o) => Object.keys(o)))]
      header = keys; data = arr.map((o) => keys.map((k) => (o[k] === undefined || o[k] === null ? null : typeof o[k] === 'object' ? JSON.stringify(o[k]) : typeof o[k] === 'boolean' ? (o[k] ? 1 : 0) : o[k])))
    } else if (format === 'csv') {
      const rows = parseCsv(text)
      if (rows.length < 2) throw new HttpError(400, 'CSV needs a header row and at least one data row')
      header = rows[0]; data = rows.slice(1).map((rw) => header.map((_, i) => (rw[i] === undefined || rw[i] === '' ? null : rw[i])))
    } else throw new HttpError(400, 'format must be csv or json')
    if (header.length > 200) throw new HttpError(400, 'At most 200 columns')
    const used = new Set()
    const names = header.map((h) => sanitizeCol(h, used))
    const columns = names.map((name, i) => ({ name, type: format === 'json' ? inferTypeJson(data.map((rw) => rw[i])) : inferType(data.map((rw) => rw[i])) }))
    const rows = data.map((rw) => rw.map((v, i) => (v === null ? null : columns[i].type === 'INTEGER' || columns[i].type === 'REAL' ? Number(v) : String(v))))
    try {
      const out = await callDb(user, row, { op: 'bulk', table, columns, rows }, Math.max(CFG.timeoutMs(), 15_000))
      db.update('sql_databases', row.id, { sizeBytes: out.sizeBytes })
      record(db, user.id, 'sql.query', 1)
      return [201, { table, columns, inserted: out.inserted }]
    } catch (e) { throw mapError(e) }
  }, { raw: true })
  const inferTypeJson = (vals) => { const nn = vals.filter((v) => v !== null); if (!nn.length) return 'TEXT'; if (nn.every((v) => Number.isInteger(v) && Math.abs(v) < 2 ** 53)) return 'INTEGER'; if (nn.every((v) => typeof v === 'number' && Number.isFinite(v))) return 'REAL'; return 'TEXT' }

  const csvCell = (v) => {
    if (v === null || v === undefined) return ''
    const s = typeof v === 'object' ? (v.$blob !== undefined ? `<blob ${v.bytes} bytes>` : JSON.stringify(v)) : String(v)
    // neutralise spreadsheet formula injection
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s
    return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
  }
  r.get('/api/sql/:id/export', async ({ user, params, query }) => {
    const row = own(user, params.id)
    const format = query.get('format') || 'sql'
    if (!['sql', 'csv', 'json'].includes(format)) throw new HttpError(400, 'format must be sql, csv or json')
    try {
      const out = await callDb(user, row, { op: 'export', format, table: query.get('table') || undefined, sql: query.get('sql') || undefined }, Math.max(CFG.timeoutMs(), 20_000))
      const base = `${row.name}${query.get('table') ? `-${query.get('table')}` : ''}`
      if (format === 'sql') return { text: out.text, type: 'application/sql; charset=utf-8', headers: { 'content-disposition': `attachment; filename="${base}.sql"`, 'x-content-type-options': 'nosniff' } }
      if (!query.get('table') && !query.get('sql')) throw new HttpError(400, 'Provide ?table= or ?sql= for csv/json exports')
      if (format === 'csv') return { text: [out.columns.map(csvCell).join(','), ...out.rows.map((rw) => rw.map(csvCell).join(','))].join('\r\n') + '\r\n', type: 'text/csv; charset=utf-8', headers: { 'content-disposition': `attachment; filename="${base}.csv"`, 'x-content-type-options': 'nosniff' } }
      return { text: JSON.stringify(out.rows.map((rw) => Object.fromEntries(out.columns.map((c, i) => [c, rw[i]])))), type: 'application/json', headers: { 'content-disposition': `attachment; filename="${base}.json"` } }
    } catch (e) { throw mapError(e) }
  })

  /* ------------------------------------------------------------------ snapshots */
  const snapView = (s) => ({ id: s.id, label: s.label, sizeBytes: s.sizeBytes, createdAt: s.createdAt })
  r.get('/api/sql/:id/snapshots', ({ user, params }) => ({ snapshots: by('sql_snapshots', 'dbId', own(user, params.id).id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(snapView) }))
  async function makeSnapshot(user, row, label) {
    const existing = by('sql_snapshots', 'dbId', row.id)
    if (existing.length >= CFG.maxSnapshots) throw new HttpError(409, `At most ${CFG.maxSnapshots} snapshots; delete one first`)
    const s = db.insert('sql_snapshots', { id: `sns_${crypto.randomBytes(6).toString('hex')}`, dbId: row.id, userId: user.id, label: String(label ?? '').slice(0, 80), sizeBytes: 0 })
    try {
      const out = await callDb(user, row, { op: 'snapshot', dest: snapPath(row.id, s.id) }, Math.max(CFG.timeoutMs(), 30_000))
      return db.update('sql_snapshots', s.id, { sizeBytes: out.bytes })
    } catch (e) { db.remove('sql_snapshots', s.id); try { fs.rmSync(snapPath(row.id, s.id), { force: true }) } catch { /* ignore */ } throw mapError(e) }
  }
  r.post('/api/sql/:id/snapshots', async ({ user, params, body }) => [201, snapView(await makeSnapshot(user, own(user, params.id), body.label))])
  r.delete('/api/sql/:id/snapshots/:sid', ({ user, params }) => {
    const row = own(user, params.id)
    const s = db.get('sql_snapshots', params.sid)
    if (!s || s.dbId !== row.id) throw new HttpError(404, 'Snapshot not found')
    try { fs.rmSync(snapPath(row.id, s.id), { force: true }) } catch { /* ignore */ }
    db.remove('sql_snapshots', s.id)
    return { ok: true }
  })
  r.post('/api/sql/:id/snapshots/:sid/restore', async ({ user, params, body }) => {
    const row = own(user, params.id)
    const s = db.get('sql_snapshots', params.sid)
    if (!s || s.dbId !== row.id || !/^sns_[0-9a-f]{12}$/.test(s.id)) throw new HttpError(404, 'Snapshot not found')
    if (body.confirm !== true) throw new HttpError(400, 'Restoring replaces the current data. Send {"confirm": true}.')
    const src = snapPath(row.id, s.id)
    if (!fs.existsSync(src)) throw new HttpError(410, 'Snapshot file is missing')
    // keep a safety copy of the current state (reuse the oldest slot if the limit is reached)
    const all = by('sql_snapshots', 'dbId', row.id)
    if (all.length >= CFG.maxSnapshots) { const oldest = all.filter((x) => x.id !== s.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]; if (oldest) { try { fs.rmSync(snapPath(row.id, oldest.id), { force: true }) } catch { /* ignore */ } db.remove('sql_snapshots', oldest.id) } }
    await makeSnapshot(user, row, `before restore of ${s.label || s.id}`)
    const p = procs.get(row.id); p?.kill(); procs.delete(row.id)
    await new Promise((res) => setTimeout(res, 50))
    const dest = fileOf(row.id), tmp = `${dest}.restore-${process.pid}`
    fs.copyFileSync(src, tmp)
    for (const ext of ['-journal', '-wal', '-shm']) { try { fs.rmSync(dest + ext, { force: true }) } catch { /* ignore */ } }
    fs.renameSync(tmp, dest)
    try {
      const check = await callDb(user, row, { op: 'integrity' })
      if (!check.ok) throw new HttpError(500, 'The restored database failed its integrity check')
      const out = await callDb(user, row, { op: 'size' })
      db.update('sql_databases', row.id, { sizeBytes: out.sizeBytes })
    } catch (e) { throw mapError(e) }
    audit(user.id, 'sql.snapshot.restore', row.id, { snapshot: s.id })
    return { ok: true, restored: s.id }
  })

  /* ------------------------------------------------------------------ migrations */
  const sha = (t) => crypto.createHash('sha256').update(t).digest('hex')
  const migView = (m) => ({ version: m.version, name: m.name, checksum: m.checksum, appliedAt: m.createdAt })
  r.get('/api/sql/:id/migrations', ({ user, params }) => ({ migrations: by('sql_migrations', 'dbId', own(user, params.id).id).sort((a, b) => a.version - b.version).map(migView) }))
  r.post('/api/sql/:id/migrations', async ({ user, params, body }) => {
    const row = own(user, params.id)
    if (!Number.isInteger(body.version) || body.version < 1 || body.version > 1_000_000) throw new HttpError(400, 'version must be a positive integer')
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120) throw new HttpError(400, 'name must be 1-120 characters')
    if (typeof body.sql !== 'string' || !body.sql.trim()) throw new HttpError(400, 'sql is required')
    const checksum = sha(body.sql)
    const existing = by('sql_migrations', 'dbId', row.id).sort((a, b) => a.version - b.version)
    const same = existing.find((m) => m.version === body.version)
    if (same) {
      if (same.checksum !== checksum) throw new HttpError(409, `Migration ${body.version} was already applied with different SQL (checksum drift)`)
      return { ...migView(same), alreadyApplied: true }
    }
    if (existing.length && body.version < existing.at(-1).version) throw new HttpError(409, `Migrations must be applied in order: the latest applied version is ${existing.at(-1).version}`)
    await runSql(user, row, { sql: body.sql, transaction: true }, { readOnly: false })
    const m = db.insert('sql_migrations', { dbId: row.id, userId: user.id, version: body.version, name: body.name.trim(), checksum })
    audit(user.id, 'sql.migration.apply', row.id, { version: body.version })
    return [201, migView(m)]
  })

  ctx.quotas?.registerGauge?.('sql.databases', (userId) => by('sql_databases', 'userId', userId).length)
  ctx.sqlWorkers = { dir: baseDir, permissionModel: permissionFlags.length > 0, count: () => procs.size, killAll: () => { for (const p of procs.values()) p.kill() } }
  ctx.blobRefs?.set?.('sql', function* () { /* SQLite files are not blobs */ })
  ctx.events.on('account.deleted', ({ userId }) => {
    for (const d of by('sql_databases', 'userId', userId)) {
      procs.get(d.id)?.kill(); procs.delete(d.id)
      for (const s of by('sql_snapshots', 'dbId', d.id)) { try { fs.rmSync(snapPath(d.id, s.id), { force: true }) } catch { /* ignore */ } }
      for (const ext of ['', '-journal', '-wal', '-shm']) { try { fs.rmSync(fileOf(d.id) + ext, { force: true }) } catch { /* ignore */ } }
      for (const col of ['sql_history', 'sql_saved', 'sql_migrations', 'sql_snapshots']) db.removeWhere(col, (x) => x.dbId === d.id)
    }
    db.removeWhere('sql_databases', (d) => d.userId === userId)
  })
}
