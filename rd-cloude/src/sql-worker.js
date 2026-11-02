// SQL worker: runs in its own child process (spawned by src/modules/sql.js) and owns exactly one SQLite file.
// It is killed from outside (SIGKILL) on timeout, so even a runaway query cannot wedge the platform.
// Every user statement is validated again here (src/sql-guard.js: lexer allowlist + SQLite's own EXPLAIN bytecode) and run via prepare()
// one statement at a time - db.exec() is only ever used with SQL written in this file.
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import { parseScript, scanExplain, GuardError } from './sql-guard.js'

const [dbPath, cfgJson] = process.argv.slice(2)
const cfg = JSON.parse(cfgJson)
const db = new DatabaseSync(dbPath, { allowExtension: false, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, timeout: 2000 })
db.exec('PRAGMA trusted_schema = OFF; PRAGMA temp_store = MEMORY; PRAGMA synchronous = NORMAL;')
const pageSize = db.prepare('PRAGMA page_size').get().page_size
db.exec(`PRAGMA max_page_count = ${Math.max(16, Math.floor(cfg.maxDbBytes / pageSize))};`)

const q = (id) => `"${String(id).replaceAll('"', '""')}"`
const MAX_CELL = 64 * 1024

function cell(v, stats) {
  if (typeof v === 'bigint') return v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v.toString()
  if (v instanceof Uint8Array) return { $blob: Buffer.from(v.subarray(0, 512)).toString('base64'), bytes: v.length }
  if (typeof v === 'string' && v.length > MAX_CELL) { stats.truncatedCells++; return `${v.slice(0, MAX_CELL)}…[truncated]` }
  return v
}

function bindParams(p) {
  const conv = (v) => {
    if (v === null || typeof v === 'string') return v
    if (typeof v === 'number') { if (!Number.isFinite(v)) throw new GuardError('Parameters must be finite numbers'); return v }
    if (typeof v === 'boolean') return v ? 1 : 0
    if (v && typeof v === 'object' && typeof v.$blob === 'string') return Buffer.from(v.$blob, 'base64')
    throw new GuardError('Parameters must be null, number, string, boolean or {"$blob": base64}')
  }
  if (p === undefined || p === null) return []
  if (Array.isArray(p)) { if (p.length > 1000) throw new GuardError('Too many parameters'); return p.map(conv) }
  if (typeof p === 'object') {
    const keys = Object.keys(p)
    if (keys.length > 1000) throw new GuardError('Too many parameters')
    return [Object.fromEntries(keys.map((k) => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k.replace(/^[:@$]/, ''))) throw new GuardError('Invalid parameter name'); return [k, conv(p[k])] }))]
  }
  throw new GuardError('params must be an array or an object')
}

/** Run one prepared statement. Returns { columns, rows, rowCount, truncated, changes?, lastInsertRowid? }. */
function runPrepared(st, params, { maxRows, maxBytes, wantChanges }) {
  st.setReadBigInts(true)
  const cols = st.columns().map((c) => c.name)
  const stats = { truncatedCells: 0 }
  if (!cols.length) {
    st.run(...params)
    const info = wantChanges ? db.prepare('SELECT changes() AS c, last_insert_rowid() AS r').get() : null
    return { columns: [], rows: [], rowCount: 0, truncated: false, changes: info ? Number(info.c) : 0, lastInsertRowid: info ? cell(info.r, stats) : null }
  }
  const rows = []
  let bytes = 0, truncated = false
  for (const row of st.iterate(...params)) {
    if (rows.length >= maxRows) { truncated = true; break }
    const arr = cols.map((c, i) => cell(Array.isArray(row) ? row[i] : row[c], stats))
    bytes += JSON.stringify(arr).length
    rows.push(arr)
    if (bytes > maxBytes) { truncated = true; break }
  }
  const info = wantChanges ? db.prepare('SELECT changes() AS c, last_insert_rowid() AS r').get() : null
  return { columns: cols, rows, rowCount: rows.length, truncated, truncatedCells: stats.truncatedCells || undefined, ...(info ? { changes: Number(info.c), lastInsertRowid: cell(info.r, stats) } : {}) }
}

