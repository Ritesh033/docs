import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startTestApp } from './helpers.js'
import { parseCron, nextCron, isPrivateIp } from '../src/modules/functions.js'

async function withApp(fn, env = {}) {
  const old = {}
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; process.env[k] = v }
  const app = await startTestApp()
  try {
    if (!app.ctx.functions.isolation.ready) { console.log('# skipped: sandbox primitives unavailable'); return }
    await fn(app)
  } finally {
    app.ctx.functions?.killAll()
    await app.close()
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}
const mk = async (u, name, code, extra = {}) => { const r = await u.call('POST', '/api/functions', { body: { name, code, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data }
const inv = (u, id, event = {}, extra = {}) => u.call('POST', `/api/functions/${id}/invoke`, { body: { event, ...extra } })

/* ------------------------------------------------------------------ pure units */
test('cron: parsing, validation and next-run computation (UTC)', () => {
  const t = (s, from) => new Date(nextCron(parseCron(s), Date.parse(from))).toISOString()
  assert.equal(t('* * * * *', '2026-01-01T00:00:30Z'), '2026-01-01T00:01:00.000Z')
  assert.equal(t('*/15 * * * *', '2026-01-01T00:16:00Z'), '2026-01-01T00:30:00.000Z')
  assert.equal(t('30 2 * * *', '2026-01-01T02:30:00Z'), '2026-01-02T02:30:00.000Z')
  assert.equal(t('0 9 * * mon', '2026-01-01T00:00:00Z'), '2026-01-05T09:00:00.000Z')
  assert.equal(t('0 0 1 jan *', '2026-01-01T00:00:00Z'), '2027-01-01T00:00:00.000Z')
  assert.equal(t('0 0 29 2 *', '2026-01-01T00:00:00Z'), '2028-02-29T00:00:00.000Z', 'leap day')
  assert.equal(t('1,2,3 4-5 * * *', '2026-03-03T04:03:00Z'), '2026-03-03T05:01:00.000Z')
  assert.equal(t('0 0 13 * fri', '2026-01-01T00:00:00Z'), '2026-01-02T00:00:00.000Z', 'dom OR dow when both are restricted')
  assert.equal(t('0 12 * * 7', '2026-01-01T00:00:00Z'), '2026-01-04T12:00:00.000Z', '7 is Sunday')
  for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '*/0 * * * *', 'a b c d e', '5-1 * * * *', '1- * * * *', `${'1,'.repeat(60)}1 * * * *`.slice(0, 200) + 'x', null, 5]) assert.throws(() => parseCron(bad), /cron|Cron/i, String(bad))
})

test('ssrf: private, loopback, link-local, mapped and metadata addresses are all recognised', () => {
  for (const ip of ['127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '240.0.0.1', '198.18.0.1', '192.0.2.5', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::10.0.0.1', '2001:db8::1', 'not-an-ip']) assert.equal(isPrivateIp(ip), true, ip)
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateIp(ip), false, ip)
})

/* ------------------------------------------------------------------ behaviour */
test('invoke: results, logs, ctx, env (secrets encrypted at rest and masked), require whitelist', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const f = await mk(u, 'hello', `const crypto = require('crypto')
module.exports = async (event, ctx) => {
  ctx.log('start', event.n)
  console.warn('careful')
  let blocked; try { require('fs') } catch (e) { blocked = e.code }
  return { double: event.n * 2, name: ctx.functionName, version: ctx.version, alias: ctx.alias, mem: ctx.memoryMb, left: ctx.getRemainingTimeMs() > 0, uuid: typeof crypto.randomUUID(), plain: ctx.env.GREETING, secret: process.env.API_TOKEN, blocked, node: process.version.startsWith('v22') }
}`, { memoryMb: 128, timeoutMs: 4000 })
    await u.call('PUT', `/api/functions/${f.id}/env`, { body: { env: { GREETING: { value: 'hello' }, API_TOKEN: { value: 's3cr3t-value', secret: true } } } })
    const view = (await u.call('GET', `/api/functions/${f.id}`)).data
    assert.deepEqual(view.env.API_TOKEN, { secret: true, value: null }); assert.deepEqual(view.env.GREETING, { secret: false, value: 'hello' })
    assert.ok(!JSON.stringify(app.db.get('fn_functions', f.id)).includes('s3cr3t-value'), 'secret is encrypted at rest')
    const r = await inv(u, f.id, { n: 21 })
    assert.equal(r.status, 200); assert.equal(r.data.status, 'ok')
    assert.deepEqual(r.data.result, { double: 42, name: 'hello', version: 1, alias: 'live', mem: 128, left: true, uuid: 'string', plain: 'hello', secret: 's3cr3t-value', blocked: 'MODULE_NOT_FOUND', node: true })
    assert.deepEqual(r.data.logs.map((l) => [l.level, l.line]), [['info', 'start 21'], ['warn', 'careful']])
    assert.ok(r.data.durationMs >= 0 && r.data.billedMs >= 100)
    // keeping a secret when only another variable changes
    await u.call('PUT', `/api/functions/${f.id}/env`, { body: { env: { GREETING: { value: 'bonjour' }, API_TOKEN: { secret: true } } } })
    assert.equal((await inv(u, f.id, { n: 1 })).data.result.secret, 's3cr3t-value')
    assert.equal((await inv(u, f.id, { n: 1 })).data.result.plain, 'bonjour')
    for (const env of [{ 'bad-name': 'x' }, { RD_SECRET_KEY: 'x' }, { A: 5 }, { A: 'x'.repeat(5000) }, { 'lower': 'x' }]) assert.equal((await u.call('PUT', `/api/functions/${f.id}/env`, { body: { env } })).status, 400, JSON.stringify(env).slice(0, 40))
    assert.equal((await u.call('PUT', `/api/functions/${f.id}/env`, { body: { env: { NEWSECRET: { secret: true } } } })).status, 400, 'a new variable needs a value')
  })
})

