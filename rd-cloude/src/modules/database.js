// Document database: per-user collections of JSON documents with a query language, secondary indexes (+ planner),
// JSON-schema validation, TTL, optimistic concurrency, atomic batches, aggregation, NDJSON import/export and SSE change streams.
// Rows live in the shared `docs` collection ({userId, collection, data, version}); per-user in-memory state gives O(1) lookups. See docs/database.md.
import { HttpError, HANDLED } from '../http.js'

const envInt = (name, dflt, min, max) => { const n = Number(process.env[name]); return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : dflt }
const LIM = {
  docBytes: () => envInt('RD_DB_MAX_DOC_BYTES', 256 * 1024, 1024, 16 * 1024 * 1024),
  userDocs: () => envInt('RD_DB_MAX_DOCS', 500_000, 1, 50_000_000),
  collections: 200, indexes: 10, batchOps: 500, queryLimit: 1000, defaultLimit: 100, depth: 20, nodes: 100_000, schemaBytes: 64 * 1024,
  importLines: 50_000, exportDocs: 200_000, logSize: 2000, watchers: 10, whereDepth: 8, whereClauses: 100,
}
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
/** External document id: client-chosen (xid, unique per collection) or the internal row id. Internal ids are always random and global. */
const kid = (row) => row.xid ?? row.id
const XID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/

/* ------------------------------------------------------------------ paths & values */
function splitPath(p) {
  if (typeof p !== 'string' || !p || p.length > 200) throw new HttpError(400, 'Invalid field path')
  const segs = p.split('.')
  if (segs.length > 10 || segs.some((s) => !s || FORBIDDEN.has(s))) throw new HttpError(400, `Invalid field path: ${p.slice(0, 60)}`)
  return segs
}
/** All values found at a path (arrays are traversed; array leaves also contribute their elements). */
function valuesAt(obj, segs, i = 0, out = []) {
  if (i === segs.length) {
    out.push(obj)
    if (Array.isArray(obj)) for (const x of obj) out.push(x)
    return out
  }
  if (Array.isArray(obj)) { for (const x of obj) if (x !== null && typeof x === 'object') valuesAt(x, segs, i, out); return out }
  if (obj !== null && typeof obj === 'object' && Object.hasOwn(obj, segs[i])) valuesAt(obj[segs[i]], segs, i + 1, out)
  return out
}
const getOne = (obj, segs) => { let cur = obj; for (const s of segs) { if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, s)) return undefined; cur = cur[s] } return cur }
function setPath(obj, segs, value) {
  let cur = obj
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i]
    if (!Object.hasOwn(cur, s)) cur[s] = {}
    else if (cur[s] === null || typeof cur[s] !== 'object' || Array.isArray(cur[s])) throw new HttpError(400, `Cannot traverse ${Array.isArray(cur[s]) ? 'an array' : 'a non-object value'} at ${segs.slice(0, i + 1).join('.')}`)
    cur = cur[s]
  }
  cur[segs.at(-1)] = value
}
function unsetPath(obj, segs) {
  let cur = obj
  for (let i = 0; i < segs.length - 1; i++) { if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, segs[i])) return; cur = cur[segs[i]] }
  if (cur && typeof cur === 'object') delete cur[segs.at(-1)]
}
function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  const ka = Object.keys(a), kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
}
const scalarType = (v) => (typeof v === 'number' && Number.isFinite(v) ? 'n' : typeof v === 'string' ? 's' : typeof v === 'boolean' ? 'b' : null)
/** -1/0/1 for same-typed scalars, null when incomparable. */
const cmpScalar = (a, b) => { const t = scalarType(a); if (!t || t !== scalarType(b)) return null; return a < b ? -1 : a > b ? 1 : 0 }
const typeRank = (v) => (v === undefined || v === null ? 0 : typeof v === 'boolean' ? 1 : typeof v === 'number' ? 2 : typeof v === 'string' ? 3 : 4)
function cmpSort(a, b) {
  const ra = typeRank(a), rb = typeRank(b)
  if (ra !== rb) return ra - rb
  if (ra === 0) return 0
  if (ra === 4) { const x = JSON.stringify(a), y = JSON.stringify(b); return x < y ? -1 : x > y ? 1 : 0 }
  return a < b ? -1 : a > b ? 1 : 0
}
const keyOf = (v) => (typeof v === 'string' ? `s:${v}` : typeof v === 'number' && Number.isFinite(v) ? `n:${v}` : typeof v === 'boolean' ? `b:${v}` : v === null ? 'null' : null)

/* ------------------------------------------------------------------ safe regex (no backtracking bombs) */
function safeRegex(pattern, options) {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 64) throw new HttpError(400, '$regex must be a string of 1-64 characters')
  if (options !== undefined && options !== 'i' && options !== '') throw new HttpError(400, '$options may only be "i"')
  if (/\\[1-9k]|\(\?[=!<]/.test(pattern)) throw new HttpError(400, '$regex: backreferences and lookarounds are not allowed')
  if (/\([^)]*[+*{|][^)]*\)\s*[+*{?]/.test(pattern) || /([+*])\s*[+*]/.test(pattern.replace(/\\./g, ''))) throw new HttpError(400, '$regex: nested or repeated quantifiers are not allowed')
  if ((pattern.match(/\.\*|\.\+/g) ?? []).length > 2) throw new HttpError(400, '$regex: at most two ".*" / ".+" sequences')
  try { return new RegExp(pattern, options === 'i' ? 'iu' : 'u') } catch { throw new HttpError(400, '$regex is not a valid expression') }
}