function validateExplain(text) {
  scanExplain(db.prepare(`EXPLAIN ${text}`).all())
}

function cleanupTx() {
  try { if (db.isTransaction) db.exec('ROLLBACK') } catch { /* nothing to roll back */ }
  try { db.exec('PRAGMA query_only = 0') } catch { /* ignore */ }
}

const ops = {
  exec({ sql, params, readOnly, transaction, maxRows = 1000, maxBytes = 4 * 1024 * 1024 }) {
    const parsed = parseScript(sql, { readOnly })
    if (params !== undefined && params !== null && parsed.length !== 1) throw new GuardError('Parameters can only be used with a single statement')
    // Layer 1 (lexer/allowlist) already vetted every statement. Layer 2 (SQLite's own bytecode) must run against the schema as it is when
    // each statement executes (a script may create a table and then use it), so it runs right before each statement.
    const bound = params === undefined || params === null ? [[]] : [bindParams(params)]
    const results = []
    const started = Date.now()
    try {
      if (readOnly) db.exec('PRAGMA query_only = 1')
      if (transaction) db.exec('BEGIN IMMEDIATE')
      parsed.forEach((s, i) => {
        validateExplain(s.inner)
        const st = db.prepare(s.text)
        const t0 = Date.now()
        const r = runPrepared(st, bound[0] ?? [], { maxRows, maxBytes, wantChanges: s.kind === 'write' })
        results.push({ statement: i, kind: s.kind, ms: Date.now() - t0, ...r })
      })
      if (transaction) db.exec('COMMIT')
    } catch (e) {
      cleanupTx()
      throw e
    }
    cleanupTx()
    return { results, ms: Date.now() - started, sizeBytes: sizeBytes() }
  },

  schema() {
    const objs = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 ELSE 2 END, name").all()
    const tables = []
    for (const o of objs.filter((x) => x.type === 'table' || x.type === 'view')) {
      const columns = db.prepare(`PRAGMA table_xinfo(${q(o.name)})`).all().map((c) => ({ name: c.name, type: c.type, notNull: !!c.notnull, default: c.dflt_value, primaryKey: c.pk > 0, hidden: c.hidden > 0 }))
      const fks = db.prepare(`PRAGMA foreign_key_list(${q(o.name)})`).all().map((f) => ({ from: f.from, table: f.table, to: f.to }))
      let rowCount = null
      if (o.type === 'table') { try { rowCount = Number(db.prepare(`SELECT count(*) AS n FROM ${q(o.name)}`).get().n) } catch { /* virtual table without count */ } }
      tables.push({ name: o.name, type: o.type, columns, foreignKeys: fks, rowCount, sql: o.sql })
    }
    const indexes = objs.filter((x) => x.type === 'index').map((x) => ({ name: x.name, table: x.tbl_name, sql: x.sql }))
    const triggers = objs.filter((x) => x.type === 'trigger').map((x) => ({ name: x.name, table: x.tbl_name, sql: x.sql }))
    return { tables, indexes, triggers, sizeBytes: sizeBytes() }
  },

  table({ name, limit = 50, offset = 0 }) {
    const o = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ? AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").get(String(name))
    if (!o) throw new GuardError('Unknown table')
    const lim = Math.min(1000, Math.max(1, Number(limit) | 0)), off = Math.max(0, Number(offset) | 0)
    const st = db.prepare(`SELECT * FROM ${q(o.name)} LIMIT ? OFFSET ?`)
    const r = runPrepared(st, [lim, off], { maxRows: lim, maxBytes: 4 * 1024 * 1024, wantChanges: false })
    let total = null
    try { total = Number(db.prepare(`SELECT count(*) AS n FROM ${q(o.name)}`).get().n) } catch { /* ignore */ }
    return { ...r, total, limit: lim, offset: off }
  },

  /** Bulk insert (CSV/JSON import). columns: [{name,type}] with type in INTEGER|REAL|TEXT; rows: arrays of values. */
  bulk({ table, columns, rows }) {
    const ident = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
    if (!ident.test(table) || /^sqlite_/i.test(table)) throw new GuardError('Invalid table name')
    if (!Array.isArray(columns) || !columns.length || columns.length > 200 || columns.some((c) => !ident.test(c.name) || !['INTEGER', 'REAL', 'TEXT'].includes(c.type))) throw new GuardError('Invalid columns')
    try {
      db.exec('BEGIN IMMEDIATE')
      db.exec(`CREATE TABLE IF NOT EXISTS ${q(table)} (${columns.map((c) => `${q(c.name)} ${c.type}`).join(', ')})`)
      const st = db.prepare(`INSERT INTO ${q(table)} (${columns.map((c) => q(c.name)).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      let n = 0
      for (const r of rows) { st.run(...r.map((v) => (v === undefined ? null : v))); n++ }
      db.exec('COMMIT')
      return { inserted: n, sizeBytes: sizeBytes() }
    } catch (e) { cleanupTx(); throw e }
  },

  /** format: sql | csv | json. For csv/json pass `table` or a read-only `sql`. */
  export({ format, table, sql, maxRows = 100_000 }) {
    if (format === 'sql') {
      const out = ['-- RD Cloude SQL dump. Restore with POST /api/sql/:id/query {"sql": <this file>, "transaction": true}', 'PRAGMA foreign_keys=OFF;']
      let bytes = 0
      const lit = (v) => (v === null ? 'NULL' : typeof v === 'bigint' || typeof v === 'number' ? String(v) : v instanceof Uint8Array ? `X'${Buffer.from(v).toString('hex')}'` : `'${String(v).replaceAll("'", "''")}'`)
      for (const o of db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name").all()) {
        out.push(`${o.sql};`)
        if (o.type === 'table') {
          const st = db.prepare(`SELECT * FROM ${q(o.name)}`); st.setReadBigInts(true); st.setReturnArrays(true)
          for (const row of st.iterate()) {
            const line = `INSERT INTO ${q(o.name)} VALUES(${row.map(lit).join(',')});`
            bytes += line.length
            if (bytes > 20 * 1024 * 1024) throw new GuardError('Dump is larger than 20 MB; export tables individually as CSV')
            out.push(line)
          }
        }
      }
      return { text: out.join('\n') + '\n' }
    }
    let st
    if (table) {
      const o = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ? AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").get(String(table))
      if (!o) throw new GuardError('Unknown table')
      st = db.prepare(`SELECT * FROM ${q(o.name)}`)
    } else {
      const parsed = parseScript(sql, { readOnly: true })
      if (parsed.length !== 1 || parsed[0].kind !== 'read') throw new GuardError('Export needs a single SELECT')
      const text = parsed[0].text
      validateExplain(parsed[0].inner)
      db.exec('PRAGMA query_only = 1')
      st = db.prepare(text)
    }
    try {
      const r = runPrepared(st, [], { maxRows: Math.min(maxRows, 100_000), maxBytes: 32 * 1024 * 1024, wantChanges: false })
      return { columns: r.columns, rows: r.rows, truncated: r.truncated }
    } finally { cleanupTx() }
  },

  snapshot({ dest }) {
    if (typeof dest !== 'string' || !dest.startsWith(cfg.snapshotDir + '/')) throw new GuardError('Bad snapshot destination')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.prepare('VACUUM INTO ?').run(dest)
    return { bytes: fs.statSync(dest).size }
  },

  integrity() {
    const rows = db.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check)
    return { ok: rows.length === 1 && rows[0] === 'ok', messages: rows.slice(0, 20) }
  },

  size() { return { sizeBytes: sizeBytes() } },
}

function sizeBytes() {
  try { return Number(db.prepare('PRAGMA page_count').get().page_count) * pageSize } catch { return 0 }
}

process.on('message', (msg) => {
  const { id, op, ...args } = msg ?? {}
  try {
    if (!ops[op]) throw new GuardError('Unknown operation')
    const result = ops[op](args)
    process.send({ id, ok: true, result })
  } catch (e) {
    cleanupTx()
    process.send({ id, ok: false, error: { message: String(e?.message ?? e).slice(0, 500), kind: e instanceof GuardError ? 'guard' : 'sqlite', code: e?.code ?? null, errcode: e?.errcode ?? null } })
  }
})
process.on('disconnect', () => { try { db.close() } catch { /* ignore */ } process.exit(0) })
process.send({ type: 'ready' })