test('errors: thrown errors, rejections, unserialisable and oversized results, missing handler', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const cases = {
      throws: ["module.exports = async () => { throw new TypeError('nope') }", /TypeError: nope/],
      rejects: ["module.exports = () => Promise.reject(new Error('later'))", /later/],
      bigint: ["module.exports = async () => ({ x: 10n })", /not JSON-serialisable/],
      circular: ["module.exports = async () => { const a = {}; a.a = a; return a }", /not JSON-serialisable/],
      huge: ["module.exports = async () => 'x'.repeat(2 * 1024 * 1024)", /larger than/],
      nohandler: ["const x = 1", /must export a handler/],
      syntax: ["module.exports = async ( => {", /./],
      asyncThrow: ["module.exports = async () => { setTimeout(() => { throw new Error('async boom') }, 5); await new Promise((r) => setTimeout(r, 50)); return 'ok' }", null],
    }
    for (const [name, [code, re]] of Object.entries(cases)) {
      const f = await mk(u, `e-${name.toLowerCase()}`, code)
      const r = await inv(u, f.id)
      assert.equal(r.status, 200, name)
      if (re) { assert.equal(r.data.status, 'error', name); assert.match(`${r.data.error.name}: ${r.data.error.message}`, re, name) }
    }
    const undef = await mk(u, 'undef', 'module.exports = async () => undefined')
    assert.equal((await inv(u, undef.id)).data.result, null)
    const esm = await mk(u, 'esm', 'export default async (event) => ({ viaEsm: event.x })')
    assert.deepEqual((await inv(u, esm.id, { x: 1 })).data.result, { viaEsm: 1 })
    const named = await mk(u, 'named', 'export async function handler(event) { return { named: true } }')
    assert.deepEqual((await inv(u, named.id)).data.result, { named: true })
    // errors are recorded and the function keeps working
    const ok = await mk(u, 'recover', "module.exports = async (e) => { if (e.fail) throw new Error('x'); return 'fine' }")
    assert.equal((await inv(u, ok.id, { fail: true })).data.status, 'error')
    assert.equal((await inv(u, ok.id, {})).data.result, 'fine')
    const list = (await u.call('GET', `/api/functions/${ok.id}/invocations`)).data.invocations
    assert.deepEqual(list.map((x) => x.status), ['ok', 'error'])
  })
})

test('versions and aliases', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const f = await mk(u, 'ver', "module.exports = async () => 'v1'")
    const up = (await u.call('PUT', `/api/functions/${f.id}/code`, { body: { code: "module.exports = async () => 'v2'" } })).data
    assert.equal(up.latestVersion, 2); assert.equal(up.aliases.live, 2)
    assert.equal((await u.call('PUT', `/api/functions/${f.id}/code`, { body: { code: "module.exports = async () => 'v2'" } })).data.unchanged, true)
    assert.equal((await inv(u, f.id)).data.result, 'v2')
    assert.equal((await inv(u, f.id, {}, { version: 1 })).data.result, 'v1')
    assert.equal((await u.call('PUT', `/api/functions/${f.id}/aliases/staging`, { body: { version: 1 } })).data.aliases.staging, 1)
    assert.equal((await inv(u, f.id, {}, { alias: 'staging' })).data.result, 'v1')
    assert.equal((await inv(u, f.id, {}, { alias: 'nope' })).status, 404)
    assert.equal((await inv(u, f.id, {}, { version: 9 })).status, 404)
    assert.equal((await inv(u, f.id, {}, { version: 1, alias: 'live' })).status, 400)
    assert.equal((await u.call('PUT', `/api/functions/${f.id}/aliases/Bad_Alias`, { body: { version: 1 } })).status, 400)
    assert.equal((await u.call('PUT', `/api/functions/${f.id}/aliases/x`, { body: { version: 9 } })).status, 404)
    assert.equal((await u.call('DELETE', `/api/functions/${f.id}/aliases/live`)).status, 400)
    assert.equal((await u.call('DELETE', `/api/functions/${f.id}/aliases/staging`)).status, 200)
    assert.equal((await u.call('GET', `/api/functions/${f.id}/versions/1`)).data.code, "module.exports = async () => 'v1'")
    for (let i = 3; i < 60; i++) await u.call('PUT', `/api/functions/${f.id}/code`, { body: { code: `module.exports = async () => 'v${i}'` } })
    const vs = (await u.call('GET', `/api/functions/${f.id}/versions`)).data.versions
    assert.ok(vs.length <= 50 && vs.at(-1).version === 59, 'old versions are pruned')
  })
})

