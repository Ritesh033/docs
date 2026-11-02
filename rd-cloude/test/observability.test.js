import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import { startTestApp } from './helpers.js'
import { redact } from '../src/modules/observability.js'

async function withApp(fn, env = {}) {
  const old = {}
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; process.env[k] = v }
  const app = await startTestApp()
  try { await fn(app) } finally {
    await app.close()
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const synth = (user, status = 200, ms = 10, extra = {}) => ({ req: { method: 'GET', url: '/api/x?token=secret123' }, status, durationMs: ms, pattern: '/api/x', user: { id: user.user.id }, requestId: `r-${Math.random().toString(36).slice(2, 8)}`, auth: null, ...extra })
const notifications = async (u) => (await u.call('GET', '/api/notifications?limit=50')).data.notifications

test('redaction: sensitive keys, bearer tokens, API keys and JWT-like strings never reach logs', () => {
  const out = redact({ authorization: 'Bearer abcdefghijklmnop', password: 'hunter2', nested: { apiKey: 'k', Cookie: 'sid=1', ok: 'visible', arr: [{ secretToken: 'x' }, 'Bearer zzzzzzzzzzzzzzzz'] }, msg: 'key rdk_0123456789abcdef0123 used', jwt: 'aaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbb.cccccccccccccccccccc', n: 5 })
  assert.equal(out.authorization, '[redacted]'); assert.equal(out.password, '[redacted]'); assert.equal(out.nested.apiKey, '[redacted]'); assert.equal(out.nested.Cookie, '[redacted]'); assert.equal(out.nested.ok, 'visible')
  assert.equal(out.nested.arr[0].secretToken, '[redacted]'); assert.match(out.nested.arr[1], /Bearer \[redacted\]/)
  assert.ok(!out.msg.includes('0123456789abcdef0123')); assert.equal(out.jwt, '[redacted]'); assert.equal(out.n, 5)
  assert.equal(redact('x'.repeat(5000)).length, 2000, 'long strings are cut')
  const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } }
  assert.equal(JSON.stringify(redact(deep)).includes('[depth]'), true)
  assert.deepEqual(redact(new Error('boom Bearer abcdefghijklmnop')), { name: 'Error', message: 'boom Bearer [redacted]' })
  assert.equal(redact(null), null)
})

test('logger: levels, bounded ring buffer and request correlation with tracing spans on slow requests', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    app.ctx.log('debug', 'hidden'); app.ctx.log('info', 'visible', { password: 'p', n: 1 })
    const logs = app.ctx.obs.logs()
    assert.ok(!logs.some((l) => l.msg === 'hidden')); const v = logs.find((l) => l.msg === 'visible')
    assert.equal(v.password, '[redacted]'); assert.equal(v.n, 1); assert.equal(v.level, 'info')
    for (let i = 0; i < 300; i++) app.ctx.log('info', `m${i}`)
    assert.equal(app.ctx.obs.logs().length, 100, 'the ring buffer is bounded (RD_LOG_BUFFER)')
    assert.equal(app.ctx.obs.logs()[0].msg, 'm299', 'newest first')
    // request-scoped trace + slow log
    app.ctx.router.get('/api/test-trace', async () => { await app.ctx.trace('db.query', () => sleep(40)); await app.ctx.trace('render', () => sleep(5)); app.ctx.log('info', 'inside the request'); return { ok: true } })
    const r = await u.call('GET', '/api/test-trace', { headers: { 'x-request-id': 'trace-req-1' } })
    assert.equal(r.status, 200)
    await sleep(30)
    const slow = app.ctx.obs.logs().find((l) => l.msg === 'slow request')
    assert.ok(slow, 'slow request logged'); assert.equal(slow.route, '/api/test-trace')
    assert.deepEqual(slow.spans.map((s) => s.name), ['db.query', 'render']); assert.ok(slow.spans[0].ms >= 35)
    const inside = app.ctx.obs.logs().find((l) => l.msg === 'inside the request')
    assert.equal(inside.requestId, 'trace-req-1', 'log lines inside a request carry its id')
    assert.equal(r.headers.get('x-request-id'), 'trace-req-1')
  }, { RD_LOG_BUFFER: '100', RD_SLOW_MS: '30' })
})