/* ------------------------------------------------------------------ query compiler */
/** Compile a where-object into a predicate(data) => boolean. Throws HttpError(400) for anything malformed. */
export function compileWhere(where, depth = 0, budget = { n: 0 }) {
  if (where === undefined || where === null) return () => true
  if (!isObj(where)) throw new HttpError(400, 'where must be an object')
  if (depth > LIM.whereDepth) throw new HttpError(400, 'where is nested too deeply')
  const preds = []
  for (const [key, cond] of Object.entries(where)) {
    if (++budget.n > LIM.whereClauses) throw new HttpError(400, 'where has too many clauses')
    if (key === '$and' || key === '$or' || key === '$nor') {
      if (!Array.isArray(cond) || !cond.length || cond.length > 20) throw new HttpError(400, `${key} must be an array of 1-20 conditions`)
      const subs = cond.map((c) => compileWhere(c, depth + 1, budget))
      preds.push(key === '$and' ? (d) => subs.every((p) => p(d)) : key === '$or' ? (d) => subs.some((p) => p(d)) : (d) => !subs.some((p) => p(d)))
    } else if (key === '$not') {
      const sub = compileWhere(cond, depth + 1, budget)
      preds.push((d) => !sub(d))
    } else if (key.startsWith('$')) throw new HttpError(400, `Unknown operator ${key.slice(0, 30)}`)
    else preds.push(compileField(splitPath(key), cond, budget))
  }
  if (preds.length === 1) return preds[0]
  return (d) => { for (const p of preds) if (!p(d)) return false; return true }
}
function compileField(segs, cond, budget) {
  const ops = isObj(cond) && Object.keys(cond).length && Object.keys(cond).every((k) => k.startsWith('$')) ? cond : null
  if (!ops) return (d) => valuesAt(d, segs).some((v) => deepEqual(v, cond)) // equality (arrays match any element)
  const tests = []
  for (const [op, arg] of Object.entries(ops)) {
    if (++budget.n > LIM.whereClauses) throw new HttpError(400, 'where has too many clauses')
    switch (op) {
      case '$eq': tests.push((vs) => vs.some((v) => deepEqual(v, arg))); break
      case '$ne': tests.push((vs) => !vs.some((v) => deepEqual(v, arg))); break
      case '$gt': case '$gte': case '$lt': case '$lte': {
        if (!scalarType(arg)) throw new HttpError(400, `${op} needs a number, string or boolean`)
        const ok = { $gt: (c) => c > 0, $gte: (c) => c >= 0, $lt: (c) => c < 0, $lte: (c) => c <= 0 }[op]
        tests.push((vs) => vs.some((v) => { const c = cmpScalar(v, arg); return c !== null && ok(c) }))
        break
      }
      case '$in': case '$nin': {
        if (!Array.isArray(arg) || arg.length > 1000) throw new HttpError(400, `${op} needs an array of at most 1000 values`)
        const keys = arg.every((a) => keyOf(a) !== null) ? new Set(arg.map(keyOf)) : null
        const has = keys ? (v) => { const k = keyOf(v); return k !== null && keys.has(k) } : (v) => arg.some((a) => deepEqual(a, v))
        tests.push(op === '$in' ? (vs) => vs.some(has) : (vs) => !vs.some(has))
        break
      }
      case '$exists': tests.push((vs) => (vs.length > 0) === (arg !== false)); break
      case '$regex': {
        const re = safeRegex(arg, ops.$options)
        tests.push((vs) => vs.some((v) => typeof v === 'string' && re.test(v.length > 5000 ? v.slice(0, 5000) : v)))
        break
      }
      case '$options': break
      case '$contains': case '$icontains': case '$startsWith': {
        if (typeof arg !== 'string' || !arg || arg.length > 200) throw new HttpError(400, `${op} needs a string of 1-200 characters`)
        const needle = op === '$icontains' ? arg.toLowerCase() : arg
        tests.push((vs) => vs.some((v) => typeof v === 'string' && (op === '$startsWith' ? v.startsWith(arg) : op === '$contains' ? v.includes(arg) : v.toLowerCase().includes(needle))))
        break
      }
      case '$size': {
        if (!Number.isInteger(arg) || arg < 0) throw new HttpError(400, '$size needs a non-negative integer')
        tests.push((vs) => vs.some((v) => Array.isArray(v) && v.length === arg))
        break
      }
      case '$all': {
        if (!Array.isArray(arg) || arg.length > 100) throw new HttpError(400, '$all needs an array of at most 100 values')
        tests.push((vs) => vs.some((v) => Array.isArray(v) && arg.every((a) => v.some((x) => deepEqual(x, a)))))
        break
      }
      case '$not': {
        const sub = compileField(segs, arg, budget)
        tests.push((vs, d) => !sub(d))
        break
      }
      default: throw new HttpError(400, `Unknown operator ${op.slice(0, 30)}`)
    }
  }
  return (d) => { const vs = valuesAt(d, segs); for (const t of tests) if (!t(vs, d)) return false; return true }
}

/** Equality / $in constraints on top-level paths of an AND-only where, used by the planner. */
function indexableConstraints(where) {
  const out = []
  if (!isObj(where)) return out
  for (const [k, v] of Object.entries(where)) {
    if (k === '$and' && Array.isArray(v)) { for (const sub of v) out.push(...indexableConstraints(sub)); continue }
    if (k.startsWith('$')) continue
    if (isObj(v) && Object.keys(v).length && Object.keys(v).every((x) => x.startsWith('$'))) {
      if (Object.hasOwn(v, '$eq') && keyOf(v.$eq) !== null) out.push({ field: k, keys: [keyOf(v.$eq)] })
      else if (Array.isArray(v.$in) && v.$in.length <= 1000 && v.$in.every((a) => keyOf(a) !== null)) out.push({ field: k, keys: v.$in.map(keyOf) })
    } else if (keyOf(v) !== null) out.push({ field: k, keys: [keyOf(v)] })
  }
  return out
}