test('validation: names, code size, limits, ownership and isolation between users', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const post = (c, body) => c.call('POST', '/api/functions', { body })
    for (const bad of [{ name: 'A', code: 'x' }, { name: '1a', code: 'x' }, { name: 'a_b', code: 'x' }, { name: 'ok', code: '' }, { name: 'ok', code: 5 }, { name: 'ok', code: 'x'.repeat(300_000) }, { name: 'ok', code: 'x', memoryMb: 10 }, { name: 'ok', code: 'x', memoryMb: 9999 }, { name: 'ok', code: 'x', timeoutMs: 10 }, { name: 'ok', code: 'x', timeoutMs: 999999 }, { name: 'x'.repeat(49), code: 'x' }]) {
      const s = (await post(u, bad)).status
      assert.ok(s === 400 || s === 413, `${JSON.stringify(bad).slice(0, 50)} -> ${s}`)
    }
    const f = await mk(u, 'mine', "module.exports = async () => 'secret'")
    assert.equal((await post(u, { name: 'mine', code: 'x' })).status, 409)
    assert.equal((await post(v, { name: 'mine', code: 'x' })).status, 201, 'names are per user')
    for (const [m, p, body] of [['GET', `/api/functions/${f.id}`], ['PATCH', `/api/functions/${f.id}`, { description: 'x' }], ['DELETE', `/api/functions/${f.id}`], ['PUT', `/api/functions/${f.id}/code`, { code: 'x' }], ['POST', `/api/functions/${f.id}/invoke`, {}],
      ['GET', `/api/functions/${f.id}/invocations`], ['GET', `/api/functions/${f.id}/metrics`], ['PUT', `/api/functions/${f.id}/env`, { env: {} }], ['PUT', `/api/functions/${f.id}/trigger`, { http: { enabled: true } }], ['GET', `/api/functions/${f.id}/dlq`], ['GET', `/api/functions/${f.id}/versions`]]) {
      assert.equal((await v.call(m, p, body ? { body } : {})).status, 404, `${m} ${p}`)
    }
    assert.equal((await v.call('GET', '/api/functions')).data.functions.length, 1)
    assert.equal((await app.call('GET', '/api/functions')).status, 401)
    assert.equal((await u.call('PATCH', `/api/functions/${f.id}`, { body: { allowedHosts: ['http://evil.com/x'] } })).status, 400)
    assert.equal((await u.call('PATCH', `/api/functions/${f.id}`, { body: { allowedHosts: ['api.example.com', '*.example.org', 'host:8080'], allowNetwork: true } })).status, 200)
    assert.equal((await u.call('GET', '/api/functions/_runtime')).data.isolation.mode.length > 0, true)
    assert.equal((await u.call('DELETE', `/api/functions/${f.id}`)).status, 200)
    assert.equal(app.db.find('fn_invocations', (x) => x.fnId === f.id).length, 0)
  })
})

