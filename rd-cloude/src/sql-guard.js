// SQL guard for the managed SQL service. node:sqlite (Node 22) has no authorizer callback, so user SQL is confined by
//  1. a real SQL lexer (comments, strings, quoted identifiers are understood) + statement/keyword allowlist + PRAGMA allowlist, and
//  2. SQLite's own EXPLAIN bytecode of the exact statement that will run (see scanExplain), which does not depend on this lexer.
// The executor never calls db.exec() with user text: each statement is prepared alone (prepare() compiles only the first statement).
export class GuardError extends Error {
  constructor(message) { super(message); this.name = 'GuardError' }
}

export const LIMITS = { maxSqlBytes: 100 * 1024, maxStatements: 50 }

const DENY_WORDS = new Set([
  'attach', 'detach', 'vacuum', 'load_extension', 'readfile', 'writefile', 'fts3_tokenizer', 'sqlite_dbpage', 'dbstat',
  'zipfile', 'zipfile_cds', 'sqlite_stmt', 'sqlite_rename_table', 'sqlite_rename_column', 'sqlite_rename_test', 'sqlite_drop_column',
])
const TX_WORDS = new Set(['begin', 'commit', 'end', 'rollback', 'savepoint', 'release'])
const FIRST_OK = new Set(['select', 'with', 'values', 'insert', 'replace', 'update', 'delete', 'create', 'drop', 'alter', 'pragma', 'analyze', 'reindex'])
const READ_FIRST = new Set(['select', 'with', 'values'])
const VTAB_MODULES = new Set(['fts5', 'rtree'])
const PRAGMA_READ = new Set(['table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list', 'foreign_key_check', 'foreign_keys',
  'user_version', 'application_id', 'integrity_check', 'quick_check', 'case_sensitive_like', 'recursive_triggers', 'collation_list', 'compile_options', 'data_version',
  'page_count', 'page_size', 'freelist_count', 'encoding', 'schema_version', 'function_list'])
const PRAGMA_WRITE = new Set(['foreign_keys', 'user_version', 'application_id', 'case_sensitive_like', 'recursive_triggers'])

const CONTROL = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/
const isWordStart = (c) => /[A-Za-z_\u0080-￿]/.test(c)
const isWordChar = (c) => /[A-Za-z0-9_$\u0080-￿]/.test(c)