test('prometheus: token-guarded, valid exposition, bounded label cardinality, cumulative histograms', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    assert.equal((await app.call('GET', '/metrics')).status, 404, 'no token configured -> the endpoint does not exist')
    process.env.RD_METRICS_TOKEN = 'metrics-secret-token'
    try {
      assert.equal((await app.call('GET', '/metrics')).status, 401)
      assert.equal((await app.call('GET', '/metrics', { token: 'wrong' })).status, 401)
      assert.equal((await app.call('GET', '/metrics', { token: 'metrics-secret-token-x' })).status, 401)
      for (let i = 0; i < 3; i++) await u.call('GET', '/api/me')
      for (let i = 0; i < 200; i++) await app.call('GET', `/api/random-${i}`)
      app.ctx.router.get('/api/test-500', () => { throw new Error('kaboom') })
      await u.call('GET', '/api/test-500')
      const m = await app.call('GET', '/metrics', { token: 'metrics-secret-token' })
      assert.equal(m.status, 200); assert.match(m.headers.get('content-type'), /text\/plain; version=0\.0\.4/)
      const text = m.data
      assert.match(text, /rd_http_requests_total\{method="GET",route="\/api\/me",status="2xx"\} 3/)
      assert.match(text, /rd_http_requests_total\{method="GET",route="\/api\/test-500",status="5xx"\} 1/)
      assert.match(text, /rd_http_requests_total\{method="GET",route="\/api\/\*unmatched",status="4xx"\} 200/, 'unknown paths share one label (no cardinality explosion)')
      assert.ok(!/random-1\b/.test(text))
      for (const needle of ['process_resident_memory_bytes', 'nodejs_heap_used_bytes', 'nodejs_eventloop_lag_seconds{quantile="0.99"}', 'process_uptime_seconds', 'rd_http_requests_in_flight', 'rd_module_load_failures 0', 'rd_db_']) assert.ok(text.includes(needle), needle)
      for (const line of text.trim().split('\n')) assert.match(line, /^(# (HELP|TYPE) [a-zA-Z_:][\w:]* .+|[a-zA-Z_:][\w:]*(\{[^}]*\})? -?\d+(\.\d+)?(e[+-]?\d+)?)$/, line)
      // histogram sanity for /api/me: buckets cumulative, +Inf == count == sum of counts
      const lab = 'method="GET",route="/api/me",status="2xx"'
      const buckets = [...text.matchAll(new RegExp(`rd_http_request_duration_seconds_bucket\\{${lab.replace(/[/]/g, '\\/')},le="([^"]+)"\\} (\\d+)`, 'g'))].map((x) => [x[1], Number(x[2])])
      assert.ok(buckets.length === 11 && buckets.at(-1)[0] === '+Inf' && buckets.at(-1)[1] === 3)
      for (let i = 1; i < buckets.length; i++) assert.ok(buckets[i][1] >= buckets[i - 1][1], 'cumulative')
      assert.match(text, new RegExp(`rd_http_request_duration_seconds_count\\{${lab.replace(/[/]/g, '\\/')}\\} 3`))
      assert.match(text, /rd_http_requests_in_flight [1-3]\b/, 'the scrape itself is in flight')
      const after = (await app.call('GET', '/metrics', { token: 'metrics-secret-token' })).data
      assert.match(after, /rd_http_requests_in_flight 1\n/, 'no leaked in-flight counts')
    } finally { delete process.env.RD_METRICS_TOKEN }
  })
})