/* ------------------------------------------------------------------ SANDBOX */
const ESCAPE = `
const p = globalThis.process
const out = {}
const probe = async (name, fn) => { try { const v = await fn(); out[name] = v === undefined ? 'ok' : v } catch (e) { out[name] = 'ERR:' + (e.code || e.name) } }
module.exports = async (event) => {
  const b = (n) => p.getBuiltinModule('node:' + n)
  out.envKeys = Object.keys(p.env).filter((k) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(k))
  await probe('readPasswd', () => b('fs').readFileSync('/etc/passwd', 'utf8').length)
  await probe('readCwd', () => b('fs').readdirSync(p.cwd()).length)
  await probe('readProc', () => b('fs').readFileSync('/proc/self/environ', 'utf8').length)
  await probe('readTmp', () => b('fs').readdirSync(event.tmp).length)
  await probe('write', () => { b('fs').writeFileSync(event.tmp + '/pwned-by-function', 'x'); return 'WROTE' })
  await probe('mkdir', () => { b('fs').mkdirSync(event.tmp + '/pwned-dir'); return 'MADE' })
  await probe('spawn', () => b('child_process').execSync('id').toString())
  await probe('spawn2', () => b('child_process').spawnSync('/bin/sh', ['-c', 'id']).status)
  await probe('worker', () => new (b('worker_threads').Worker)('1', { eval: true }) && 'WORKER')
  await probe('binding', () => p.binding('fs') && 'BINDING')
  await probe('addon', () => p.dlopen({ exports: {} }, '/lib/x86_64-linux-gnu/libc.so.6') && 'DLOPEN')
  await probe('killHost', () => p.kill(event.hostPid, 0) && 'SIGNALLED')
  await probe('killParent', () => p.kill(p.ppid || 99999999, 0))
  await probe('pidIsOne', () => p.pid)
  await probe('net', () => new Promise((resolve, reject) => {
    const s = b('net').connect({ host: '127.0.0.1', port: event.port })
    s.on('connect', () => { s.destroy(); resolve('CONNECTED') })
    s.on('error', (e) => reject(e))
    setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), 1500)
  }))
  await probe('dns', () => b('dns').promises.lookup('example.com').then((r) => r.address))
  await probe('exit', () => 'not exiting here')
  return out
}`
test('SANDBOX: even after escaping the vm layer, user code has no env, no filesystem, no processes, no network and cannot signal the host', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const f = await mk(u, 'escape', ESCAPE, { timeoutMs: 8000 })
    const tmp = (await import('node:os')).tmpdir()
    const r = await inv(u, f.id, { tmp, port: app.server.address().port, hostPid: process.pid })
    assert.equal(r.data.status, 'ok', JSON.stringify(r.data.error))
    const o = r.data.result
    assert.deepEqual(o.envKeys, [], 'no inherited environment variables')
    for (const k of ['readPasswd', 'readCwd', 'readProc', 'readTmp', 'write', 'mkdir', 'spawn', 'spawn2', 'worker', 'binding', 'addon']) assert.match(String(o[k]), /^ERR:ERR_(ACCESS_DENIED|DLOPEN_DISABLED)$/, `${k} -> ${o[k]}`)
    assert.match(String(o.killHost), /ESRCH/, `host process is invisible in the PID namespace: ${o.killHost}`)
    assert.equal(o.pidIsOne, 1, 'the function is PID 1 of its own namespace')
    assert.ok(!/CONNECTED/.test(String(o.net)) && /ERR:/.test(String(o.net)), `the platform's own loopback server is unreachable: ${o.net}`)
    assert.match(String(o.dns), /ERR:/, 'no DNS either')
    assert.ok(!(await import('node:fs')).existsSync(tmp + '/pwned-by-function') && !(await import('node:fs')).existsSync(tmp + '/pwned-dir'))
    assert.equal(app.ctx.functions.isolation.network, true)
  })
})

test('SANDBOX: timeouts, memory bombs, output floods, process.exit and uncaught errors are contained and the host stays healthy', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const cases = {
      loop: ['module.exports = async () => { while (true) {} }', 'timeout', { timeoutMs: 500 }],
      busyAsync: ['module.exports = async () => { for (;;) { await Promise.resolve() } }', 'timeout', { timeoutMs: 500 }],
      memory: ['module.exports = async () => { const a = []; for (;;) a.push(new Array(1e6).fill(1)) }', 'crash', { memoryMb: 64, timeoutMs: 20_000 }],
      flood: ["module.exports = async () => { globalThis.process.stdout.write('x'.repeat(6 * 1024 * 1024)); return 1 }", 'crash', { timeoutMs: 10_000 }],
      exit: ['module.exports = async () => { globalThis.process.exit(3) }', 'crash', {}],
      abort: ['module.exports = async () => { globalThis.process.abort() }', 'crash', {}],
      sigkillSelf: ["module.exports = async () => { globalThis.process.kill(globalThis.process.pid, 'SIGKILL'); return 'init ignores SIGKILL from inside its own PID namespace' }", null, {}],
      stackOverflow: ['module.exports = async () => { const f = () => f(); f() }', 'error', {}],
      uncaught: ["module.exports = async () => { setTimeout(() => { throw new Error('late') }, 0); await new Promise((r) => setTimeout(r, 100)); return 'survived' }", null, {}],
    }
    const rss0 = process.memoryUsage().rss
    for (const [name, [code, expected, extra]] of Object.entries(cases)) {
      const f = await mk(u, `b-${name.toLowerCase()}`, code, extra)
      const t0 = Date.now()
      const r = await inv(u, f.id)
      assert.equal(r.status, 200, name)
      if (expected) assert.equal(r.data.status, expected, `${name}: ${JSON.stringify(r.data.error)}`)
      assert.ok(Date.now() - t0 < 15_000, `${name} finished in time`)
    }
    assert.ok(process.memoryUsage().rss - rss0 < 300 * 1024 * 1024, 'the platform process did not balloon')
    const healthy = await mk(u, 'healthy', "module.exports = async () => 'still here'")
    assert.equal((await inv(u, healthy.id)).data.result, 'still here')
    assert.equal((await app.call('GET', '/api/health')).status, 200)
    // timed out invocations are billed for the full timeout and recorded
    const loopFn = (await u.call('GET', '/api/functions')).data.functions.find((x) => x.name === 'b-loop')
    const rec = (await u.call('GET', `/api/functions/${loopFn.id}/invocations`)).data.invocations[0]
    assert.equal(rec.status, 'timeout'); assert.equal(rec.billedMs, 500)
  })
})

