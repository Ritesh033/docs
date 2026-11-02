// Usage metering + pricing shared by every service.
//
// Everything that costs money ends up as a row in the `usage` collection: {userId, kind, qty, day, ts, key?}.
//  * Event-style kinds (ai tokens, function invocations, requests, ...) are recorded by their module via record().
//  * State-derived kinds are metered lazily by syncDerived(): compute instance hours (delta since the last sync) and storage
//    GB-month (one idempotent row per full day). Both run before any summary and from the billing sweeper.
// Per-user in-memory rollups (day -> kind -> qty) make quota checks and charts O(1); old raw rows are compacted into daily rows.
import { HttpError } from './http.js'

const GiB = 1024 ** 3
const DAY = 86_400_000

/** unit/price are what clients see. `per` is the divisor applied to qty before multiplying by price (tokens, requests, ...). */
export const PRICES = {
  'ai.input_tokens': { unit: 'per 1M tokens', price: 3, per: 1e6 },
  'ai.output_tokens': { unit: 'per 1M tokens', price: 15, per: 1e6 },
  'storage.gb_month': { unit: 'per GB-month', price: 0.023, per: 1 },
  'storage.egress_gb': { unit: 'per GB', price: 0.09, per: 1 },
  'storage.requests': { unit: 'per 1M requests', price: 0.4, per: 1e6 },
  'compute.small': { unit: 'per hour', price: 0.01, per: 1 },
  'compute.medium': { unit: 'per hour', price: 0.04, per: 1 },
  'compute.large': { unit: 'per hour', price: 0.16, per: 1 },
  'compute.volume_gb_month': { unit: 'per GB-month', price: 0.08, per: 1 },
  'network.eip_hour': { unit: 'per hour', price: 0.005, per: 1 },
  'functions.invocations': { unit: 'per 1M invocations', price: 0.2, per: 1e6 },
  'functions.gb_seconds': { unit: 'per GB-second', price: 0.0000167, per: 1 },
  'sql.query': { unit: 'per 1M queries', price: 0.1, per: 1e6 },
  'sql.gb_month': { unit: 'per GB-month', price: 0.115, per: 1 },
  'api.requests': { unit: 'per 1M requests', price: 0.3, per: 1e6 },
}

export const INSTANCE_TYPES = {
  small: { vcpu: 1, memGb: 2 },
  medium: { vcpu: 2, memGb: 8 },
  large: { vcpu: 8, memGb: 32 },
}

export const service = (kind) => String(kind).split('.')[0]
export const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10)
export const monthKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 7)

export function priceOf(kind, qty) {
  const p = PRICES[kind]
  if (!p) return 0
  return (qty / (p.per || 1)) * p.price
}
const round = (n, d = 6) => +n.toFixed(d)
const validKind = (k) => typeof k === 'string' && /^[a-z0-9_]+(\.[a-z0-9_]+){1,3}$/.test(k) && k.length <= 64

/* ------------------------------------------------------------------ rollups */
// userId -> Map(day -> Map(kind -> qty)). Loaded lazily from rows, then kept current by record().
const caches = new WeakMap()
function cacheOf(db) {
  let c = caches.get(db)
  if (!c) caches.set(db, (c = { users: new Map(), listeners: new Set() }))
  return c
}
const rows = (db, userId) => (typeof db.findBy === 'function' ? db.findBy('usage', 'userId', userId) : db.find('usage', (u) => u.userId === userId))

function loadUser(db, userId) {
  const c = cacheOf(db)
  let days = c.users.get(userId)
  if (days) return days
  days = new Map()
  for (const u of rows(db, userId)) addToDays(days, u.day ?? dayKey(Date.parse(u.createdAt) || Date.now()), u.kind, u.qty)
  c.users.set(userId, days)
  if (c.users.size > 2000) c.users.delete(c.users.keys().next().value) // bounded; reloaded on demand
  return days
}
function addToDays(days, day, kind, qty) {
  let m = days.get(day)
  if (!m) days.set(day, (m = new Map()))
  m.set(kind, (m.get(kind) ?? 0) + qty)
}

/** Subscribe to every recorded usage row (budgets use this to re-evaluate lazily). Returns an unsubscribe fn. */
export function onRecord(db, fn) {
  const c = cacheOf(db)
  c.listeners.add(fn)
  return () => c.listeners.delete(fn)
}