test('monitoring overview and request log: per-user, percentile maths, filters, pagination, no query strings or secrets', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const key = (await u.call('POST', '/api/keys', { body: { name: 'ci-key' } })).data.secret
    app.ctx.router.get('/api/test-500', () => { throw new Error('kaboom') })
    for (let i = 0; i < 5; i++) await u.call('GET', '/api/me?token=super-secret-query')
    await app.call('GET', '/api/me', { token: key })
    await u.call('GET', '/api/test-500'); await u.call('GET', '/api/conversations/nothing-here')
    await v.call('GET', '/api/me')
    const o = (await u.call('GET', '/api/monitoring/overview')).data
    assert.ok(o.requests >= 9); assert.equal(o.errors5xx, 1); assert.ok(o.errors4xx >= 1); assert.ok(o.errorRate > 0 && o.errorRate < 20)
    assert.ok(o.latency.p50 >= 0 && o.latency.p95 >= o.latency.p50 && o.latency.p99 >= o.latency.p95)
    assert.equal(o.topEndpoints[0].endpoint, 'GET /api/me')
    assert.ok(o.byKey.some((k) => k.key === 'ci-key') && o.byKey.some((k) => k.key === 'console session'))
    assert.ok(o.series.length >= 1)
    assert.equal((await v.call('GET', '/api/monitoring/overview')).data.errors5xx, 0, 'other users see their own numbers')
    assert.equal((await u.call('GET', '/api/monitoring/overview?window=7d')).status, 400)
    assert.equal((await u.call('GET', '/api/monitoring/overview?window=24h')).data.window, '24h')
    const all = (await u.call('GET', '/api/monitoring/logs?limit=200')).data.logs
    assert.ok(!JSON.stringify(all).includes('super-secret-query') && !JSON.stringify(all).includes('token='), 'query strings are never stored')
    assert.ok(all.every((e) => !/^rdk_/.test(JSON.stringify(e))))
    assert.deepEqual((await u.call('GET', '/api/monitoring/logs?status=500')).data.logs.map((e) => e.status), [500])
    assert.ok((await u.call('GET', '/api/monitoring/logs?status=400')).data.logs.every((e) => e.status >= 400 && e.status < 500))
    assert.deepEqual((await u.call('GET', '/api/monitoring/logs?status=404')).data.logs.map((e) => e.path), ['/api/conversations/nothing-here'])
    assert.ok((await u.call('GET', '/api/monitoring/logs?path=test-500')).data.logs.every((e) => e.path.includes('test-500')))
    assert.equal((await u.call('GET', '/api/monitoring/logs?method=POST')).data.logs.filter((e) => e.method !== 'POST').length, 0)
    const first = (await u.call('GET', '/api/monitoring/logs?limit=3')).data
    assert.equal(first.logs.length, 3); assert.ok(first.nextCursor)
    const second = (await u.call('GET', `/api/monitoring/logs?limit=3&cursor=${first.nextCursor}`)).data
    assert.ok(second.logs.length > 0 && !second.logs.some((l) => first.logs.some((f) => f.requestId === l.requestId)), 'cursor pagination has no overlap')
    const rid = all[0].requestId
    assert.equal((await u.call('GET', `/api/monitoring/logs?requestId=${rid}`)).data.logs.length, 1)
    assert.equal((await u.call('GET', '/api/monitoring/logs?since=2999-01-01T00:00:00Z')).data.logs.length, 0)
    for (const qs of ['status=abc', 'status=99', 'status=700', 'since=notadate', 'until=x']) assert.equal((await u.call('GET', `/api/monitoring/logs?${qs}`)).status, 400, qs)
    assert.ok(!(await v.call('GET', '/api/monitoring/logs?limit=200')).data.logs.some((e) => e.path === '/api/conversations/nothing-here'), "another user's request log is invisible")
    assert.equal((await app.call('GET', '/api/monitoring/overview')).status, 401)
    // read-only API keys can read monitoring but not change it
    const ro = (await u.call('POST', '/api/keys', { body: { name: 'ro', scopes: ['compute:read'] } })).data.secret
    assert.equal((await app.call('GET', '/api/monitoring/overview', { token: ro })).status, 200)
    assert.equal((await app.call('POST', '/api/monitoring/alerts', { token: ro, body: { name: 'x', type: 'error_rate', threshold: 5 } })).status, 403)
  }, { RD_SLOW_MS: '60000' })
})