test('SANDBOX: prototype pollution through results, hostile output and forged protocol messages cannot affect the host', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const f = await mk(u, 'pollute', `module.exports = async () => {
      const p = globalThis.process
      p.stdout.write('{"t":"result","id":"forged","ok":true,"json":"1"}\\n')
      p.stdout.write('not json at all\\n')
      p.stdout.write('{"t":"rpc","id":"x","rid":1,"kind":"kv","op":"list","key":""}\\n')
      return JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}},"ok":1}')
    }`)
    const r = await inv(u, f.id)
    assert.equal(r.data.status, 'ok')
    assert.equal(({}).polluted, undefined); assert.equal(({}).polluted2, undefined); assert.equal(Object.prototype.polluted, undefined)
    assert.equal(r.data.result.ok, 1)
  })
})

/* ------------------------------------------------------------------ kv & fetch */
test('ctx.kv: per-function storage with limits', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const code = `module.exports = async (e, ctx) => {
      const out = {}
      if (e.op === 'basic') {
        out.before = await ctx.kv.get('counter')
        await ctx.kv.set('counter', (out.before ?? 0) + 1)
        await ctx.kv.set('obj:a', { x: [1, 2] }); await ctx.kv.set('obj:b', 'two')
        out.after = await ctx.kv.get('counter'); out.obj = await ctx.kv.get('obj:a'); out.list = await ctx.kv.list('obj:')
        await ctx.kv.delete('obj:b'); out.afterDelete = await ctx.kv.list('obj:'); out.missing = await ctx.kv.get('nope')
      }
      if (e.op === 'badkey') { try { await ctx.kv.set('bad key!', 1) } catch (x) { out.err = x.message } }
      if (e.op === 'big') { try { await ctx.kv.set('big', 'x'.repeat(300000)) } catch (x) { out.err = x.message } }
      if (e.op === 'many') { try { for (let i = 0; i < 60; i++) await ctx.kv.get('k' + i) } catch (x) { out.err = x.message } }
      return out
    }`
    const a = await mk(u, 'kv-a', code), b = await mk(u, 'kv-b', code), other = await mk(v, 'kv-a', code)
    const r1 = (await inv(u, a.id, { op: 'basic' })).data.result
    assert.equal(r1.before, null); assert.equal(r1.after, 1); assert.deepEqual(r1.obj, { x: [1, 2] }); assert.deepEqual(r1.list, ['obj:a', 'obj:b']); assert.deepEqual(r1.afterDelete, ['obj:a']); assert.equal(r1.missing, null)
    assert.equal((await inv(u, a.id, { op: 'basic' })).data.result.before, 1, 'state persists between invocations (and processes)')
    assert.equal((await inv(u, b.id, { op: 'basic' })).data.result.before, null, 'kv is per function')
    assert.equal((await inv(v, other.id, { op: 'basic' })).data.result.before, null, 'and per user')
    assert.match((await inv(u, a.id, { op: 'badkey' })).data.result.err, /kv keys/)
    assert.match((await inv(u, a.id, { op: 'big' })).data.result.err, /at most/)
    assert.match((await inv(u, a.id, { op: 'many' })).data.result.err, /At most 50/)
    app.ctx.functions.killAll()
    assert.equal((await inv(u, a.id, { op: 'basic' })).data.result.before, 2, 'survives worker restarts')
  })
})