/* ------------------------------------------------------------------ JSON-schema subset */
export function checkSchemaShape(schema, depth = 0) {
  if (!isObj(schema)) throw new HttpError(400, 'schema must be an object')
  if (depth > 10) throw new HttpError(400, 'schema is nested too deeply')
  const known = new Set(['type', 'required', 'properties', 'additionalProperties', 'items', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'description', 'title', 'default', 'format'])
  for (const k of Object.keys(schema)) if (!known.has(k)) throw new HttpError(400, `Unsupported schema keyword "${k.slice(0, 30)}"`)
  const types = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']
  if (schema.type !== undefined && !(types.includes(schema.type) || (Array.isArray(schema.type) && schema.type.length && schema.type.every((t) => types.includes(t))))) throw new HttpError(400, 'Invalid "type"')
  if (schema.required !== undefined && !(Array.isArray(schema.required) && schema.required.every((x) => typeof x === 'string'))) throw new HttpError(400, '"required" must be an array of strings')
  if (schema.properties !== undefined) { if (!isObj(schema.properties)) throw new HttpError(400, '"properties" must be an object'); for (const [k, v] of Object.entries(schema.properties)) { if (FORBIDDEN.has(k)) throw new HttpError(400, 'Invalid property name'); checkSchemaShape(v, depth + 1) } }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') checkSchemaShape(schema.additionalProperties, depth + 1)
  if (schema.items !== undefined) checkSchemaShape(schema.items, depth + 1)
  if (schema.enum !== undefined && !(Array.isArray(schema.enum) && schema.enum.length <= 1000)) throw new HttpError(400, '"enum" must be an array')
  for (const k of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) if (schema[k] !== undefined && !Number.isFinite(schema[k])) throw new HttpError(400, `"${k}" must be a number`)
  for (const k of ['minLength', 'maxLength', 'minItems', 'maxItems']) if (schema[k] !== undefined && !(Number.isInteger(schema[k]) && schema[k] >= 0)) throw new HttpError(400, `"${k}" must be a non-negative integer`)
  if (schema.pattern !== undefined) safeRegex(schema.pattern)
}
function validateAgainst(schema, value, path, errors, depth = 0) {
  if (errors.length >= 20 || depth > 12) return
  const err = (m) => errors.length < 20 && errors.push({ path: path || '(root)', message: m })
  if (schema.type !== undefined) {
    const types = [].concat(schema.type)
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value
    const ok = types.some((t) => t === actual || (t === 'number' && actual === 'integer'))
    if (!ok) return err(`expected ${types.join(' or ')}, got ${actual}`)
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => deepEqual(e, value))) err('must be one of the allowed values')
  if (schema.const !== undefined && !deepEqual(schema.const, value)) err('must equal the constant value')
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) err(`must be >= ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) err(`must be <= ${schema.maximum}`)
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) err(`must be > ${schema.exclusiveMinimum}`)
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) err(`must be < ${schema.exclusiveMaximum}`)
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) err(`length must be >= ${schema.minLength}`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) err(`length must be <= ${schema.maxLength}`)
    if (schema.pattern !== undefined && !safeRegex(schema.pattern).test(value.slice(0, 5000))) err(`must match pattern ${schema.pattern}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) err(`must have >= ${schema.minItems} items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) err(`must have <= ${schema.maxItems} items`)
    if (schema.uniqueItems && value.some((x, i) => value.findIndex((y) => deepEqual(x, y)) !== i)) err('items must be unique')
    if (schema.items) value.slice(0, 1000).forEach((x, i) => validateAgainst(schema.items, x, `${path}[${i}]`, errors, depth + 1))
  }
  if (isObj(value)) {
    for (const k of schema.required ?? []) if (!Object.hasOwn(value, k)) err(`missing required property "${k}"`)
    for (const [k, sub] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, k)) validateAgainst(sub, value[k], path ? `${path}.${k}` : k, errors, depth + 1)
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      for (const k of Object.keys(value)) if (!Object.hasOwn(schema.properties ?? {}, k)) {
        if (schema.additionalProperties === false) err(`unexpected property "${k}"`)
        else validateAgainst(schema.additionalProperties, value[k], path ? `${path}.${k}` : k, errors, depth + 1)
      }
    }
  }
}

/** Reject documents that are not plain JSON objects within the size/shape limits. */
function checkDoc(data) {
  if (!isObj(data)) throw new HttpError(400, 'A document must be a JSON object')
  let nodes = 0
  const walk = (v, depth) => {
    if (++nodes > LIM.nodes) throw new HttpError(413, 'Document has too many values')
    if (depth > LIM.depth) throw new HttpError(400, `Documents may be nested at most ${LIM.depth} levels deep`)
    if (Array.isArray(v)) { if (v.length > 10_000) throw new HttpError(413, 'Arrays may have at most 10000 elements'); for (const x of v) walk(x, depth + 1) }
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) {
      if (k.startsWith('$') || k.includes('.') || FORBIDDEN.has(k) || k.length > 200) throw new HttpError(400, `Invalid field name "${k.slice(0, 40)}" (no "$" prefix, dots or reserved names)`)
      walk(x, depth + 1)
    } else if (typeof v === 'number' && !Number.isFinite(v)) throw new HttpError(400, 'Numbers must be finite')
  }
  walk(data, 0)
  if (JSON.stringify(data).length > LIM.docBytes()) throw new HttpError(413, `Document is larger than ${LIM.docBytes()} bytes`)
}

/* ------------------------------------------------------------------ module */
export function register(r, db, ctx) {
  const states = new Map() // userId -> { colls: Map(name -> coll), total, log: [], seq, watchers: Map(name -> Set) }
  const metaOf = (userId, name) => db.findOne('db_meta', (m) => m.userId === userId && m.collection === name)
  const metaRows = (userId) => (typeof db.findBy === 'function' ? db.findBy('db_meta', 'userId', userId) : db.find('db_meta', (m) => m.userId === userId))
  const docRows = (userId) => (typeof db.findBy === 'function' ? db.findBy('docs', 'userId', userId) : db.find('docs', (d) => d.userId === userId))

  /* ---- per-user state (rebuilt lazily from rows) ---- */
  function newColl(name, meta) {
    return { name, docs: new Map(), indexes: new Map(), meta: meta ?? null }
  }
  function indexAdd(coll, row) {
    for (const [field, ix] of coll.indexes) for (const k of indexKeys(row.data, field)) { let s = ix.map.get(k); if (!s) ix.map.set(k, (s = new Set())); s.add(kid(row)) }
  }
  function indexRemove(coll, row) {
    for (const [field, ix] of coll.indexes) for (const k of indexKeys(row.data, field)) { const s = ix.map.get(k); if (s) { s.delete(kid(row)); if (!s.size) ix.map.delete(k) } }
  }
  const indexKeys = (data, field) => { const ks = new Set(); for (const v of valuesAt(data, splitPath(field))) { if (Array.isArray(v)) continue; const k = keyOf(v); if (k !== null) ks.add(k) } return ks }
  function buildIndex(coll, field, unique) {
    const ix = { unique, map: new Map() }
    coll.indexes.set(field, ix)
    for (const row of coll.docs.values()) {
      for (const k of indexKeys(row.data, field)) {
        let s = ix.map.get(k)
        if (!s) ix.map.set(k, (s = new Set()))
        if (unique && s.size) { coll.indexes.delete(field); throw new HttpError(409, `Cannot create unique index: duplicate values for "${field}"`) }
        s.add(kid(row))
      }
    }
  }
  function stateOf(userId) {
    let st = states.get(userId)
    if (st) return st
    st = { colls: new Map(), total: 0, log: [], seq: 0, watchers: new Map() }
    for (const m of metaRows(userId)) st.colls.set(m.collection, newColl(m.collection, m))
    for (const row of docRows(userId)) {
      let c = st.colls.get(row.collection)
      if (!c) st.colls.set(row.collection, (c = newColl(row.collection, null)))
      c.docs.set(kid(row), row)
      st.total++
    }
    for (const c of st.colls.values()) for (const spec of c.meta?.indexes ?? []) { try { buildIndex(c, spec.field, spec.unique) } catch (e) { console.error('[db] index rebuild failed:', e.message) } }
    states.set(userId, st)
    if (states.size > 200) for (const [k, v] of states) { if (![...v.watchers.values()].some((w) => w.size)) { states.delete(k); break } }
    return st
  }
  const invalidate = (userId) => { const old = states.get(userId); states.delete(userId); if (old) { const n = stateOf(userId); n.watchers = old.watchers; n.seq = old.seq; n.log = old.log } }

  const collName = (n) => {
    if (typeof n !== 'string' || !NAME_RE.test(n)) throw new HttpError(400, 'Collection names start with a letter and use letters, digits, "_" or "-" (max 64)')
    return n
  }
  const isLive = (row, coll, now = Date.now()) => {
    const f = coll.meta?.ttlField
    if (!f) return true
    const v = getOne(row.data, splitPath(f))
    const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN
    return !(Number.isFinite(t) && t <= now)
  }
  const view = (row) => ({ id: kid(row), collection: row.collection, data: row.data, version: row.version ?? 1, createdAt: row.createdAt, updatedAt: row.updatedAt ?? row.createdAt })

  function ensureMeta(st, userId, name) {
    let c = st.colls.get(name)
    if (!c) {
      if (st.colls.size >= LIM.collections) throw new HttpError(409, `At most ${LIM.collections} collections`)
      c = newColl(name, null)
      st.colls.set(name, c)
    }
    if (!c.meta) c.meta = db.insert('db_meta', { userId, collection: name, indexes: [], schema: null, ttlField: null, publicRead: false })
    return c
  }
  const saveMeta = (c, patch) => { c.meta = db.update('db_meta', c.meta.id, patch) }

  /* ---- change log ---- */
  let pendingEvents = null
  function emit(st, name, type, row) {
    const ev = { seq: ++st.seq, name, type, id: kid(row), version: row.version ?? 1, data: type === 'delete' ? undefined : row.data, ts: Date.now() }
    if (pendingEvents) { pendingEvents.push([st, ev]); return }
    deliver(st, ev)
  }
  function deliver(st, ev) {
    st.log.push(ev)
    if (st.log.length > LIM.logSize) st.log.splice(0, st.log.length - LIM.logSize)
    for (const w of st.watchers.get(ev.name) ?? []) writeEvent(w, ev)
  }
  function writeEvent(w, ev) {
    if (w.res.destroyed) return
    if (w.pred && ev.type !== 'delete' && !w.pred(ev.data)) return
    w.res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify({ id: ev.id, version: ev.version, data: ev.data, collection: ev.name })}\n\n`)
  }

  /* ---- single write path (shared by REST handlers and batch) ---- */
  function checkUnique(coll, id, data) {
    for (const [field, ix] of coll.indexes) {
      if (!ix.unique) continue
      for (const k of indexKeys(data, field)) { const s = ix.map.get(k); if (s && (s.size > 1 || (s.size === 1 && !s.has(id)))) throw new HttpError(409, `Duplicate value for unique index "${field}"`) }
    }
  }
  function validateDoc(coll, data) {
    checkDoc(data)
    if (coll.meta?.schema) {
      const errors = []
      validateAgainst(coll.meta.schema, data, '', errors)
      if (errors.length) { const e = new HttpError(422, 'Document does not match the collection schema'); e.errors = errors; throw e }
    }
  }
  function writeDoc(userId, st, name, { id, data, expectVersion, mode }) {
    const coll = ensureMeta(st, userId, name)
    const existing = id ? coll.docs.get(id) : null
    if (mode === 'insert') {
      if (id !== undefined && (typeof id !== 'string' || !XID_RE.test(id))) throw new HttpError(400, 'Document ids use letters, digits and _ . : @ - (max 128)')
      if (existing) throw new HttpError(409, 'A document with that id already exists in this collection')
      if (st.total >= LIM.userDocs()) throw new HttpError(413, `Document limit reached (${LIM.userDocs()})`)
      validateDoc(coll, data)
      const ext = id ?? null
      checkUnique(coll, ext ?? '', data)
      const row = db.insert('docs', { userId, collection: name, data, version: 1, ...(ext ? { xid: ext } : {}) })
      coll.docs.set(kid(row), row); st.total++
      indexAdd(coll, row)
      emit(st, name, 'insert', row)
      return row
    }
    if (!existing || !isLive(existing, coll)) throw new HttpError(404, 'Document not found')
    if (expectVersion !== undefined && expectVersion !== (existing.version ?? 1)) throw new HttpError(412, `Version mismatch (current version is ${existing.version ?? 1})`)
    if (mode === 'delete') {
      db.remove('docs', existing.id)
      indexRemove(coll, existing); coll.docs.delete(kid(existing)); st.total--
      emit(st, name, 'delete', existing)
      return existing
    }
    validateDoc(coll, data)
    checkUnique(coll, kid(existing), data)
    const old = existing
    indexRemove(coll, old)
    const row = db.update('docs', existing.id, { data, version: (existing.version ?? 1) + 1 })
    coll.docs.set(kid(row), row)
    indexAdd(coll, row)
    emit(st, name, 'update', row)
    return row
  }

  const ifMatch = (req, query) => {
    const raw = req.headers['if-match'] ?? query?.get?.('ifVersion')
    if (raw === undefined || raw === null || raw === '*') return undefined
    const n = Number(String(raw).replace(/^W\//, '').replace(/"/g, ''))
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'If-Match / ifVersion must be a document version number')
    return n
  }
  const audit = (userId, action, resource, meta) => { try { ctx.events.emit('audit', { userId, action, resource, meta }) } catch { /* ignore */ } }

  /* ---- patch operators ---- */
  function applyPatch(data, patch) {
    if (!isObj(patch) || !Object.keys(patch).length) throw new HttpError(400, 'PATCH needs operators such as {"$set": {...}}')
    const out = structuredClone(data)
    for (const [op, spec] of Object.entries(patch)) {
      if (!['$set', '$unset', '$inc', '$push', '$pull', '$addToSet'].includes(op)) throw new HttpError(400, `Unknown update operator ${op.slice(0, 30)}`)
      if (!isObj(spec) || !Object.keys(spec).length) throw new HttpError(400, `${op} needs an object of field: value pairs`)
      for (const [path, val] of Object.entries(spec)) {
        const segs = splitPath(path)
        const cur = getOne(out, segs)
        if (op === '$set') setPath(out, segs, val)
        else if (op === '$unset') unsetPath(out, segs)
        else if (op === '$inc') {
          if (typeof val !== 'number' || !Number.isFinite(val)) throw new HttpError(400, '$inc needs a number')
          if (cur !== undefined && typeof cur !== 'number') throw new HttpError(400, `Cannot $inc non-number field ${path}`)
          setPath(out, segs, (cur ?? 0) + val)
        } else {
          if (cur !== undefined && !Array.isArray(cur)) throw new HttpError(400, `${op} needs an array field: ${path}`)
          const arr = cur ?? []
          if (op === '$push') setPath(out, segs, [...arr, val])
          else if (op === '$addToSet') setPath(out, segs, arr.some((x) => deepEqual(x, val)) ? arr : [...arr, val])
          else setPath(out, segs, arr.filter((x) => !deepEqual(x, val)))
        }
      }
    }
    return out
  }

  /* ---- query execution ---- */
  function runQuery(coll, body, { forExplain = false } = {}) {
    const where = body.where ?? {}
    const pred = compileWhere(where)
    // planner: smallest candidate set among indexed equality / $in constraints
    let candidates = null, plan = { type: 'scan', scanned: coll.docs.size }
    for (const c of indexableConstraints(where)) {
      const ix = coll.indexes.get(c.field)
      if (!ix) continue
      const ids = new Set()
      for (const k of c.keys) for (const id of ix.map.get(k) ?? []) ids.add(id)
      if (!candidates || ids.size < candidates.size) { candidates = ids; plan = { type: 'index', index: c.field, scanned: ids.size, unique: ix.unique } }
    }
    if (forExplain) return { plan }
    const now = Date.now()
    const out = []
    const consider = (row) => { if (isLive(row, coll, now) && pred(row.data)) out.push(row) }
    if (candidates) for (const id of candidates) { const row = coll.docs.get(id); if (row) consider(row) }
    else for (const row of coll.docs.values()) consider(row)
    return { rows: out, plan }
  }
  function parseSort(sort) {
    if (sort === undefined || sort === null) return []
    let specs
    if (typeof sort === 'string') specs = sort.split(',').filter(Boolean).map((s) => (s.startsWith('-') ? [s.slice(1), -1] : [s.replace(/:(asc|desc)$/, ''), s.endsWith(':desc') ? -1 : 1]))
    else if (Array.isArray(sort)) specs = sort.map((s) => (typeof s === 'string' ? (s.startsWith('-') ? [s.slice(1), -1] : [s, 1]) : [s?.field, s?.dir === 'desc' || s?.dir === -1 ? -1 : 1]))
    else if (isObj(sort)) specs = Object.entries(sort).map(([f, d]) => [f, d === -1 || d === 'desc' ? -1 : 1])
    else throw new HttpError(400, 'Invalid sort')
    if (specs.length > 3) throw new HttpError(400, 'Sort by at most 3 fields')
    return specs.map(([f, d]) => [splitPath(f), d, f])
  }
  const encodeCursor = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  function decodeCursor(c) { try { const o = JSON.parse(Buffer.from(String(c), 'base64url').toString('utf8')); if (!isObj(o) || typeof o.id !== 'string' || typeof o.c !== 'string' || !Array.isArray(o.k)) throw new Error('shape'); return o } catch { throw new HttpError(400, 'Invalid cursor') } }
  const project = (data, proj) => {
    if (!proj) return data
    const fields = Array.isArray(proj) ? proj : isObj(proj) ? Object.entries(proj).filter(([, v]) => v).map(([k]) => k) : null
    if (!fields || fields.length > 50) throw new HttpError(400, 'project must be an array of field paths or {field: 1}')
    const out = {}
    for (const f of fields) { const segs = splitPath(f); const v = getOne(data, segs); if (v !== undefined) setPath(out, segs, structuredClone(v)) }
    return out
  }
  function execute(coll, body) {
    const sort = parseSort(body.sort)
    let limit = body.limit === undefined ? LIM.defaultLimit : body.limit
    if (!Number.isInteger(limit) || limit < 1 || limit > LIM.queryLimit) throw new HttpError(400, `limit must be 1-${LIM.queryLimit}`)
    const offset = body.offset === undefined ? 0 : body.offset
    if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) throw new HttpError(400, 'offset must be a non-negative integer')
    const { rows, plan } = runQuery(coll, body)
    const keyOfRow = (row) => sort.map(([segs]) => getOne(row.data, segs))
    const cmp = (a, b) => {
      for (let i = 0; i < sort.length; i++) { const c = cmpSort(a.k[i], b.k[i]) * sort[i][1]; if (c) return c }
      // stable default order: creation time, then id
      return a.row.createdAt < b.row.createdAt ? -1 : a.row.createdAt > b.row.createdAt ? 1 : a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0
    }
    const keyed = rows.map((row) => ({ row, k: keyOfRow(row) }))
    keyed.sort(cmp)
    let start = offset
    if (body.cursor) {
      const cur = decodeCursor(body.cursor)
      const probe = { row: { id: cur.id, createdAt: cur.c }, k: cur.k }
      let lo = 0, hi = keyed.length
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cmp(keyed[mid], probe) <= 0) lo = mid + 1; else hi = mid }
      start = lo
    }
    const page = keyed.slice(start, start + limit)
    const last = page.at(-1)
    const hasMore = start + limit < keyed.length
    return {
      documents: page.map(({ row }) => ({ ...view(row), data: project(row.data, body.project) })),
      count: page.length, total: keyed.length,
      nextCursor: hasMore && last ? encodeCursor({ id: last.row.id, c: last.row.createdAt, k: last.k }) : null,
      plan,
    }
  }

  /* ================================================================== routes ================================================================== */
  const S = (user) => stateOf(user.id)
  const bodyObj = (b) => { if (!isObj(b)) throw new HttpError(400, 'JSON body must be an object'); return b }

  r.get('/api/db', ({ user }) => {
    const st = S(user)
    return { collections: [...st.colls.values()].map((c) => ({ name: c.name, count: c.docs.size, indexes: [...c.indexes].map(([field, ix]) => ({ field, unique: ix.unique })), hasSchema: !!c.meta?.schema, ttlField: c.meta?.ttlField ?? null, publicRead: !!c.meta?.publicRead })).filter((c) => c.count > 0 || c.indexes.length || c.hasSchema).sort((a, b) => a.name.localeCompare(b.name)), totalDocuments: st.total, limits: { documents: LIM.userDocs(), documentBytes: LIM.docBytes() } }
  })

  // atomic batch / transaction across collections
  r.post('/api/db/_batch', ({ user, body }) => {
    const ops = bodyObj(body).ops
    if (!Array.isArray(ops) || !ops.length || ops.length > LIM.batchOps) throw new HttpError(400, `ops must be an array of 1-${LIM.batchOps} operations`)
    const st = S(user)
    const touched = new Set()
    const results = []
    pendingEvents = []
    try {
      const run = () => {
        ops.forEach((op, i) => {
          try {
            if (!isObj(op)) throw new HttpError(400, 'Each op must be an object')
            const name = collName(op.collection); touched.add(name)
            const ev = op.ifVersion === undefined ? undefined : op.ifVersion
            if (ev !== undefined && !(Number.isInteger(ev) && ev >= 1)) throw new HttpError(400, 'ifVersion must be a positive integer')
            const coll = st.colls.get(name)
            if (op.op === 'insert') { const row = writeDoc(user.id, st, name, { id: op.id, data: op.data, mode: 'insert' }); results.push({ op: 'insert', id: kid(row), version: row.version }) }
            else if (op.op === 'set') {
              const exists = typeof op.id === 'string' && coll?.docs.has(op.id)
              if (!exists) { if (typeof op.id !== 'string') throw new HttpError(400, 'set needs an id'); const row = writeDoc(user.id, st, name, { id: op.id, data: op.data, mode: 'insert' }); results.push({ op: 'set', id: kid(row), version: row.version }) }
              else { const row = writeDoc(user.id, st, name, { id: op.id, data: op.data, expectVersion: ev, mode: 'replace' }); results.push({ op: 'set', id: kid(row), version: row.version }) }
            } else if (op.op === 'patch') {
              const cur = coll?.docs.get(op.id)
              if (!cur) throw new HttpError(404, 'Document not found')
              const row = writeDoc(user.id, st, name, { id: op.id, data: applyPatch(cur.data, op.patch), expectVersion: ev, mode: 'replace' }); results.push({ op: 'patch', id: kid(row), version: row.version })
            } else if (op.op === 'delete') { writeDoc(user.id, st, name, { id: op.id, expectVersion: ev, mode: 'delete' }); results.push({ op: 'delete', id: op.id }) }
            else if (op.op === 'check') {
              const cur = coll?.docs.get(op.id)
              if (op.exists === false ? !!cur : !cur) throw new HttpError(412, op.exists === false ? 'Document exists' : 'Document does not exist')
              if (ev !== undefined && cur && (cur.version ?? 1) !== ev) throw new HttpError(412, 'Version mismatch')
              results.push({ op: 'check', id: op.id })
            } else throw new HttpError(400, 'op must be insert, set, patch, delete or check')
          } catch (e) { if (e instanceof HttpError) { e.message = `ops[${i}]: ${e.message}`; e.opIndex = i } throw e }
        })
      }
      if (typeof db.transaction === 'function') db.transaction(run); else run()
    } catch (e) {
      pendingEvents = null
      invalidate(user.id) // rolled back rows: rebuild the in-memory view from storage
      throw e
    }
    const evs = pendingEvents; pendingEvents = null
    for (const [s, ev] of evs) deliver(s, ev)
    return { ok: true, results }
  })

  r.get('/api/db/:collection/watch', ({ user, params, query, req, res }) => {
    const name = collName(params.collection)
    const st = S(user)
    let pred = null
    if (query.get('where')) {
      if (query.get('where').length > 2048) throw new HttpError(400, 'where is too long')
      let w; try { w = JSON.parse(query.get('where')) } catch { throw new HttpError(400, 'where must be JSON') }
      pred = compileWhere(w)
    }
    const set = st.watchers.get(name) ?? new Set()
    let total = 0
    for (const s of st.watchers.values()) total += s.size
    if (total >= LIM.watchers) throw new HttpError(429, `At most ${LIM.watchers} open watches`)
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    const w = { res, pred }
    const last = Number(req.headers['last-event-id'] ?? query.get('since'))
    if (Number.isFinite(last) && last > 0) {
      const oldest = st.log[0]?.seq ?? st.seq + 1
      if (last + 1 < oldest && st.seq > last) res.write('event: reset\ndata: {"reason":"history truncated; refetch the collection"}\n\n')
      else for (const ev of st.log) if (ev.seq > last && ev.name === name) writeEvent(w, ev)
    } else res.write(`event: ready\nid: ${st.seq}\ndata: {"seq":${st.seq}}\n\n`)
    set.add(w); st.watchers.set(name, set)
    const hb = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n') }, 25_000)
    hb.unref?.()
    const onShutdown = () => { try { res.end() } catch { /* ignore */ } }
    const done = () => { clearInterval(hb); set.delete(w); ctx.events.off('shutdown', onShutdown) }
    ctx.events.on('shutdown', onShutdown)
    req.on('close', done); res.on('close', done)
    return HANDLED
  }, { stream: true })

  r.get('/api/db/:collection/export', ({ user, params }) => {
    const c = S(user).colls.get(collName(params.collection))
    if (!c) throw new HttpError(404, 'Collection not found')
    if (c.docs.size > LIM.exportDocs) throw new HttpError(413, 'Collection too large to export in one request; query with pagination')
    const lines = []
    for (const row of c.docs.values()) if (isLive(row, c)) lines.push(JSON.stringify({ id: kid(row), data: row.data }))
    return { text: lines.join('\n') + (lines.length ? '\n' : ''), type: 'application/x-ndjson; charset=utf-8', headers: { 'content-disposition': `attachment; filename="${params.collection}.ndjson"` } }
  })
  r.post('/api/db/:collection/import', ({ user, params, raw }) => {
    const name = collName(params.collection)
    const lines = raw.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    if (!lines.length) throw new HttpError(400, 'Empty import')
    if (lines.length > LIM.importLines) throw new HttpError(413, `At most ${LIM.importLines} lines per import`)
    const st = S(user)
    const parsed = lines.map((l, i) => { try { const o = JSON.parse(l); if (!isObj(o)) throw new Error('not an object'); return o } catch { throw new HttpError(400, `Line ${i + 1} is not a JSON object`) } })
    let ids = []
    try {
      const run = () => { for (const [i, o] of parsed.entries()) { try { const hasEnvelope = isObj(o.data) && Object.keys(o).every((k) => ['id', 'data'].includes(k)); const row = writeDoc(user.id, st, name, { id: hasEnvelope && typeof o.id === 'string' ? o.id : undefined, data: hasEnvelope ? o.data : o, mode: 'insert' }); ids.push(row.id) } catch (e) { if (e instanceof HttpError) e.message = `line ${i + 1}: ${e.message}`; throw e } } }
      pendingEvents = []
      if (typeof db.transaction === 'function') db.transaction(run); else run()
    } catch (e) { pendingEvents = null; invalidate(user.id); throw e }
    const evs = pendingEvents; pendingEvents = null
    for (const [s, ev] of evs) deliver(s, ev)
    return [201, { imported: ids.length }]
  }, { raw: true })

  r.get('/api/db/:collection/indexes', ({ user, params }) => {
    const c = S(user).colls.get(collName(params.collection))
    return { indexes: c ? [...c.indexes].map(([field, ix]) => ({ field, unique: ix.unique, keys: ix.map.size })) : [] }
  })
  r.post('/api/db/:collection/indexes', ({ user, params, body }) => {
    const name = collName(params.collection)
    const st = S(user)
    const field = bodyObj(body).field
    splitPath(field)
    const c = ensureMeta(st, user.id, name)
    if (c.indexes.has(field)) throw new HttpError(409, 'Index already exists')
    if (c.indexes.size >= LIM.indexes) throw new HttpError(409, `At most ${LIM.indexes} indexes per collection`)
    buildIndex(c, field, body.unique === true)
    saveMeta(c, { indexes: [...(c.meta.indexes ?? []), { field, unique: body.unique === true }] })
    return [201, { field, unique: body.unique === true }]
  })
  r.delete('/api/db/:collection/indexes/:field', ({ user, params }) => {
    const c = S(user).colls.get(collName(params.collection))
    if (!c || !c.indexes.has(params.field)) throw new HttpError(404, 'Index not found')
    c.indexes.delete(params.field)
    saveMeta(c, { indexes: (c.meta.indexes ?? []).filter((i) => i.field !== params.field) })
    return { ok: true }
  })

  r.get('/api/db/:collection/schema', ({ user, params }) => ({ schema: S(user).colls.get(collName(params.collection))?.meta?.schema ?? null }))
  r.put('/api/db/:collection/schema', ({ user, params, body }) => {
    const name = collName(params.collection)
    const st = S(user)
    const schema = bodyObj(body).schema
    if (JSON.stringify(schema ?? null).length > LIM.schemaBytes) throw new HttpError(413, 'Schema too large')
    const c = ensureMeta(st, user.id, name)
    if (schema === null) { saveMeta(c, { schema: null }); return { schema: null, invalidExisting: 0 } }
    checkSchemaShape(schema)
    let invalid = 0
    for (const row of c.docs.values()) { const errors = []; validateAgainst(schema, row.data, '', errors); if (errors.length) invalid++ }
    saveMeta(c, { schema })
    return { schema, invalidExisting: invalid, note: invalid ? 'Existing documents are not rewritten; they must satisfy the schema when next modified.' : undefined }
  })
  r.delete('/api/db/:collection/schema', ({ user, params }) => { const c = S(user).colls.get(collName(params.collection)); if (c?.meta) saveMeta(c, { schema: null }); return { ok: true } })

  r.patch('/api/db/:collection/settings', ({ user, params, body }) => {
    const name = collName(params.collection)
    const c = ensureMeta(S(user), user.id, name)
    const patch = {}
    if (body.ttlField !== undefined) { if (body.ttlField !== null) splitPath(body.ttlField); patch.ttlField = body.ttlField }
    if (body.publicRead !== undefined) patch.publicRead = body.publicRead === true
    saveMeta(c, patch)
    return { ttlField: c.meta.ttlField, publicRead: !!c.meta.publicRead }
  })

  r.post('/api/db/:collection/rename', ({ user, params, body }) => {
    const from = collName(params.collection), to = collName(bodyObj(body).name)
    const st = S(user)
    const c = st.colls.get(from)
    if (!c) throw new HttpError(404, 'Collection not found')
    if (st.colls.has(to) && st.colls.get(to).docs.size) throw new HttpError(409, 'Target collection already exists')
    const run = () => { for (const row of c.docs.values()) db.update('docs', row.id, { collection: to }); if (c.meta) db.update('db_meta', c.meta.id, { collection: to }) }
    if (typeof db.transaction === 'function') db.transaction(run); else run()
    invalidate(user.id)
    return { ok: true, name: to }
  })
  r.delete('/api/db/:collection', ({ user, params, req }) => {
    const name = collName(params.collection)
    const st = S(user)
    const c = st.colls.get(name)
    if (!c) throw new HttpError(404, 'Collection not found')
    const n = c.docs.size
    const run = () => { for (const row of [...c.docs.values()]) db.remove('docs', row.id); if (c.meta) db.remove('db_meta', c.meta.id) }
    if (typeof db.transaction === 'function') db.transaction(run); else run()
    invalidate(user.id)
    audit(user.id, 'db.collection.drop', name, { documents: n })
    void req
    return { ok: true, deleted: n }
  })

  r.post('/api/db/:collection/aggregate', ({ user, params, body }) => {
    const c = S(user).colls.get(collName(params.collection))
    bodyObj(body)
    if (!c) return { groups: [] }
    const { rows } = runQuery(c, { where: body.where })
    const groupBy = body.groupBy === undefined ? [] : [].concat(body.groupBy).map((g) => { if (typeof g !== 'string') throw new HttpError(400, 'groupBy must be field paths'); return [g, splitPath(g)] })
    if (groupBy.length > 3) throw new HttpError(400, 'Group by at most 3 fields')
    const metrics = body.metrics ?? { count: { op: 'count' } }
    if (!isObj(metrics) || Object.keys(metrics).length > 10) throw new HttpError(400, 'metrics must be an object with at most 10 entries')
    const specs = Object.entries(metrics).map(([alias, m]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(alias) || !isObj(m) || !['count', 'sum', 'avg', 'min', 'max'].includes(m.op)) throw new HttpError(400, 'Each metric needs a simple alias and op count|sum|avg|min|max')
      return { alias, op: m.op, segs: m.op === 'count' && m.field === undefined ? null : splitPath(m.field) }
    })
    const groups = new Map()
    const now = Date.now()
    for (const row of rows) {
      if (!isLive(row, c, now)) continue
      const key = groupBy.map(([, segs]) => getOne(row.data, segs) ?? null)
      const gk = JSON.stringify(key)
      let g = groups.get(gk)
      if (!g) groups.set(gk, (g = { key, acc: specs.map(() => ({ n: 0, sum: 0, min: undefined, max: undefined })) }))
      specs.forEach((s, i) => {
        const a = g.acc[i]
        if (s.op === 'count' && !s.segs) { a.n++; return }
        const v = getOne(row.data, s.segs)
        if (v === undefined || v === null) return
        if (s.op === 'count') { a.n++; return }
        if (s.op === 'min' || s.op === 'max') { if (a[s.op] === undefined || (cmpSort(v, a[s.op]) * (s.op === 'min' ? 1 : -1)) < 0) a[s.op] = v; return }
        if (typeof v === 'number' && Number.isFinite(v)) { a.n++; a.sum += v }
      })
    }
    let out = [...groups.values()].map((g) => {
      const o = {}
      groupBy.forEach(([f], i) => { o[f] = g.key[i] })
      specs.forEach((s, i) => { const a = g.acc[i]; o[s.alias] = s.op === 'count' ? a.n : s.op === 'sum' ? a.sum : s.op === 'avg' ? (a.n ? a.sum / a.n : null) : a[s.op] ?? null })
      return o
    })
    if (body.sort) {
      const sorts = parseSort(body.sort)
      out.sort((x, y) => { for (const [, dir, f] of sorts) { const c = cmpSort(x[f], y[f]) * dir; if (c) return c } return 0 })
    }
    const limit = body.limit === undefined ? 1000 : body.limit
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new HttpError(400, 'limit must be 1-10000')
    out = out.slice(0, limit)
    return { groups: out, matched: rows.length }
  })

  r.post('/api/db/:collection/explain', ({ user, params, body }) => {
    const c = S(user).colls.get(collName(params.collection))
    return c ? runQuery(c, { where: bodyObj(body).where }, { forExplain: true }) : { plan: { type: 'scan', scanned: 0 } }
  })
  r.post('/api/db/:collection/query', ({ user, params, body }) => {
    const c = S(user).colls.get(collName(params.collection))
    bodyObj(body)
    if (!c) return { documents: [], count: 0, total: 0, nextCursor: null, plan: { type: 'scan', scanned: 0 } }
    return execute(c, body)
  })
  r.get('/api/db/:collection', ({ user, params, query }) => {
    const c = S(user).colls.get(collName(params.collection))
    if (!c) return { documents: [], count: 0, total: 0, nextCursor: null }
    const out = execute(c, { limit: query.get('limit') ? Number(query.get('limit')) : LIM.queryLimit, sort: query.get('sort') ?? undefined, cursor: query.get('cursor') ?? undefined })
    delete out.plan
    return out
  })
  r.post('/api/db/:collection', ({ user, params, body }) => {
    const name = collName(params.collection)
    const row = writeDoc(user.id, S(user), name, { data: bodyObj(body), mode: 'insert' })
    return [201, view(row)]
  })

  const getRow = (user, params) => {
    const c = S(user).colls.get(collName(params.collection))
    const row = c?.docs.get(params.id)
    if (!row || !isLive(row, c)) throw new HttpError(404, 'Document not found')
    return row
  }
  r.get('/api/db/:collection/:id', ({ user, params }) => view(getRow(user, params)))
  r.put('/api/db/:collection/:id', ({ user, params, body, req, query }) => {
    getRow(user, params)
    return view(writeDoc(user.id, S(user), params.collection, { id: params.id, data: bodyObj(body), expectVersion: ifMatch(req, query), mode: 'replace' }))
  })
  r.patch('/api/db/:collection/:id', ({ user, params, body, req, query }) => {
    const row = getRow(user, params)
    return view(writeDoc(user.id, S(user), params.collection, { id: params.id, data: applyPatch(row.data, bodyObj(body)), expectVersion: ifMatch(req, query), mode: 'replace' }))
  })
  r.delete('/api/db/:collection/:id', ({ user, params, req, query }) => {
    getRow(user, params)
    writeDoc(user.id, S(user), params.collection, { id: params.id, expectVersion: ifMatch(req, query), mode: 'delete' })
    return { ok: true }
  })

  /* ---- public read access (opt-in per collection) ---- */
  const publicColl = (ownerId, name) => {
    if (typeof ownerId !== 'string') throw new HttpError(404, 'Not found')
    const owner = db.get('users', ownerId)
    const c = owner && NAME_RE.test(name) ? stateOf(ownerId).colls.get(name) : null
    if (!c?.meta?.publicRead) throw new HttpError(404, 'Not found')
    return c
  }
  r.get('/api/public/db/:owner/:collection', ({ params, query }) => {
    const c = publicColl(params.owner, params.collection)
    const limit = Math.min(100, Math.max(1, Number(query.get('limit')) || 50))
    const out = execute(c, { limit, sort: query.get('sort') ?? undefined, cursor: query.get('cursor') ?? undefined })
    return { documents: out.documents.map(({ id, data, version, updatedAt }) => ({ id, data, version, updatedAt })), nextCursor: out.nextCursor }
  }, { public: true })
  r.get('/api/public/db/:owner/:collection/:id', ({ params }) => {
    const c = publicColl(params.owner, params.collection)
    const row = c.docs.get(params.id)
    if (!row || !isLive(row, c)) throw new HttpError(404, 'Not found')
    return { id: kid(row), data: row.data, version: row.version ?? 1, updatedAt: row.updatedAt ?? row.createdAt }
  }, { public: true })

  /* ---- TTL sweeper ---- */
  function sweepTtl(now = Date.now()) {
    let n = 0
    for (const [userId, st] of states) {
      for (const c of st.colls.values()) {
        if (!c.meta?.ttlField) continue
        for (const row of [...c.docs.values()]) if (!isLive(row, c, now)) {
          db.remove('docs', row.id); indexRemove(c, row); c.docs.delete(kid(row)); st.total--; emit(st, c.name, 'delete', row); n++
        }
      }
      void userId
    }
    return n
  }
  // users whose state is not loaded are swept lazily when next touched (reads already hide expired documents)
  const timer = setInterval(() => { try { sweepTtl() } catch (e) { console.error('[db] ttl sweep failed:', e.message) } }, 30_000)
  timer.unref?.()
  ctx.events.on('shutdown', () => clearInterval(timer))
  ctx.dbSweep = sweepTtl
  ctx.events.on('account.deleted', ({ userId }) => { states.delete(userId) })
}
