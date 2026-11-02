// Observability: structured logging, request metrics (Prometheus), per-user monitoring + request logs, tracing, alerts,
// synthetic uptime checks and signed webhook channels. See docs/observability.md.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { HttpError, required } from '../http.js'
import { deriveKey } from '../auth.js'
import { safeRequest, SsrfError } from '../ssrf.js'

const MODULES_DIR = path.dirname(fileURLToPath(import.meta.url))
const envInt = (name, dflt, min, max) => { const n = Number(process.env[name]); return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : dflt }
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
const LIM = {
  logBuffer: () => envInt('RD_LOG_BUFFER', 2000, 100, 100_000), userRing: () => envInt('RD_OBS_USER_RING', 3000, 100, 100_000), maxUsers: 2000, routeKeys: 600,
  slowMs: () => envInt('RD_SLOW_MS', 1000, 10, 600_000), alerts: 20, checks: 10, channels: 5, results: 200, deliveries: 100, history: 100,
  allowPrivate: () => process.env.RD_OBS_ALLOW_PRIVATE === '1', // tests only
}
const iso = (t = Date.now()) => new Date(t).toISOString()
const SECRET_KEY = /authorization|token|password|passwd|secret|cookie|api[-_]?key|credential|signature|hash|private/i
const SECRET_VALUE = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}|rdk_[a-f0-9]{16,}|[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{20,}/g

/** Deep-copy with secrets replaced (keys that look sensitive, bearer tokens, API keys, JWT-like strings). Bounded depth/size. */
export function redact(v, depth = 0) {
  if (typeof v === 'string') return v.replace(SECRET_VALUE, (m, p1) => (p1 ? `${p1}[redacted]` : '[redacted]')).slice(0, 2000)
  if (v === null || typeof v !== 'object') return v
  if (depth > 4) return '[depth]'
  if (v instanceof Error) return { name: v.name, message: redact(v.message, depth + 1) }
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1))
  const out = {}
  for (const [k, x] of Object.entries(v).slice(0, 50)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(x, depth + 1)
  return out
}

class Ring {
  constructor(cap) { this.cap = cap; this.a = []; this.start = 0 }
  push(x) { if (this.a.length < this.cap) this.a.push(x); else { this.a[this.start] = x; this.start = (this.start + 1) % this.cap } }
  /** newest first */
  *newest() { const n = this.a.length; for (let i = 0; i < n; i++) yield this.a[(this.start + n - 1 - i) % n] }
  get size() { return this.a.length }
}
const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null)