function startServer(handler) {
  return new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)) })
}
test('ctx.fetch: off by default, allowlisted, SSRF-protected, redirect-safe and size-limited', async () => {
  const target = await startServer((req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { location: 'http://127.0.0.1:1/secret' }); return res.end() }
    if (req.url === '/big') { res.writeHead(200); return res.end('x'.repeat(3 * 1024 * 1024)) }
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'a=b', 'x-echo-method': req.method }); res.end(`pong:${req.method}:${body}:${req.headers['user-agent']}:${req.headers.host ? 'h' : ''}`) })
  })
  const port = target.address().port
  try {
    await withApp(async (app) => {
      const u = await app.register()
      const code = `module.exports = async (e, ctx) => {
        try { const r = await ctx.fetch(e.url, e.init); return { status: r.status, text: await r.text(), cookie: r.headers.get('set-cookie'), echo: r.headers.get('x-echo-method') } } catch (x) { return { err: x.message } }
      }`
      const f = await mk(u, 'fetcher', code, { timeoutMs: 8000 })
      const url = `http://127.0.0.1:${port}/ping`
      const run = async (event) => (await inv(u, f.id, event)).data.result
      assert.match((await run({ url })).err, /Network access is disabled/, 'off by default')
      await u.call('PATCH', `/api/functions/${f.id}`, { body: { allowNetwork: true, allowedHosts: ['127.0.0.1', `127.0.0.1:${port}`, 'localhost'] } })
      assert.match((await run({ url })).err, /private, loopback/, 'loopback is blocked even when host and port are allowlisted')
      assert.match((await run({ url: 'http://evil.example.net/' })).err, /not in this function's network allowlist/)
      assert.match((await run({ url: `http://user:pw@127.0.0.1:${port}/` })).err, /credentials/)
      assert.match((await run({ url: 'file:///etc/passwd' })).err, /Only http/)
      assert.match((await run({ url: 'gopher://127.0.0.1/' })).err, /Only http/)
      assert.match((await run({ url: 'http://169.254.169.254/latest/meta-data/' })).err, /allowlist|blocked/)
      assert.match((await run({ url: 'http://localhost:1/' })).err, /blocked|allowlist|Port/, 'localhost resolves to loopback')
      assert.match((await run({ url: 'http://127.0.0.1:1/' })).err, /Port 1 is not allowed|blocked/)
    }, {})
    // success path + redirects with the test-only private-address escape hatch (real deployments never set this)
    await withApp(async (app) => {
      const u = await app.register()
      const code = `module.exports = async (e, ctx) => { try { const r = await ctx.fetch(e.url, e.init); return { status: r.status, text: (await r.text()).slice(0, 80), cookie: r.headers.get('set-cookie'), echo: r.headers.get('x-echo-method') } } catch (x) { return { err: x.message } } }`
      const f = await mk(u, 'fetcher2', code, { timeoutMs: 8000 })
      await u.call('PATCH', `/api/functions/${f.id}`, { body: { allowNetwork: true, allowedHosts: [`127.0.0.1:${port}`, '127.0.0.1'] } })
      const run = async (event) => (await inv(u, f.id, event)).data.result
      const ok = await run({ url: `http://127.0.0.1:${port}/ping` })
      assert.equal(ok.status, 200); assert.match(ok.text, /^pong:GET::RD-Cloude-Function\/1:h$/); assert.equal(ok.cookie, null, 'set-cookie never reaches the function'); assert.equal(ok.echo, 'GET')
      const post = await run({ url: `http://127.0.0.1:${port}/x`, init: { method: 'POST', body: { a: 1 }, headers: { host: 'evil', 'content-length': '5', 'x-ok': '1' } } })
      assert.match(post.text, /^pong:POST:\{"a":1\}:/, 'body is sent; forbidden headers are dropped')
      assert.match((await run({ url: `http://127.0.0.1:${port}/redir` })).err, /not in this function's network allowlist|Port 1/, 'redirect targets are validated again')
      assert.match((await run({ url: `http://127.0.0.1:${port}/big` })).err, /too large/)
      assert.match((await run({ url: `http://127.0.0.1:${port}/ping`, init: { method: 'CONNECT' } })).err, /Unsupported method/)
      const manyFn = await mk(u, 'many', `module.exports = async (e, ctx) => { let n = 0; try { for (let i = 0; i < 15; i++) { await ctx.fetch('http://127.0.0.1:${port}/ping'); n++ } } catch (x) { return { n, err: x.message } } }`, { timeoutMs: 10_000 })
      await u.call('PATCH', `/api/functions/${manyFn.id}`, { body: { allowNetwork: true, allowedHosts: [`127.0.0.1:${port}`, '127.0.0.1'] } })
      const many = await inv(u, manyFn.id)
      assert.equal(many.data.result.n, 10); assert.match(many.data.result.err, /At most 10/)
    }, { RD_FUNCTIONS_ALLOW_PRIVATE: '1' })
  } finally { target.close() }
})