/**
 * Record usage. qty must be a finite non-negative number. opts.key makes the call idempotent per (user, key).
 * Never throws for unknown kinds: they are stored and shown as "unpriced".
 */
export function record(db, userId, kind, qty, opts = {}) {
  if (!userId || !validKind(kind) || !Number.isFinite(qty) || qty < 0) return null
  if (qty === 0) return null
  const key = typeof opts.key === 'string' ? opts.key.slice(0, 120) : undefined
  if (key) {
    const dup = typeof db.findOneBy === 'function' ? db.findOneBy('usage', 'key', `${userId}|${key}`) : db.findOne('usage', (u) => u.key === `${userId}|${key}`)
    if (dup) return dup
  }
  const ts = Number.isFinite(opts.ts) ? opts.ts : Date.now() // opts.ts is for backfills/imports
  const day = dayKey(ts)
  const row = db.insert('usage', { userId, kind, qty, day, ts, ...(key ? { key: `${userId}|${key}` } : {}) })
  const c = cacheOf(db)
  const days = c.users.get(userId)
  if (days) addToDays(days, day, kind, qty)
  for (const fn of c.listeners) { try { fn(userId, kind, qty) } catch { /* listeners must not break metering */ } }
  return row
}

/** Sum of a kind (or a "service.*" wildcard) over [fromMs, toMs). Day granularity for rollups, exact for the current day. */
export function usageBetween(db, userId, kind, fromDay, toDay) {
  const days = loadUser(db, userId)
  let sum = 0
  const wild = kind.endsWith('.*') ? kind.slice(0, -1) : null
  for (const [day, m] of days) {
    if (day < fromDay || day > toDay) continue
    for (const [k, q] of m) if (wild ? k.startsWith(wild) : k === kind) sum += q
  }
  return sum
}

/** day -> kind -> qty for [fromDay, toDay] (inclusive, YYYY-MM-DD). */
export function dailyUsage(db, userId, fromDay, toDay) {
  const out = []
  for (const [day, m] of loadUser(db, userId)) {
    if (day < fromDay || day > toDay) continue
    out.push({ day, kinds: Object.fromEntries(m) })
  }
  return out.sort((a, b) => a.day.localeCompare(b.day))
}

/**
 * Fold raw usage rows older than `days` into one row per (user, kind, day) so the collection stays bounded.
 * Totals, rollups and timeseries are unchanged (hourly resolution is only kept for the raw window).
 */
export function compactUsage(db, { days = Number(process.env.RD_USAGE_RAW_DAYS) || 62, now = Date.now() } = {}) {
  const cutoff = now - days * DAY
  const old = db.find('usage', (u) => (u.ts ?? Date.parse(u.createdAt)) < cutoff && !u.compact && !u.key)
  if (!old.length) return { folded: 0, created: 0 }
  const groups = new Map()
  for (const u of old) {
    const day = u.day ?? dayKey(u.ts ?? Date.parse(u.createdAt))
    const k = `${u.userId}|${u.kind}|${day}`
    const g = groups.get(k) ?? { userId: u.userId, kind: u.kind, day, qty: 0, ids: [] }
    g.qty += u.qty
    g.ids.push(u.id)
    groups.set(k, g)
  }
  const apply = () => {
    for (const g of groups.values()) {
      for (const id of g.ids) db.remove('usage', id)
      db.insert('usage', { userId: g.userId, kind: g.kind, qty: g.qty, day: g.day, ts: Date.parse(`${g.day}T12:00:00Z`), compact: true })
    }
  }
  if (typeof db.transaction === 'function') db.transaction(apply)
  else apply()
  return { folded: old.length, created: groups.size }
}

/* ------------------------------------------------------------------ derived metering */
export function instanceHours(inst, now = Date.now()) {
  let ms = inst.accruedMs ?? 0
  if (inst.state === 'running' && inst.runningSince) ms += now - new Date(inst.runningSince).getTime()
  return ms / 36e5
}

export function storageBytes(db, userId) {
  const by = (col, f) => (typeof db.findBy === 'function' ? db.findBy(col, 'userId', userId) : db.find(col, (r) => r.userId === userId))
  const objs = by('objects').reduce((s, o) => s + (o.size ?? 0), 0)
  const files = by('files').reduce((s, f) => s + (f.versions ?? []).reduce((a, v) => a + (v.size ?? 0), 0), 0)
  return objs + files
}