/** Tokenise SQL. Comments are dropped; strings/quoted identifiers keep their text but are never mistaken for keywords. */
export function lex(sql) {
  if (typeof sql !== 'string') throw new GuardError('sql must be a string')
  if (Buffer.byteLength(sql) > LIMITS.maxSqlBytes) throw new GuardError(`SQL is larger than ${LIMITS.maxSqlBytes} bytes`)
  if (CONTROL.test(sql)) throw new GuardError('SQL contains control characters')
  const out = []
  const n = sql.length
  let i = 0
  let start = 0
  const push = (t, v, end) => out.push({ t, v, s: start, e: end })
  while (i < n) {
    start = i
    const c = sql[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') { i++; continue }
    if (c === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') i++; continue }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end < 0) throw new GuardError('Unterminated /* comment')
      i = end + 2; continue
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1, text = ''
      for (;;) {
        if (j >= n) throw new GuardError('Unterminated quoted text')
        if (sql[j] === c) { if (sql[j + 1] === c) { text += c; j += 2; continue } break }
        text += sql[j++]
      }
      push(c === "'" ? 's' : 'q', text, j + 1)
      i = j + 1; continue
    }
    if (c === '[') {
      const end = sql.indexOf(']', i + 1)
      if (end < 0) throw new GuardError('Unterminated [identifier]')
      push('q', sql.slice(i + 1, end), end + 1); i = end + 1; continue
    }
    if (c === 'x' || c === 'X') { // blob literal x'..'
      if (sql[i + 1] === "'") { const end = sql.indexOf("'", i + 2); if (end < 0) throw new GuardError('Unterminated blob literal'); push('s', '', end + 1); i = end + 1; continue }
    }
    if (isWordStart(c)) {
      let j = i + 1
      while (j < n && isWordChar(sql[j])) j++
      push('w', sql.slice(i, j).toLowerCase(), j); i = j; continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      let j = i + 1
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j])) { if ((sql[j] === 'e' || sql[j] === 'E') && (sql[j + 1] === '+' || sql[j + 1] === '-')) j++; j++ }
      push('n', sql.slice(i, j), j); i = j; continue
    }
    if (c === '?' || c === ':' || c === '@' || c === '$') {
      let j = i + 1
      while (j < n && isWordChar(sql[j])) j++
      push('p', sql.slice(i, j), j); i = j; continue
    }
    push('x', c, i + 1); i++
  }
  return out
}

/** Split a token stream into statements at top-level ";" (CREATE TRIGGER bodies keep their inner ";"). */
export function splitStatements(tokens) {
  const stmts = []
  let cur = [], trigger = false, inBody = false, caseDepth = 0, ended = false
  const flush = () => { if (cur.length) stmts.push(cur); cur = []; trigger = inBody = ended = false; caseDepth = 0 }
  for (const tok of tokens) {
    if (tok.t === 'x' && tok.v === ';') {
      if (trigger && inBody && !ended) { cur.push(tok); continue }
      flush(); continue
    }
    cur.push(tok)
    if (tok.t === 'w') {
      if (!trigger && cur.length <= 4 && tok.v === 'trigger' && cur[0].v === 'create') trigger = true
      else if (trigger && !inBody && tok.v === 'begin') inBody = true
      else if (trigger && inBody) { if (tok.v === 'case') caseDepth++; else if (tok.v === 'end') { if (caseDepth > 0) caseDepth--; else ended = true } }
    }
  }
  flush()
  return stmts
}

const word = (toks, i) => (toks[i]?.t === 'w' ? toks[i].v : null)

/**
 * Validate one statement's tokens. Returns { kind, readOnly } or throws GuardError.
 * kind: 'read' | 'write' | 'ddl' | 'pragma'. readOnly: safe to run with PRAGMA query_only=ON.
 */
export function checkStatement(toks, { readOnly = false } = {}) {
  if (!toks.length) throw new GuardError('Empty statement')
  for (const t of toks) {
    if (t.t !== 'w') continue
    if (DENY_WORDS.has(t.v) || t.v.startsWith('pragma_')) throw new GuardError(`"${t.v}" is not allowed`)
  }
  let i = 0
  const explain = word(toks, 0) === 'explain'
  if (explain) { i = 1; if (word(toks, 1) === 'query' && word(toks, 2) === 'plan') i = 3 }
  const first = word(toks, i)
  if (!first) throw new GuardError('Statement must start with a keyword')
  if (TX_WORDS.has(first)) throw new GuardError('Transaction statements are not allowed here: send {"transaction": true} to run the batch atomically')
  if (!FIRST_OK.has(first)) throw new GuardError(`Statements starting with "${first}" are not allowed`)

  if (first === 'pragma') {
    let j = i + 1
    if (toks[j + 1]?.t === 'x' && toks[j + 1].v === '.' && ['main', 'temp'].includes(word(toks, j))) j += 2
    const name = word(toks, j)
    if (!name || !PRAGMA_READ.has(name) && name !== 'optimize') throw new GuardError(`PRAGMA ${name ?? ''} is not allowed`)
    const assigns = toks.slice(j + 1).some((t) => t.t === 'x' && t.v === '=')
    if (assigns) {
      if (readOnly || !PRAGMA_WRITE.has(name)) throw new GuardError(`PRAGMA ${name} cannot be changed`)
      return { kind: 'pragma', readOnly: false }
    }
    if (name === 'optimize' && readOnly) throw new GuardError('PRAGMA optimize writes statistics')
    return { kind: 'pragma', readOnly: name !== 'optimize' }
  }
  if (first === 'create') {
    let j = i + 1
    if (['temp', 'temporary'].includes(word(toks, j))) j++
    if (word(toks, j) === 'unique') j++
    const kw = word(toks, j)
    if (!['table', 'index', 'view', 'trigger', 'virtual'].includes(kw ?? '')) throw new GuardError('Unsupported CREATE statement')
    if (kw === 'virtual') {
      const u = toks.findIndex((t, idx) => idx > j && t.t === 'w' && t.v === 'using')
      const mod = u >= 0 ? word(toks, u + 1) : null
      if (!mod || !VTAB_MODULES.has(mod)) throw new GuardError(`Virtual tables may only use: ${[...VTAB_MODULES].join(', ')}`)
    }
  }
  const isRead = READ_FIRST.has(first) && !toks.some((t) => t.t === 'w' && ['insert', 'update', 'delete', 'replace'].includes(t.v))
  const kind = isRead ? 'read' : first === 'create' || first === 'drop' || first === 'alter' || first === 'analyze' || first === 'reindex' ? 'ddl' : 'write'
  if (readOnly && kind !== 'read' && !(explain && kind !== 'pragma')) throw new GuardError('This connection is read-only: only SELECT statements are allowed')
  return { kind, readOnly: kind === 'read' || explain }
}

/** Parse + validate an SQL script into statements. Returns [{ text, tokens, kind, readOnly }]. */
export function parseScript(sql, opts = {}) {
  const tokens = lex(sql)
  const stmts = splitStatements(tokens)
  if (!stmts.length) throw new GuardError('No SQL statements found')
  if (stmts.length > LIMITS.maxStatements) throw new GuardError(`At most ${LIMITS.maxStatements} statements per request`)
  return stmts.map((toks) => {
    const ex = toks[0].t === 'w' && toks[0].v === 'explain'
    const k = ex ? (word(toks, 1) === 'query' && word(toks, 2) === 'plan' ? 3 : 1) : 0
    // text runs as written; inner is the statement SQLite will actually compile (what EXPLAIN-based validation inspects)
    return { tokens: toks, text: sql.slice(toks[0].s, toks.at(-1).e), inner: sql.slice((toks[k] ?? toks[0]).s, toks.at(-1).e), explain: ex, ...checkStatement(toks, opts) }
  })
}

/**
 * Independent check on SQLite's own bytecode for the statement that will actually execute
 * (rows of `EXPLAIN <statement>` with at least {opcode, p4}). Rejects anything that can touch other files.
 */
export function scanExplain(rows) {
  for (const r of rows) {
    const op = String(r.opcode)
    const p4 = String(r.p4 ?? '')
    if (op === 'Vacuum') throw new GuardError('VACUUM is not allowed')
    if (op === 'JournalMode') throw new GuardError('Changing the journal mode is not allowed')
    if ((op === 'Function' || op === 'PureFunc') && /sqlite_attach|sqlite_detach|load_extension|fts3_tokenizer|readfile|writefile/i.test(p4)) throw new GuardError('This function is not allowed')
  }
}

/** Rebuild SQL text for display (used for history, never executed). */
export const preview = (sql, n = 2000) => String(sql).slice(0, n)