test('alerts: validation, firing and resolving with notifications, silences, limits, isolation', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    for (const body of [{}, { name: 'x', type: 'nope', threshold: 5 }, { name: 'x', type: 'error_rate', threshold: -1 }, { name: 'x', type: 'error_rate', threshold: 500 }, { name: '', type: 'error_rate', threshold: 5 }, { name: 'x', type: 'error_rate', threshold: 'x' }, { name: 'x', type: 'latency_p95', threshold: 100, windowMin: 0 }, { name: 'x', type: 'latency_p95', threshold: 100, windowMin: 5000 }]) assert.equal((await u.call('POST', '/api/monitoring/alerts', { body })).status, 400, JSON.stringify(body))
    const rule = (await u.call('POST', '/api/monitoring/alerts', { body: { name: 'High errors', type: 'error_rate', threshold: 20, windowMin: 5 } })).data
    assert.equal(rule.state, 'ok')
    const lat = (await u.call('POST', '/api/monitoring/alerts', { body: { name: 'Slow', type: 'latency_p95', threshold: 500, windowMin: 5 } })).data
    for (let i = 0; i < 8; i++) app.ctx.obs.recordRequest(synth(u, 200, 10))
    let now = Date.now() + 5
    assert.equal(app.ctx.obs.evaluateAlerts(now), 0, '0 % errors: nothing fires')
    for (let i = 0; i < 10; i++) app.ctx.obs.recordRequest(synth(u, 500, 20)) // other API calls in this test count as traffic too, so be unambiguous
    now = Date.now() + 5
    assert.equal(app.ctx.obs.evaluateAlerts(now), 1, 'well above 20 %')
    assert.equal(app.ctx.obs.evaluateAlerts(now), 0, 'firing is announced once')
    const alerts = (await u.call('GET', '/api/monitoring/alerts')).data.alerts
    assert.equal(alerts.find((a) => a.id === rule.id).state, 'firing'); assert.ok(alerts.find((a) => a.id === rule.id).lastValue > 20)
    const n = (await notifications(u)).find((x) => /High errors/.test(x.title))
    assert.ok(n && n.level === 'critical' && n.source === 'alerts' && n.link === '#monitoring')
    assert.equal((await notifications(v)).length, 0)
    // resolves when the window moves on
    assert.equal(app.ctx.obs.evaluateAlerts(now + 10 * 60_000), 1)
    assert.ok((await notifications(u)).some((x) => /resolved: High errors/.test(x.title)))
    const hist = (await u.call('GET', '/api/monitoring/alerts/history')).data.events
    assert.deepEqual(hist.filter((e) => e.rule === 'High errors').map((e) => e.state), ['ok', 'firing'])
    // latency with silence: history records it, nobody is notified
    for (let i = 0; i < 6; i++) app.ctx.obs.recordRequest(synth(u, 200, 900))
    assert.equal((await u.call('POST', `/api/monitoring/alerts/${lat.id}/silence`, { body: { minutes: 30 } })).data.silencedUntil !== null, true)
    app.ctx.obs.evaluateAlerts(Date.now())
    assert.ok((await u.call('GET', '/api/monitoring/alerts/history')).data.events.some((e) => e.rule === 'Slow' && e.state === 'firing'))
    assert.ok(!(await notifications(u)).some((x) => /Slow/.test(x.title)), 'silenced')
    assert.equal((await u.call('POST', `/api/monitoring/alerts/${lat.id}/silence`, { body: { minutes: 999999 } })).status, 400)
    assert.equal((await u.call('PATCH', `/api/monitoring/alerts/${lat.id}`, { body: { threshold: 50 } })).data.threshold, 50)
    assert.equal((await u.call('PATCH', `/api/monitoring/alerts/${lat.id}`, { body: { threshold: -5 } })).status, 400)
    // isolation + caps
    for (const [m, p, body] of [['PATCH', `/api/monitoring/alerts/${rule.id}`, { threshold: 1 }], ['DELETE', `/api/monitoring/alerts/${rule.id}`], ['POST', `/api/monitoring/alerts/${rule.id}/silence`, {}]]) assert.equal((await v.call(m, p, body ? { body } : {})).status, 404)
    assert.equal((await v.call('GET', '/api/monitoring/alerts')).data.alerts.length, 0)
    for (let i = 0; i < 18; i++) assert.equal((await u.call('POST', '/api/monitoring/alerts', { body: { name: `r${i}`, type: 'error_count', threshold: 5 } })).status, 201)
    assert.equal((await u.call('POST', '/api/monitoring/alerts', { body: { name: 'one-too-many', type: 'error_count', threshold: 5 } })).status, 409)
    assert.equal((await u.call('DELETE', `/api/monitoring/alerts/${rule.id}`)).status, 200)
    // minimum sample size: a single failing request is not an incident
    const calm = await app.register()
    const calmRule = (await calm.call('POST', '/api/monitoring/alerts', { body: { name: 'err', type: 'error_rate', threshold: 10 } })).data
    app.ctx.obs.recordRequest(synth(calm, 500, 5))
    app.ctx.obs.evaluateAlerts()
    assert.equal((await calm.call('GET', '/api/monitoring/alerts')).data.alerts.find((a) => a.id === calmRule.id).state, 'ok', 'too few samples to call it an incident')
    assert.equal((await notifications(calm)).length, 0)
    // no-traffic
    const idle = await app.register()
    const nt = (await idle.call('POST', '/api/monitoring/alerts', { body: { name: 'silence', type: 'no_traffic', threshold: 5, windowMin: 5 } })).data
    app.ctx.obs.recordRequest(synth(idle, 200, 5), Date.now())
    app.ctx.obs.evaluateAlerts(Date.now() + 20 * 60_000)
    assert.equal((await idle.call('GET', '/api/monitoring/alerts')).data.alerts.find((a) => a.id === nt.id).state, 'firing')
    assert.ok((await notifications(idle)).some((n) => /Alert firing: silence/.test(n.title)))
  })
})