/**
 * Meter state-derived usage up to "now": compute hours (delta since instance.billedHours) and storage GB-month
 * (one idempotent row per fully elapsed day, using the current byte count; at most 62 days of catch-up).
 */
export function syncDerived(db, userId, now = Date.now()) {
  const insts = typeof db.findBy === 'function' ? db.findBy('instances', 'userId', userId) : db.find('instances', (i) => i.userId === userId)
  for (const i of insts) {
    const h = instanceHours(i, now)
    const billed = i.billedHours ?? 0
    if (h - billed > 1e-9 && PRICES[`compute.${i.type}`]) {
      record(db, userId, `compute.${i.type}`, h - billed)
      db.update('instances', i.id, { billedHours: h })
    }
  }
  const st = db.findOne('billing_state', (s) => s.userId === userId) ?? db.insert('billing_state', { userId, storageDay: dayKey(now - DAY) })
  const yesterday = dayKey(now - DAY)
  if (st.storageDay < yesterday) {
    const bytes = storageBytes(db, userId)
    const sqlBytes = (typeof db.findBy === 'function' ? db.findBy('sql_databases', 'userId', userId) : db.find('sql_databases', (x) => x.userId === userId)).reduce((sum, x) => sum + (x.sizeBytes ?? 0), 0)
    if (bytes > 0 || sqlBytes > 0) {
      let d = Date.parse(`${st.storageDay}T00:00:00Z`) + DAY
      const end = Date.parse(`${yesterday}T00:00:00Z`)
      if (end - d > 62 * DAY) d = end - 61 * DAY
      for (; d <= end; d += DAY) {
        const day = dayKey(d)
        const dim = new Date(Date.UTC(new Date(d).getUTCFullYear(), new Date(d).getUTCMonth() + 1, 0)).getUTCDate()
        if (bytes > 0) record(db, userId, 'storage.gb_month', bytes / GiB / dim, { key: `storage:${day}` })
        if (sqlBytes > 0) record(db, userId, 'sql.gb_month', sqlBytes / GiB / dim, { key: `sql:${day}` })
      }
    }
    db.update('billing_state', st.id, { storageDay: yesterday })
  }
}

/* ------------------------------------------------------------------ summaries */
/** All-time usage summary (what /api/billing/usage returns). Line shape: {kind, qty, cost, unit, price, per, unpriced?}. */
export function summarize(db, userId, { fromDay, toDay } = {}) {
  syncDerived(db, userId)
  const totals = new Map()
  for (const [day, m] of loadUser(db, userId)) {
    if ((fromDay && day < fromDay) || (toDay && day > toDay)) continue
    for (const [k, q] of m) totals.set(k, (totals.get(k) ?? 0) + q)
  }
  const out = [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([kind, qty]) => {
    const p = PRICES[kind]
    return { kind, qty: round(qty, 9), cost: round(priceOf(kind, qty)), ...(p ? { unit: p.unit, price: p.price, per: p.per } : { unpriced: true }) }
  })
  return { lines: out, total: round(out.reduce((s, l) => s + l.cost, 0)), storageBytes: storageBytes(db, userId) }
}

/** Cost of one day-rollup entry. */
export function costOfKinds(kinds) {
  let total = 0
  for (const [k, q] of Object.entries(kinds)) total += priceOf(k, q)
  return total
}

export function billingRoutes(r, db, ctx) {
  r.get('/api/billing/usage', ({ user, query }) => {
    const from = query.get('from'), to = query.get('to')
    for (const v of [from, to]) if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, 'from/to must be YYYY-MM-DD')
    return summarize(db, user.id, { fromDay: from || undefined, toDay: to || undefined })
  })
  r.get('/api/billing/prices', () => ({ prices: PRICES, instanceTypes: INSTANCE_TYPES }))
  if (ctx) {
    ctx.billing = { record: (userId, kind, qty, opts) => record(db, userId, kind, qty, opts), summarize: (userId, o) => summarize(db, userId, o), PRICES }
    const timer = setInterval(() => { try { compactUsage(db) } catch (e) { console.error('[billing] compaction failed:', e.message) } }, 6 * 3600_000)
    timer.unref?.()
    ctx.events.on('shutdown', () => clearInterval(timer))
    ctx.events.on('account.deleted', ({ userId }) => cacheOf(db).users.delete(userId))
  }
}