export function register(r, db, ctx) {
  const by = (col, field, value) => (typeof db.findBy === 'function' ? db.findBy(col, field, value) : db.find(col, (x) => x[field] === value))
  const als = new AsyncLocalStorage()
  const startedAt = Date.now()

  /* ------------------------------------------------------------------ logger */
  const logBuf = new Ring(LIM.logBuffer())
  function log(level, msg, fields = {}) {
    const lv = LEVELS[level] ?? 20
    if (lv < (LEVELS[process.env.RD_LOG_LEVEL] ?? LEVELS.info)) return
    const store = als.getStore()
    const entry = { ts: iso(), level, msg: redact(String(msg)), ...(store?.rc?.requestId ? { requestId: store.rc.requestId } : {}), ...(fields && typeof fields === 'object' ? redact(fields) : {}) }
    logBuf.push(entry)
    if (process.env.RD_LOG_STDOUT === '1') process.stderr.write(JSON.stringify(entry) + '\n')
  }
  ctx.log = log

  /* ------------------------------------------------------------------ request metrics */
  const routes = new Map() // key -> { n, sum, buckets[], bytes? }
  let inflight = 0
  const totals = { requests: 0, errors5xx: 0 }
  const userRings = new Map() // userId -> Ring of request records
  const ringOf = (userId) => {
    let rg = userRings.get(userId)
    if (!rg) {
      rg = new Ring(LIM.userRing())
      userRings.set(userId, rg)
      if (userRings.size > LIM.maxUsers) userRings.delete(userRings.keys().next().value)
    }
    return rg
  }
  const statusClass = (s) => `${Math.floor(s / 100)}xx`
  function recordRequest(info) {
    const { req, status, durationMs, pattern, user, requestId } = info
    const route = pattern ?? (req.method === 'GET' && !req.url?.startsWith('/api/') ? 'static' : 'unmatched')
    const key = `${req.method}|${route}|${statusClass(status)}`
    let m = routes.get(key)
    if (!m) { if (routes.size >= LIM.routeKeys) return; routes.set(key, (m = { n: 0, sum: 0, buckets: new Array(BUCKETS.length + 1).fill(0) })) }
    m.n++; m.sum += durationMs
    let i = 0
    while (i < BUCKETS.length && durationMs > BUCKETS[i]) i++
    m.buckets[i]++
    totals.requests++
    if (status >= 500) totals.errors5xx++
    if (user) {
      const qi = req.url.indexOf('?')
      ringOf(user.id).push({ ts: Date.now(), ms: Math.round(durationMs * 10) / 10, status, method: req.method, route, path: (qi < 0 ? req.url : req.url.slice(0, qi)).slice(0, 200), requestId, keyId: info.auth?.keyId ?? null, via: info.auth?.via ?? null })
    }
    if (durationMs >= LIM.slowMs()) log('warn', 'slow request', { method: req.method, route, status, durationMs: Math.round(durationMs), spans: info.spans ?? [] })
  }
  ctx.hooks.onRequest.push((rc) => {
    inflight++
    rc.res.once('close', () => { inflight = Math.max(0, inflight - 1) })
    rc.spans = []
    als.enterWith({ rc })
  })
  ctx.hooks.onRequestEnd.push((info) => { try { recordRequest(info) } catch (e) { console.error('[observability] metric failed:', e.message) } })

  /** Time a unit of work inside the current request: `await ctx.trace('db.query', () => ...)`. Spans appear in slow-request logs. */
  ctx.trace = async (name, fn) => {
    const t0 = performance.now()
    try { return await fn() } finally {
      const rc = als.getStore()?.rc
      if (rc?.spans && rc.spans.length < 50) rc.spans.push({ name: String(name).slice(0, 80), ms: Math.round((performance.now() - t0) * 10) / 10 })
    }
  }

  /* ------------------------------------------------------------------ process metrics + status */
  const eld = monitorEventLoopDelay({ resolution: 20 })
  eld.enable()
  const lagMs = (q) => { const v = q === 'mean' ? eld.mean : eld.percentile(q); return Number.isFinite(v) ? v / 1e6 : 0 } // NaN until the first sample
  const mods = fs.readdirSync(MODULES_DIR).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).sort()
  function status() {
    const health = typeof db.health === 'function' ? db.health() : { ok: true }
    const failed = new Map((ctx.loadErrors ?? []).map((e) => [e.module.replace(/\.js$/, ''), e.error]))
    const lag = lagMs('mean')
    const components = {
      database: { ok: health.ok !== false },
      eventLoop: { ok: lag < 250, meanLagMs: +lag.toFixed(2), p99LagMs: +lagMs(99).toFixed(2) },
      modules: Object.fromEntries([...mods, 'auth', 'ai', 'drive', 'billing'].map((m) => [m, failed.has(m) ? { ok: false, error: String(failed.get(m)).slice(0, 200) } : { ok: true }])),
    }
    const ok = components.database.ok && components.eventLoop.ok && failed.size === 0
    return { status: ok ? 'ok' : 'degraded', startedAt: iso(startedAt), uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), components }
  }
  r.get('/api/status', () => status(), { public: true })
  r.get('/api/live', () => ({ ok: true }), { public: true })
  r.get('/api/ready', () => { const s = status(); return s.components.database.ok && s.status !== 'degraded' ? { ready: true } : [503, { ready: false, status: s }] }, { public: true })

  const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
  function prometheus() {
    const L = []
    const metric = (name, help, type, rows) => { L.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...rows) }
    const rows = []
    for (const [key, m] of routes) { const [method, route, st] = key.split('|'); rows.push(`rd_http_requests_total{method="${esc(method)}",route="${esc(route)}",status="${st}"} ${m.n}`) }
    metric('rd_http_requests_total', 'HTTP requests handled', 'counter', rows)
    const h = []
    for (const [key, m] of routes) {
      const [method, route, st] = key.split('|')
      const lab = `method="${esc(method)}",route="${esc(route)}",status="${st}"`
      let cum = 0
      BUCKETS.forEach((b, i) => { cum += m.buckets[i]; h.push(`rd_http_request_duration_seconds_bucket{${lab},le="${b / 1000}"} ${cum}`) })
      h.push(`rd_http_request_duration_seconds_bucket{${lab},le="+Inf"} ${m.n}`, `rd_http_request_duration_seconds_sum{${lab}} ${(m.sum / 1000).toFixed(6)}`, `rd_http_request_duration_seconds_count{${lab}} ${m.n}`)
    }
    metric('rd_http_request_duration_seconds', 'HTTP request latency', 'histogram', h)
    metric('rd_http_requests_in_flight', 'Requests currently being served', 'gauge', [`rd_http_requests_in_flight ${inflight}`])
    const mem = process.memoryUsage()
    metric('process_resident_memory_bytes', 'Resident memory', 'gauge', [`process_resident_memory_bytes ${mem.rss}`])
    metric('nodejs_heap_used_bytes', 'V8 heap used', 'gauge', [`nodejs_heap_used_bytes ${mem.heapUsed}`])
    metric('nodejs_eventloop_lag_seconds', 'Event loop delay', 'gauge', [`nodejs_eventloop_lag_seconds{quantile="mean"} ${(lagMs('mean') / 1000).toFixed(6)}`, `nodejs_eventloop_lag_seconds{quantile="0.99"} ${(lagMs(99) / 1000).toFixed(6)}`])
    metric('process_uptime_seconds', 'Process uptime', 'gauge', [`process_uptime_seconds ${Math.round(process.uptime())}`])
    metric('rd_module_load_failures', 'Modules that failed to load', 'gauge', [`rd_module_load_failures ${(ctx.loadErrors ?? []).length}`])
    if (typeof db.stats === 'function') {
      try {
        const st = db.stats()
        const num = [];
        (function walk(o, p) { for (const [k, v] of Object.entries(o ?? {})) { if (typeof v === 'number' && Number.isFinite(v)) num.push(`rd_db_${p}${k.replace(/[^a-zA-Z0-9_]/g, '_')} ${v}`); else if (v && typeof v === 'object' && !Array.isArray(v) && p.length < 24) walk(v, `${p}${k.replace(/[^a-zA-Z0-9_]/g, '_')}_`) } })(st, '')
        metric('rd_db', 'Storage engine statistics', 'untyped', num.slice(0, 80))
      } catch { /* stats unavailable */ }
    }
    return L.join('\n') + '\n'
  }
  r.get('/metrics', ({ req }) => {
    const token = process.env.RD_METRICS_TOKEN
    if (!token) throw new HttpError(404, 'Not found')
    const got = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    const a = crypto.createHash('sha256').update(got).digest(), b = crypto.createHash('sha256').update(token).digest()
    if (!crypto.timingSafeEqual(a, b)) { const e = new HttpError(401, 'Unauthorized'); e.headers = { 'www-authenticate': 'Bearer' }; throw e }
    return { text: prometheus(), type: 'text/plain; version=0.0.4; charset=utf-8' }
  }, { public: true })

  /* ------------------------------------------------------------------ per-user monitoring */
  const windowMs = (w) => ({ '1h': 3600_000, '24h': 86_400_000 })[w ?? '1h'] ?? (() => { throw new HttpError(400, 'window must be 1h or 24h') })()
  function statsFor(userId, from, to = Date.now()) {
    const out = { requests: 0, errors5xx: 0, errors4xx: 0, durations: [], endpoints: new Map(), keys: new Map() }
    const rg = userRings.get(userId)
    if (!rg) return out
    for (const e of rg.newest()) {
      if (e.ts < from) break
      if (e.ts > to) continue
      out.requests++; out.durations.push(e.ms)
      if (e.status >= 500) out.errors5xx++; else if (e.status >= 400) out.errors4xx++
      const k = `${e.method} ${e.route}`
      const ep = out.endpoints.get(k) ?? { n: 0, errors: 0, sum: 0 }; ep.n++; ep.sum += e.ms; if (e.status >= 500) ep.errors++; out.endpoints.set(k, ep)
      const kk = e.keyId ?? (e.via === 'session' ? 'session' : 'other')
      out.keys.set(kk, (out.keys.get(kk) ?? 0) + 1)
    }
    return out
  }
  r.get('/api/monitoring/overview', ({ user, query }) => {
    const w = windowMs(query.get('window'))
    const s = statsFor(user.id, Date.now() - w)
    const sorted = s.durations.slice().sort((a, b) => a - b)
    const buckets = new Map()
    const step = w <= 3600_000 ? 300_000 : 3600_000
    const rg = userRings.get(user.id)
    if (rg) for (const e of rg.newest()) { if (e.ts < Date.now() - w) break; const t = Math.floor(e.ts / step) * step; const b = buckets.get(t) ?? { t: iso(t), requests: 0, errors: 0, ms: [] }; b.requests++; if (e.status >= 500) b.errors++; b.ms.push(e.ms); buckets.set(t, b) }
    return {
      window: query.get('window') ?? '1h', requests: s.requests, errors5xx: s.errors5xx, errors4xx: s.errors4xx, errorRate: s.requests ? +((s.errors5xx / s.requests) * 100).toFixed(2) : 0,
      latency: { p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), p99: quantile(sorted, 0.99) },
      topEndpoints: [...s.endpoints].sort((a, b) => b[1].n - a[1].n).slice(0, 10).map(([endpoint, e]) => ({ endpoint, requests: e.n, errors: e.errors, avgMs: +(e.sum / e.n).toFixed(1) })),
      byKey: [...s.keys].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, n]) => ({ key: id === 'session' ? 'console session' : id === 'other' ? 'other' : (db.get('apiKeys', id)?.name ?? id), id: ['session', 'other'].includes(id) ? null : id, requests: n })),
      series: [...buckets.values()].sort((a, b) => a.t.localeCompare(b.t)).map((b) => { const m = b.ms.sort((x, y) => x - y); return { t: b.t, requests: b.requests, errors: b.errors, p95: quantile(m, 0.95) } }),
    }
  })
  r.get('/api/monitoring/logs', ({ user, query }) => {
    const limit = Math.min(200, Math.max(1, Number(query.get('limit')) || 50))
    const minStatus = query.get('status') ? Number(query.get('status')) : null
    if (minStatus !== null && !(minStatus >= 100 && minStatus <= 599)) throw new HttpError(400, 'status must be an HTTP status code or class start (e.g. 500)')
    const exact = query.get('status') && query.get('status').length === 3 && !query.get('status').endsWith('00')
    const before = query.get('cursor') ? Number(query.get('cursor')) : Infinity
    const since = query.get('since') ? Date.parse(query.get('since')) : 0, until = query.get('until') ? Date.parse(query.get('until')) : Infinity
    if (Number.isNaN(since) || Number.isNaN(until)) throw new HttpError(400, 'since/until must be ISO dates')
    const path = (query.get('path') ?? '').slice(0, 200), method = (query.get('method') ?? '').toUpperCase(), rid = query.get('requestId') ?? ''
    const rows = []
    const rg = userRings.get(user.id)
    let hasMore = false, last = null
    if (rg) for (const e of rg.newest()) {
      if (e.ts >= before || e.ts > until) continue
      if (e.ts < since) break
      if (minStatus !== null && (exact ? e.status !== minStatus : e.status < minStatus || e.status >= minStatus + 100)) continue
      if (path && !e.path.includes(path)) continue
      if (method && e.method !== method) continue
      if (rid && e.requestId !== rid) continue
      if (rows.length >= limit) { hasMore = true; break }
      rows.push(e); last = e
    }
    return { logs: rows.map((e) => ({ at: iso(e.ts), method: e.method, path: e.path, route: e.route, status: e.status, durationMs: e.ms, requestId: e.requestId, key: e.keyId ? (db.get('apiKeys', e.keyId)?.name ?? e.keyId) : e.via === 'session' ? 'console session' : null })), nextCursor: hasMore && last ? String(last.ts) : null }
  })

  /* ------------------------------------------------------------------ notification channels (webhooks) */
  const mine = (col, userId) => by(col, 'userId', userId)
  const own = (col, user, id, what) => { const row = typeof id === 'string' ? db.get(col, id) : null; if (!row || row.userId !== user.id) throw new HttpError(404, `${what} not found`); return row }
  const key = () => deriveKey(ctx, 'obs-channels')
  const seal = (plain, aad) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv); c.setAAD(Buffer.from(aad)); const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64') }
  const open = (blob, aad) => { const b = Buffer.from(blob, 'base64'); const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12)); d.setAAD(Buffer.from(aad)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8') }
  const chView = (c) => ({ id: c.id, name: c.name, url: c.url, events: c.events, enabled: c.enabled, createdAt: c.createdAt })
  const checkUrl = (u) => {
    let url; try { url = new URL(u) } catch { throw new HttpError(400, 'url must be a valid URL') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || String(u).length > 500) throw new HttpError(400, 'url must be an http(s) URL without credentials (max 500 characters)')
    return url.toString()
  }
  r.get('/api/monitoring/channels', ({ user }) => ({ channels: mine('obs_channels', user.id).map(chView) }))
  r.post('/api/monitoring/channels', ({ user, body }) => {
    required(body, 'name', 'url')
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 60) throw new HttpError(400, 'name must be 1-60 characters')
    if (mine('obs_channels', user.id).length >= LIM.channels) throw new HttpError(409, `At most ${LIM.channels} channels`)
    const events = body.events ?? ['alert', 'uptime']
    if (!Array.isArray(events) || !events.length || events.some((e) => !['alert', 'uptime'].includes(e))) throw new HttpError(400, 'events must be a non-empty subset of ["alert","uptime"]')
    const secret = `whsec_${crypto.randomBytes(24).toString('hex')}`
    const c = db.insert('obs_channels', { userId: user.id, name: body.name.trim(), url: checkUrl(body.url), events, enabled: body.enabled !== false, secretSealed: '' })
    db.update('obs_channels', c.id, { secretSealed: seal(secret, `chan:${user.id}:${c.id}`) })
    return [201, { ...chView(c), secret }] // shown exactly once
  })
  r.patch('/api/monitoring/channels/:id', ({ user, params, body }) => {
    const c = own('obs_channels', user, params.id, 'Channel')
    const patch = {}
    if (body.name !== undefined) { if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 60) throw new HttpError(400, 'name must be 1-60 characters'); patch.name = body.name.trim() }
    if (body.url !== undefined) patch.url = checkUrl(body.url)
    if (body.enabled !== undefined) patch.enabled = body.enabled === true
    return chView(db.update('obs_channels', c.id, patch))
  })
  r.delete('/api/monitoring/channels/:id', ({ user, params }) => { const c = own('obs_channels', user, params.id, 'Channel'); db.remove('obs_channels', c.id); db.removeWhere('obs_deliveries', (d) => d.channelId === c.id); return { ok: true } })
  r.get('/api/monitoring/channels/:id/deliveries', ({ user, params }) => ({ deliveries: by('obs_deliveries', 'channelId', own('obs_channels', user, params.id, 'Channel').id).sort((a, b) => b.ts - a.ts).slice(0, 50).map((d) => ({ event: d.event, ok: d.ok, status: d.status ?? null, attempts: d.attempts, error: d.error ?? null, at: iso(d.ts) })) }))
  const BACKOFF = () => envInt('RD_OBS_RETRY_MS', 1000, 1, 60_000)
  async function deliver(c, event, payload) {
    const body = JSON.stringify({ event, createdAt: iso(), data: payload })
    const ts = Math.floor(Date.now() / 1000)
    let secret; try { secret = open(c.secretSealed, `chan:${c.userId}:${c.id}`) } catch { return }
    const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
    let attempts = 0, last = { ok: false, status: null, error: null }
    for (let i = 0; i < 3; i++) {
      attempts++
      try {
        const res = await safeRequest(c.url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-rd-event': event, 'x-rd-timestamp': String(ts), 'x-rd-signature': `v1=${sig}` }, timeoutMs: 8000, maxBytes: 16 * 1024, allowPrivate: LIM.allowPrivate() })
        last = { ok: res.status >= 200 && res.status < 300, status: res.status, error: null }
        if (last.ok) break
      } catch (e) { last = { ok: false, status: null, error: e instanceof SsrfError ? e.message : 'delivery failed' }; if (e instanceof SsrfError && /private|credentials|Only http|Invalid URL|Port/.test(e.message)) break }
      if (i < 2) await new Promise((res) => setTimeout(res, BACKOFF() * 5 ** i))
    }
    db.insert('obs_deliveries', { userId: c.userId, channelId: c.id, event, ...last, attempts, ts: Date.now() })
    const all = by('obs_deliveries', 'channelId', c.id)
    if (all.length > LIM.deliveries) for (const old of all.sort((a, b) => a.ts - b.ts).slice(0, all.length - LIM.deliveries)) db.remove('obs_deliveries', old.id)
    return last
  }
  r.post('/api/monitoring/channels/:id/test', async ({ user, params }) => {
    const c = own('obs_channels', user, params.id, 'Channel')
    const res = await deliver(c, 'test', { message: 'RD Cloude test notification' })
    return { delivered: !!res?.ok, status: res?.status ?? null, error: res?.error ?? null }
  })
  const notifyAll = (userId, event, title, body, level, extra) => {
    ctx.events.emit('notification', { userId, title, body, level, link: '#monitoring', source: event === 'alert' ? 'alerts' : 'uptime' })
    for (const c of mine('obs_channels', userId)) if (c.enabled && c.events.includes(event)) deliver(c, event, { title, body, level, ...extra }).catch(() => {})
  }

  /* ------------------------------------------------------------------ alerts */
  const ALERT_TYPES = { error_rate: { unit: '%', min: 0.1, max: 100 }, latency_p95: { unit: 'ms', min: 1, max: 600_000 }, error_count: { unit: 'errors', min: 1, max: 1_000_000 }, no_traffic: { unit: 'minutes', min: 1, max: 1440 } }
  const alertView = (a) => ({ id: a.id, name: a.name, type: a.type, threshold: a.threshold, windowMin: a.windowMin, enabled: a.enabled, state: a.state ?? 'ok', silencedUntil: a.silencedUntil ? iso(a.silencedUntil) : null, lastValue: a.lastValue ?? null, lastEvaluatedAt: a.lastEvaluatedAt ? iso(a.lastEvaluatedAt) : null })
  function parseAlert(body, cur = {}) {
    const type = body.type ?? cur.type
    if (!ALERT_TYPES[type]) throw new HttpError(400, `type must be one of: ${Object.keys(ALERT_TYPES).join(', ')}`)
    const threshold = body.threshold ?? cur.threshold
    const t = ALERT_TYPES[type]
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < t.min || threshold > t.max) throw new HttpError(400, `threshold must be between ${t.min} and ${t.max} (${t.unit})`)
    const windowMin = body.windowMin ?? cur.windowMin ?? 5
    if (!Number.isInteger(windowMin) || windowMin < 1 || windowMin > 1440) throw new HttpError(400, 'windowMin must be an integer between 1 and 1440')
    const name = body.name ?? cur.name
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new HttpError(400, 'name must be 1-80 characters')
    return { name: name.trim(), type, threshold, windowMin }
  }
  r.get('/api/monitoring/alerts', ({ user }) => ({ alerts: mine('obs_alerts', user.id).map(alertView) }))
  r.post('/api/monitoring/alerts', ({ user, body }) => {
    if (mine('obs_alerts', user.id).length >= LIM.alerts) throw new HttpError(409, `At most ${LIM.alerts} alert rules`)
    return [201, alertView(db.insert('obs_alerts', { userId: user.id, ...parseAlert(body), enabled: body.enabled !== false, state: 'ok' }))]
  })
  r.patch('/api/monitoring/alerts/:id', ({ user, params, body }) => {
    const a = own('obs_alerts', user, params.id, 'Alert rule')
    return alertView(db.update('obs_alerts', a.id, { ...parseAlert(body, a), ...(body.enabled !== undefined ? { enabled: body.enabled === true } : {}) }))
  })
  r.delete('/api/monitoring/alerts/:id', ({ user, params }) => { const a = own('obs_alerts', user, params.id, 'Alert rule'); db.remove('obs_alerts', a.id); db.removeWhere('obs_alert_events', (e) => e.ruleId === a.id); return { ok: true } })
  r.post('/api/monitoring/alerts/:id/silence', ({ user, params, body }) => {
    const a = own('obs_alerts', user, params.id, 'Alert rule')
    const minutes = body.minutes ?? 60
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 10_080) throw new HttpError(400, 'minutes must be an integer between 0 and 10080')
    return alertView(db.update('obs_alerts', a.id, { silencedUntil: minutes ? Date.now() + minutes * 60_000 : null }))
  })
  r.get('/api/monitoring/alerts/history', ({ user }) => ({ events: mine('obs_alert_events', user.id).sort((a, b) => b.ts - a.ts).slice(0, LIM.history).map((e) => ({ rule: e.ruleName, type: e.type, state: e.state, value: e.value, threshold: e.threshold, at: iso(e.ts) })) }))
  function evaluateAlerts(now = Date.now()) {
    let fired = 0
    for (const a of db.find('obs_alerts', (x) => x.enabled)) {
      const s = statsFor(a.userId, now - a.windowMin * 60_000, now)
      let value = null, breached = false
      if (a.type === 'error_rate') { value = s.requests >= 10 ? +((s.errors5xx / s.requests) * 100).toFixed(2) : null; breached = value !== null && value >= a.threshold }
      else if (a.type === 'latency_p95') { value = quantile(s.durations.slice().sort((x, y) => x - y), 0.95); breached = value !== null && s.requests >= 5 && value >= a.threshold }
      else if (a.type === 'error_count') { value = s.errors5xx; breached = value >= a.threshold }
      else if (a.type === 'no_traffic') { value = s.requests; const seen = userRings.get(a.userId)?.size > 0; breached = seen && value === 0 && now - (a.createdAtMs ?? Date.parse(a.createdAt)) >= a.threshold * 60_000 }
      const silenced = a.silencedUntil && a.silencedUntil > now
      const next = breached ? 'firing' : 'ok'
      const prev = a.state ?? 'ok' // db.update mutates `a` in place
      db.update('obs_alerts', a.id, { lastValue: value, lastEvaluatedAt: now })
      if (next === prev) continue
      db.update('obs_alerts', a.id, { state: next })
      db.insert('obs_alert_events', { userId: a.userId, ruleId: a.id, ruleName: a.name, type: a.type, state: next, value, threshold: a.threshold, ts: now })
      const evs = by('obs_alert_events', 'userId', a.userId)
      if (evs.length > LIM.history) for (const old of evs.sort((x, y) => x.ts - y.ts).slice(0, evs.length - LIM.history)) db.remove('obs_alert_events', old.id)
      if (!silenced) { notifyAll(a.userId, 'alert', next === 'firing' ? `Alert firing: ${a.name}` : `Alert resolved: ${a.name}`, `${a.type} is ${value ?? 'n/a'} (threshold ${a.threshold}, window ${a.windowMin} min).`, next === 'firing' ? 'critical' : 'success', { rule: a.name, state: next, value }); fired++ }
    }
    return fired
  }

  /* ------------------------------------------------------------------ uptime checks */
  const checkView = (c) => ({ id: c.id, name: c.name, url: c.url, intervalSec: c.intervalSec, expectedStatus: c.expectedStatus, timeoutMs: c.timeoutMs, enabled: c.enabled, state: c.state ?? 'unknown', lastCheckedAt: c.lastCheckedAt ? iso(c.lastCheckedAt) : null, ...uptimeOf(c.id) })
  function uptimeOf(id, windowMs = 86_400_000) {
    const rs = by('obs_results', 'checkId', id).filter((x) => x.ts >= Date.now() - windowMs)
    return { uptimePercent: rs.length ? +((rs.filter((x) => x.ok).length / rs.length) * 100).toFixed(2) : null, samples: rs.length, avgMs: rs.length ? Math.round(rs.reduce((s, x) => s + (x.ms ?? 0), 0) / rs.length) : null }
  }
  function parseCheck(body, cur = {}) {
    const url = checkUrl(body.url ?? cur.url)
    const intervalSec = body.intervalSec ?? cur.intervalSec ?? 300
    if (!Number.isInteger(intervalSec) || intervalSec < 60 || intervalSec > 3600) throw new HttpError(400, 'intervalSec must be an integer between 60 and 3600')
    const expectedStatus = body.expectedStatus ?? cur.expectedStatus ?? 200
    if (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) throw new HttpError(400, 'expectedStatus must be an HTTP status code')
    const timeoutMs = body.timeoutMs ?? cur.timeoutMs ?? 10_000
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 10_000) throw new HttpError(400, 'timeoutMs must be between 500 and 10000')
    const name = body.name ?? cur.name
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new HttpError(400, 'name must be 1-80 characters')
    return { name: name.trim(), url, intervalSec, expectedStatus, timeoutMs }
  }
  r.get('/api/monitoring/checks', ({ user }) => ({ checks: mine('obs_checks', user.id).map(checkView) }))
  r.post('/api/monitoring/checks', ({ user, body }) => {
    if (mine('obs_checks', user.id).length >= LIM.checks) throw new HttpError(409, `At most ${LIM.checks} uptime checks`)
    return [201, checkView(db.insert('obs_checks', { userId: user.id, ...parseCheck(body), enabled: body.enabled !== false, state: 'unknown', nextAt: Date.now() }))]
  })
  r.patch('/api/monitoring/checks/:id', ({ user, params, body }) => {
    const c = own('obs_checks', user, params.id, 'Check')
    return checkView(db.update('obs_checks', c.id, { ...parseCheck(body, c), ...(body.enabled !== undefined ? { enabled: body.enabled === true } : {}) }))
  })
  r.delete('/api/monitoring/checks/:id', ({ user, params }) => { const c = own('obs_checks', user, params.id, 'Check'); db.remove('obs_checks', c.id); db.removeWhere('obs_results', (x) => x.checkId === c.id); return { ok: true } })
  r.get('/api/monitoring/checks/:id/results', ({ user, params }) => ({ results: by('obs_results', 'checkId', own('obs_checks', user, params.id, 'Check').id).sort((a, b) => b.ts - a.ts).slice(0, 100).map((x) => ({ at: iso(x.ts), ok: x.ok, status: x.status ?? null, ms: x.ms ?? null, error: x.error ?? null })) }))
  let running = 0
  async function runCheck(c) {
    const t0 = Date.now()
    let res = { ok: false, status: null, ms: null, error: null }
    try {
      const r2 = await safeRequest(c.url, { method: 'GET', timeoutMs: c.timeoutMs, maxBytes: 64 * 1024, maxRedirects: 3, allowPrivate: LIM.allowPrivate() })
      res = { ok: r2.status === c.expectedStatus, status: r2.status, ms: Date.now() - t0, error: r2.status === c.expectedStatus ? null : `Expected ${c.expectedStatus}, got ${r2.status}` }
    } catch (e) { res = { ok: false, status: null, ms: Date.now() - t0, error: e instanceof SsrfError ? e.message : 'check failed' } }
    const fresh = db.get('obs_checks', c.id)
    if (!fresh) return res
    db.insert('obs_results', { userId: c.userId, checkId: c.id, ...res, ts: Date.now() })
    const all = by('obs_results', 'checkId', c.id)
    if (all.length > LIM.results) for (const old of all.sort((a, b) => a.ts - b.ts).slice(0, all.length - LIM.results)) db.remove('obs_results', old.id)
    const prevState = fresh.state // db.update mutates the row in place: remember the old state before updating
    const failures = res.ok ? 0 : (fresh.failures ?? 0) + 1
    const state = res.ok ? 'up' : failures >= 2 ? 'down' : prevState === 'up' ? 'up' : 'unknown' // two consecutive failures before declaring down
    db.update('obs_checks', c.id, { lastCheckedAt: Date.now(), failures, state, nextAt: Date.now() + fresh.intervalSec * 1000 })
    if (state !== prevState && (state === 'down' || (state === 'up' && prevState === 'down'))) notifyAll(c.userId, 'uptime', state === 'down' ? `Check down: ${c.name}` : `Check recovered: ${c.name}`, `${c.url} — ${res.error ?? 'OK'}`, state === 'down' ? 'critical' : 'success', { check: c.name, state, status: res.status })
    return res
  }
  r.post('/api/monitoring/checks/:id/run', async ({ user, params }) => { const c = own('obs_checks', user, params.id, 'Check'); const res = await runCheck(c); return { ...res, state: db.get('obs_checks', c.id)?.state } })
  async function tickChecks(now = Date.now()) {
    const due = db.find('obs_checks', (c) => c.enabled && c.nextAt <= now).slice(0, 8)
    await Promise.all(due.map(async (c) => { if (running >= 4) return; running++; try { db.update('obs_checks', c.id, { nextAt: now + c.intervalSec * 1000 }); await runCheck(c) } finally { running-- } }))
    return due.length
  }

  /* ------------------------------------------------------------------ timers + exports */
  const timers = [setInterval(() => { try { evaluateAlerts() } catch (e) { console.error('[observability] alert evaluation failed:', e.message) } }, 30_000), setInterval(() => { tickChecks().catch(() => {}) }, 10_000)]
  timers.forEach((t) => t.unref?.())
  ctx.obs = { recordRequest, evaluateAlerts, tickChecks, runCheck, status, prometheus, redact, logs: () => [...logBuf.newest()] }
  r.get('/api/monitoring/system-logs', ({ user, query }) => { // the caller's own correlated platform log lines only (by request ids from their request log)
    const ids = new Set()
    const rg = userRings.get(user.id)
    if (rg) for (const e of rg.newest()) { if (e.requestId) ids.add(e.requestId); if (ids.size >= 500) break }
    const lvl = LEVELS[query.get('level') ?? 'info'] ?? 20
    return { logs: [...logBuf.newest()].filter((l) => l.requestId && ids.has(l.requestId) && (LEVELS[l.level] ?? 20) >= lvl).slice(0, 100) }
  })
  ctx.events.on('shutdown', () => { timers.forEach(clearInterval); eld.disable() })
  ctx.events.on('account.deleted', ({ userId }) => {
    userRings.delete(userId)
    for (const col of ['obs_alerts', 'obs_alert_events', 'obs_checks', 'obs_results', 'obs_channels', 'obs_deliveries']) db.removeWhere(col, (x) => x.userId === userId)
  })
  ;(ctx.scopeRules ??= []).push(['/api/monitoring', 'compute'])
  log('info', 'observability ready')
}