function startServer(handler) { return new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)) }) }

test('uptime checks: validation, SSRF protection, up/down transitions with notifications, results and uptime %', async () => {
  let mode = 'ok'
  const target = await startServer((req, res) => {
    if (req.url === '/redirect-private') { res.writeHead(302, { location: 'http://169.254.169.254/' }); return res.end() }
    if (req.url === '/slow') return setTimeout(() => { res.writeHead(200); res.end('late') }, 3000)
    if (mode === 'down') { res.writeHead(503); return res.end('down') }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('healthy')
  })
  const port = target.address().port
  try {
    await withApp(async (app) => {
      const u = await app.register(), v = await app.register()
      const mk = async (body) => (await u.call('POST', '/api/monitoring/checks', { body: { name: 'api', url: `http://127.0.0.1:${port}/`, intervalSec: 60, ...body } }))
      for (const body of [{ url: 'ftp://x.y/' }, { url: 'not a url' }, { url: 'http://user:pw@127.0.0.1/' }, { intervalSec: 5 }, { intervalSec: 99999 }, { expectedStatus: 42 }, { timeoutMs: 100 }, { name: '' }, { url: `http://x.example/${'a'.repeat(600)}` }]) assert.equal((await mk(body)).status, 400, JSON.stringify(body).slice(0, 60))
      const c = (await mk({})).data
      assert.equal(c.state, 'unknown'); assert.equal(c.uptimePercent, null)
      assert.equal((await v.call('POST', `/api/monitoring/checks/${c.id}/run`)).status, 404)
      // SSRF: loopback, link-local and redirects to them are refused when the test-only escape hatch is off
      for (const url of [`http://127.0.0.1:${port}/`, 'http://169.254.169.254/latest/meta-data/', 'http://localhost/', 'http://[::1]/', 'http://10.0.0.5/', 'http://0.0.0.0/']) {
        const x = (await u.call('POST', '/api/monitoring/checks', { body: { name: 'ssrf', url, intervalSec: 60 } })).data
        const r = (await u.call('POST', `/api/monitoring/checks/${x.id}/run`)).data
        assert.equal(r.ok, false, url); assert.match(r.error, /private|Port|resolve/, url)
        await u.call('DELETE', `/api/monitoring/checks/${x.id}`)
      }
    })
    await withApp(async (app) => {
      const u = await app.register()
      const c = (await u.call('POST', '/api/monitoring/checks', { body: { name: 'api', url: `http://127.0.0.1:${port}/`, intervalSec: 60 } })).data
      const run = async () => (await u.call('POST', `/api/monitoring/checks/${c.id}/run`)).data
      let r = await run()
      assert.equal(r.ok, true); assert.equal(r.status, 200); assert.equal(r.state, 'up')
      mode = 'down'
      r = await run(); assert.equal(r.ok, false); assert.match(r.error, /Expected 200, got 503/); assert.equal(r.state, 'up', 'one failure is not an outage')
      assert.ok(!(await notifications(u)).some((n) => /down/.test(n.title)))
      r = await run(); assert.equal(r.state, 'down')
      const down = (await notifications(u)).filter((n) => /Check down: api/.test(n.title))
      assert.equal(down.length, 1); assert.equal(down[0].level, 'critical')
      await run(); assert.equal((await notifications(u)).filter((n) => /Check down/.test(n.title)).length, 1, 'announced once')
      mode = 'ok'
      r = await run(); assert.equal(r.state, 'up')
      assert.ok((await notifications(u)).some((n) => /recovered: api/.test(n.title)))
      const results = (await u.call('GET', `/api/monitoring/checks/${c.id}/results`)).data.results
      assert.equal(results.length, 5); assert.equal(results[0].ok, true)
      const view = (await u.call('GET', '/api/monitoring/checks')).data.checks[0]
      assert.equal(view.samples, 5); assert.equal(view.uptimePercent, 40)
      // status mismatch configuration + redirects are re-validated, timeouts are honoured
      const e404 = (await u.call('POST', '/api/monitoring/checks', { body: { name: 'expects-404', url: `http://127.0.0.1:${port}/`, expectedStatus: 200, intervalSec: 60 } })).data
      assert.equal((await u.call('PATCH', `/api/monitoring/checks/${e404.id}`, { body: { expectedStatus: 404 } })).data.expectedStatus, 404)
      const t0 = Date.now()
      const slow = (await u.call('POST', '/api/monitoring/checks', { body: { name: 'slow', url: `http://127.0.0.1:${port}/slow`, timeoutMs: 600, intervalSec: 60 } })).data
      const sr = (await u.call('POST', `/api/monitoring/checks/${slow.id}/run`)).data
      assert.equal(sr.ok, false); assert.match(sr.error, /timed out/); assert.ok(Date.now() - t0 < 2500)
      // scheduler
      mode = 'ok'
      app.db.update('obs_checks', c.id, { nextAt: Date.now() - 1 })
      assert.ok((await app.ctx.obs.tickChecks()) >= 1)
      assert.equal((await u.call('GET', `/api/monitoring/checks/${c.id}/results`)).data.results.length, 6)
      assert.equal((await u.call('DELETE', `/api/monitoring/checks/${c.id}`)).status, 200)
      assert.equal(app.db.find('obs_results', (x) => x.checkId === c.id).length, 0)
      for (let i = 0; i < 9; i++) await u.call('POST', '/api/monitoring/checks', { body: { name: `c${i}`, url: 'http://example.com/' } })
      assert.equal((await u.call('POST', '/api/monitoring/checks', { body: { name: 'cap', url: 'http://example.com/' } })).status, 409)
    }, { RD_OBS_ALLOW_PRIVATE: '1' })
  } finally { target.close() }
})