/* ------------------------------------------------------------------ HTTP trigger */
test('HTTP trigger: auth modes, response mapping, header allowlist, sandboxed content, body handling', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const code = `module.exports = async (e) => {
      if (e.path === '/json') return { hello: 'world', method: e.method, q: e.query, hasAuth: 'authorization' in e.headers, hasCookie: 'cookie' in e.headers }
      if (e.path === '/html') return { statusCode: 200, headers: { 'content-type': 'text/html', 'x-custom': 'ok', 'set-cookie': 'sid=1', 'location': 'javascript:alert(1)', 'x-bad': 'a\\r\\nset-cookie: evil=1' }, body: '<script>alert(document.domain)</script><h1>hi</h1>' }
      if (e.path === '/evil-type') return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8, text/javascript' }, body: 'x' }
      if (e.path === '/status') return { statusCode: 418, body: 'teapot' }
      if (e.path === '/redirect') return { statusCode: 302, headers: { location: '/somewhere' }, body: '' }
      if (e.path === '/bin') return { statusCode: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from([137, 80, 78, 71]).toString('base64'), isBase64: true }
      if (e.path === '/echo') return { len: e.body.length, b64: e.isBase64 }
      if (e.path === '/crash') throw new Error('x')
      if (e.path === '/slow') { await new Promise((r) => setTimeout(r, 3000)); return 1 }
      return { path: e.path }
    }`
    const f = await mk(u, 'web', code, { timeoutMs: 1000 })
    assert.equal((await app.call('GET', `/fn/${f.id}/json`)).status, 404, 'disabled by default (and indistinguishable from missing)')
    assert.equal((await u.call('PUT', `/api/functions/${f.id}/trigger`, { body: { http: { enabled: true, auth: 'nope' } } })).status, 400)
    await u.call('PUT', `/api/functions/${f.id}/trigger`, { body: { http: { enabled: true, auth: 'apiKey' } } })
    assert.equal((await app.call('GET', `/fn/${f.id}/json`)).status, 401, 'apiKey mode needs the owner key')
    const stranger = await v.call('POST', '/api/keys', { body: { name: 'k' } })
    assert.equal((await app.call('GET', `/fn/${f.id}/json`, { token: stranger.data.secret })).status, 401, "another user's key does not work")
    const key = (await u.call('POST', '/api/keys', { body: { name: 'mine' } })).data.secret
    const ok = await app.call('GET', `/fn/${f.id}/json?a=1&b=2`, { token: key })
    assert.equal(ok.status, 200); assert.equal(ok.data.hello, 'world'); assert.deepEqual(ok.data.q, { a: '1', b: '2' }); assert.equal(ok.data.hasAuth, false, 'the Authorization header is never forwarded')
    await u.call('PUT', `/api/functions/${f.id}/trigger`, { body: { http: { enabled: true, auth: 'none' } } })
    const pub = await app.call('POST', `/fn/${f.id}/json?x=y`, { raw: 'body', headers: { cookie: 'session=secret', 'content-type': 'text/plain' } })
    assert.equal(pub.status, 200); assert.equal(pub.data.method, 'POST'); assert.equal(pub.data.hasCookie, false, 'cookies are never forwarded')
    assert.equal(pub.headers.get('x-content-type-options'), 'nosniff'); assert.match(pub.headers.get('content-security-policy'), /sandbox/)
    const html = await app.call('GET', `/fn/${f.id}/html`)
    assert.equal(html.status, 200); assert.match(html.headers.get('content-type'), /text\/html/)
    assert.match(html.headers.get('content-security-policy'), /default-src 'none'; sandbox/, 'HTML is rendered in an opaque origin without scripts')
    assert.equal(html.headers.get('x-custom'), 'ok'); assert.equal(html.headers.get('set-cookie'), null, 'functions cannot set cookies'); assert.equal(html.headers.get('location'), null, 'javascript: redirects dropped'); assert.equal(html.headers.get('x-bad'), null, 'CRLF injection dropped')
    assert.match((await app.call('GET', `/fn/${f.id}/evil-type`)).headers.get('content-type'), /octet-stream/, 'unknown/odd content types are neutralised')
    assert.equal((await app.call('GET', `/fn/${f.id}/status`)).status, 418)
    const red = await app.call('GET', `/fn/${f.id}/redirect`, { redirect: 'manual' })
    assert.equal(red.status, 302); assert.equal(red.headers.get('location'), '/somewhere')
    const bin = await app.call('GET', `/fn/${f.id}/bin`)
    assert.deepEqual([...bin.data], [137, 80, 78, 71]); assert.equal(bin.headers.get('content-type'), 'image/png')
    const echo = await app.call('POST', `/fn/${f.id}/echo`, { raw: Buffer.from([0xff, 0xfe, 0x00, 0x01]) })
    assert.equal(echo.data.b64, true, 'binary request bodies arrive base64-encoded')
    assert.equal((await app.call('POST', `/fn/${f.id}/echo`, { raw: Buffer.alloc(1024 * 1024 + 1) })).status, 413)
    assert.equal((await app.call('GET', `/fn/${f.id}/crash`)).status, 502)
    assert.equal((await app.call('GET', `/fn/${f.id}/slow`)).status, 504)
    assert.equal((await app.call('GET', `/fn/${f.id}`)).data.path, '/', 'bare function URL')
    assert.equal((await app.call('GET', '/fn/fn__0000000000000000/x')).status, 404)
    assert.equal((await app.call('GET', `/fn/${f.id}/a/b/c`)).data.path, '/a/b/c')
    // a function never exposes another one
    const other = await mk(v, 'private', "module.exports = async () => 'other users secret'")
    assert.equal((await app.call('GET', `/fn/${other.id}/x`)).status, 404)
  })
})