test('webhook channels: secrets sealed and shown once, HMAC-signed payloads, retries, delivery log, SSRF protection', async () => {
  const received = []
  let failNext = 0
  const receiver = await startServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => { received.push({ headers: req.headers, body }); if (failNext > 0) { failNext--; res.writeHead(500); return res.end() } res.writeHead(204); res.end() })
  })
  const port = receiver.address().port
  try {
    await withApp(async (app) => {
      const u = await app.register(), v = await app.register()
      for (const body of [{}, { name: 'x', url: 'ftp://x/' }, { name: 'x', url: 'http://u:p@x.y/' }, { name: '', url: 'http://x.y/' }, { name: 'x', url: 'http://x.y/', events: [] }, { name: 'x', url: 'http://x.y/', events: ['nope'] }]) assert.equal((await u.call('POST', '/api/monitoring/channels', { body })).status, 400, JSON.stringify(body))
      const ch = (await u.call('POST', '/api/monitoring/channels', { body: { name: 'ops', url: `http://127.0.0.1:${port}/hook`, events: ['alert', 'uptime'] } })).data
      assert.match(ch.secret, /^whsec_[0-9a-f]{48}$/)
      const stored = app.db.get('obs_channels', ch.id)
      assert.ok(!JSON.stringify(stored).includes(ch.secret), 'the secret is stored encrypted')
      assert.equal((await u.call('GET', '/api/monitoring/channels')).data.channels[0].secret, undefined, 'and never shown again')
      // signed delivery
      const t = (await u.call('POST', `/api/monitoring/channels/${ch.id}/test`)).data
      assert.equal(t.delivered, true); assert.equal(t.status, 204)
      const d = received.at(-1)
      assert.equal(d.headers['x-rd-event'], 'test'); assert.match(d.headers['user-agent'], /RD-Cloude-Monitor/)
      const expected = crypto.createHmac('sha256', ch.secret).update(`${d.headers['x-rd-timestamp']}.${d.body}`).digest('hex')
      assert.equal(d.headers['x-rd-signature'], `v1=${expected}`, 'receivers can verify the HMAC')
      assert.equal(JSON.parse(d.body).event, 'test'); assert.ok(Math.abs(Number(d.headers['x-rd-timestamp']) - Date.now() / 1000) < 10)
      // retries with backoff
      failNext = 2
      const before = received.length
      const t2 = (await u.call('POST', `/api/monitoring/channels/${ch.id}/test`)).data
      assert.equal(t2.delivered, true); assert.equal(received.length - before, 3, 'two failures then success')
      const log = (await u.call('GET', `/api/monitoring/channels/${ch.id}/deliveries`)).data.deliveries
      assert.deepEqual(log.map((x) => [x.ok, x.attempts]), [[true, 3], [true, 1]])
      failNext = 99
      const t3 = (await u.call('POST', `/api/monitoring/channels/${ch.id}/test`)).data
      assert.equal(t3.delivered, false); assert.equal(t3.status, 500)
      failNext = 0
      // alerts and uptime transitions reach the channel
      await u.call('POST', '/api/monitoring/alerts', { body: { name: 'hook-alert', type: 'error_count', threshold: 2, windowMin: 5 } })
      for (let i = 0; i < 3; i++) app.ctx.obs.recordRequest(synth(u, 500, 5))
      const n0 = received.length
      app.ctx.obs.evaluateAlerts()
      await sleep(300)
      const ev = received.slice(n0).map((x) => JSON.parse(x.body)).find((x) => x.event === 'alert')
      assert.ok(ev && ev.data.rule === 'hook-alert' && ev.data.state === 'firing')
      // disabled channels and events that are not subscribed receive nothing
      await u.call('PATCH', `/api/monitoring/channels/${ch.id}`, { body: { enabled: false } })
      const n1 = received.length
      await u.call('POST', '/api/monitoring/alerts', { body: { name: 'second', type: 'error_count', threshold: 1, windowMin: 5 } })
      app.ctx.obs.evaluateAlerts(); await sleep(200)
      assert.equal(received.length, n1)
      // isolation + deletion
      assert.equal((await v.call('POST', `/api/monitoring/channels/${ch.id}/test`)).status, 404)
      assert.equal((await v.call('GET', `/api/monitoring/channels/${ch.id}/deliveries`)).status, 404)
      assert.equal((await v.call('DELETE', `/api/monitoring/channels/${ch.id}`)).status, 404)
      assert.equal((await u.call('DELETE', `/api/monitoring/channels/${ch.id}`)).status, 200)
      assert.equal(app.db.find('obs_deliveries', (x) => x.channelId === ch.id).length, 0)
      for (let i = 0; i < 5; i++) assert.equal((await u.call('POST', '/api/monitoring/channels', { body: { name: `c${i}`, url: 'http://example.com/h' } })).status, 201)
      assert.equal((await u.call('POST', '/api/monitoring/channels', { body: { name: 'cap', url: 'http://example.com/h' } })).status, 409)
    }, { RD_OBS_ALLOW_PRIVATE: '1', RD_OBS_RETRY_MS: '20' })
    // SSRF: without the escape hatch a loopback receiver is unreachable and no retries are wasted
    await withApp(async (app) => {
      const u = await app.register()
      const ch = (await u.call('POST', '/api/monitoring/channels', { body: { name: 'evil', url: `http://127.0.0.1:${port}/hook` } })).data
      const before = received.length
      const t = (await u.call('POST', `/api/monitoring/channels/${ch.id}/test`)).data
      assert.equal(t.delivered, false); assert.match(t.error, /private|loopback|Port/)
      assert.equal(received.length, before, 'nothing was sent to the internal address')
      const d = (await u.call('GET', `/api/monitoring/channels/${ch.id}/deliveries`)).data.deliveries[0]
      assert.equal(d.attempts, 1, 'policy failures are not retried')
    })
  } finally { receiver.close() }
})

test('status, liveness and readiness reflect real component health', async () => {
  await withApp(async (app) => {
    const s = (await app.call('GET', '/api/status')).data
    assert.equal(s.status, 'ok'); assert.equal(s.components.database.ok, true); assert.equal(s.components.modules.functions.ok, true); assert.equal(s.components.modules.observability.ok, true); assert.ok(s.uptimeSeconds >= 0)
    assert.equal((await app.call('GET', '/api/live')).data.ok, true)
    assert.equal((await app.call('GET', '/api/ready')).status, 200)
    app.ctx.loadErrors.push({ module: 'broken.js', error: 'SyntaxError: boom' })
    const d = await app.call('GET', '/api/status')
    assert.equal(d.data.status, 'degraded')
    assert.equal((await app.call('GET', '/api/ready')).status, 503)
    app.ctx.loadErrors.pop()
    assert.equal((await app.call('GET', '/api/ready')).status, 200)
  })
})

test('performance: the per-request hook is cheap and memory stays bounded', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const info = { req: { method: 'GET', url: '/api/things/123?x=1' }, status: 200, durationMs: 12.5, pattern: '/api/things/:id', user: { id: u.user.id }, requestId: 'bench', auth: null }
    const N = 200_000
    for (let i = 0; i < 1000; i++) app.ctx.obs.recordRequest(info) // warm up
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < N; i++) app.ctx.obs.recordRequest(info)
    const perCall = Number(process.hrtime.bigint() - t0) / N / 1000
    console.log(`# perf: recordRequest ${perCall.toFixed(2)} µs/call`)
    assert.ok(perCall < 50, `hook overhead ${perCall.toFixed(1)} µs exceeds the 50 µs budget`)
    const logs = (await u.call('GET', '/api/monitoring/logs?limit=200')).data.logs
    assert.equal(logs.length, 200)
    const ring = await u.call('GET', '/api/monitoring/overview?window=24h')
    assert.ok(ring.data.requests <= 500, `the per-user ring is bounded (${ring.data.requests})`)
  }, { RD_OBS_USER_RING: '500' })
})

test('account deletion removes monitoring data', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    await u.call('POST', '/api/monitoring/alerts', { body: { name: 'a', type: 'error_count', threshold: 5 } })
    await u.call('POST', '/api/monitoring/checks', { body: { name: 'c', url: 'http://example.com/' } })
    await u.call('POST', '/api/monitoring/channels', { body: { name: 'h', url: 'http://example.com/h' } })
    app.ctx.events.emit('account.deleted', { userId: u.user.id })
    for (const col of ['obs_alerts', 'obs_checks', 'obs_channels']) assert.equal(app.db.find(col, (x) => x.userId === u.user.id).length, 0, col)
  })
})