/* ------------------------------------------------------------------ schedules, async, DLQ */
test('schedules and async invocations: cron fires jobs, retries with backoff, dead-letter queue', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const f = await mk(u, 'cronjob', "module.exports = async (e, ctx) => { const n = ((await ctx.kv.get('runs')) ?? 0) + 1; await ctx.kv.set('runs', n); return { n, source: e.source, extra: e.extra } }")
    for (const bad of ['', '* * * *', '61 * * * *', 'x']) assert.equal((await u.call('PUT', `/api/functions/${f.id}/trigger`, { body: { schedule: { cron: bad } } })).status, 400, bad)
    assert.equal((await u.call('PUT', `/api/functions/${f.id}/trigger`, { body: { schedule: { cron: '* * * * *', alias: 'Bad' } } })).status, 400)
    const set = (await u.call('PUT', `/api/functions/${f.id}/trigger`, { body: { schedule: { cron: '*/5 * * * *', event: { extra: 42 } } } })).data
    assert.ok(set.schedule.nextRunAt > Date.now())
    assert.equal(app.ctx.functions.tickSchedules(Date.now()), 0, 'not due yet')
    assert.equal(app.ctx.functions.tickSchedules(set.schedule.nextRunAt + 1000), 1)
    assert.equal(app.db.find('fn_jobs', (j) => j.fnId === f.id).length, 1)
    for (let i = 0; i < 40 && app.db.find('fn_jobs', (j) => j.fnId === f.id).length; i++) { app.ctx.functions.tickJobs(); await new Promise((r) => setTimeout(r, 100)) }
    const recs = (await u.call('GET', `/api/functions/${f.id}/invocations`)).data.invocations
    assert.equal(recs.length, 1); assert.equal(recs[0].trigger, 'schedule'); assert.equal(recs[0].status, 'ok')
    assert.equal((await u.call('PUT', `/api/functions/${f.id}/trigger`, { body: { schedule: null } })).data.schedule, null)
    // async + retries + DLQ
    const flaky = await mk(u, 'flaky', "module.exports = async (e, ctx) => { if (e.ok) return 'fine'; throw new Error('always fails') }")
    const job = (await inv(u, flaky.id, { ok: true }, { async: true }))
    assert.equal(job.status, 202)
    const bad = (await inv(u, flaky.id, { ok: false }, { async: true })).data
    for (let i = 0; i < 60; i++) { app.ctx.functions.tickJobs(Date.now() + 60_000); await new Promise((r) => setTimeout(r, 80)); if (app.db.find('fn_jobs', (j) => j.id === bad.jobId)[0]?.status === 'dead') break }
    const dead = (await u.call('GET', `/api/functions/${flaky.id}/dlq`)).data.jobs
    assert.equal(dead.length, 1); assert.equal(dead[0].attempts, 3); assert.match(dead[0].lastError, /always fails/)
    assert.equal(app.db.find('fn_jobs', (j) => j.id === job.data.jobId).length, 0, 'successful jobs are removed')
    const v = await app.register()
    assert.equal((await v.call('POST', `/api/functions/${flaky.id}/dlq/${dead[0].id}/retry`)).status, 404)
    assert.equal((await u.call('POST', `/api/functions/${flaky.id}/dlq/${dead[0].id}/retry`)).status, 200)
    assert.equal(app.db.get('fn_jobs', dead[0].id).status, 'queued')
    assert.equal((await u.call('DELETE', `/api/functions/${flaky.id}/dlq/${dead[0].id}`)).status, 200)
    assert.equal((await u.call('GET', `/api/functions/${flaky.id}/jobs`)).data.jobs.length, 0)
  })
})

test('concurrency limits, metering, quotas and metrics', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const slow = await mk(u, 'slow', 'module.exports = async () => { await new Promise((r) => setTimeout(r, 2600)); return 1 }', { timeoutMs: 10_000 })
    const rs = await Promise.all([inv(u, slow.id), inv(u, slow.id), inv(u, slow.id)])
    assert.deepEqual(rs.map((x) => x.status).sort(), [200, 200, 429], 'only RD_FN_CONCURRENCY run at once; the surplus waits then is refused')
    const quick = await mk(u, 'quick', 'module.exports = async () => 1', { memoryMb: 512 })
    for (let i = 0; i < 3; i++) await inv(u, quick.id)
    const usage = (await u.call('GET', '/api/billing/usage')).data.lines
    assert.ok(usage.find((l) => l.kind === 'functions.invocations').qty >= 5)
    const gb = usage.find((l) => l.kind === 'functions.gb_seconds')
    assert.ok(gb.qty > 0.1, `gb-seconds metered (${gb.qty})`)
    const m = (await u.call('GET', `/api/functions/${quick.id}/metrics`)).data
    assert.equal(m.invocations, 3); assert.equal(m.errors, 0); assert.ok(m.p50 >= 0 && m.p95 >= m.p50); assert.ok(m.series.length >= 1)
    assert.equal((await u.call('GET', `/api/functions/${quick.id}/metrics?window=1h`)).data.window, '1h')
    // plan quota: free plan allows 100k invocations per month
    app.ctx.billing.record(u.user.id, 'functions.invocations', 100_000)
    const r = await inv(u, quick.id)
    assert.equal(r.status, 429)
    assert.match(r.data.error, /Function invocations limit/)
  }, { RD_FN_CONCURRENCY: '2' })
})

test('lifecycle: warm workers are reused and recycled, nothing leaks after delete or account deletion', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const f = await mk(u, 'warm', "let calls = 0; module.exports = async () => ++calls")
    assert.equal((await inv(u, f.id)).data.result, 1)
    assert.equal((await inv(u, f.id)).data.result, 2, 'the second invocation reused the warm process')
    assert.equal(app.ctx.functions.warmCount(), 1)
    await u.call('PUT', `/api/functions/${f.id}/env`, { body: { env: { A: { value: '1' } } } })
    assert.equal((await inv(u, f.id)).data.result, 1, 'changing env recycles the worker')
    await u.call('DELETE', `/api/functions/${f.id}`)
    assert.equal(app.ctx.functions.warmCount(), 0)
    const g = await mk(u, 'gone', "module.exports = async (e, ctx) => { await ctx.kv.set('k', 1); return 1 }")
    await inv(u, g.id)
    app.ctx.events.emit('account.deleted', { userId: u.user.id })
    assert.equal(app.db.find('fn_functions', (x) => x.userId === u.user.id).length, 0)
    assert.equal(app.db.find('fn_kv', (x) => x.userId === u.user.id).length, 0)
    assert.equal(app.db.find('fn_invocations', (x) => x.userId === u.user.id).length, 0)
  })
})
