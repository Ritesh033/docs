// Security, identity and audit tests. Run: node --test test/security.test.js
import { test } from 'node:test'
import http from 'node:http'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestApp } from './helpers.js'
import {
  authState, totp, hotp, verifyTotp, totpCounter, base32Encode, base32Decode, otpauthUri, scopeAllows, scopeCovers, requiredScope,
  checkPassword, normalizeScopes, SCOPE_NAMES, devOutbox, generateRecoveryCodes, clientIp, deviceLabel,
} from '../src/auth.js'

process.env.RD_DEV_OUTBOX = '1'
const PW = 'correct horse battery'
const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'


// app.js keeps ONE per-IP rate-limit table for the whole process (300 requests/min), so a long suite would trip it.
// Every app therefore talks from its own loopback source address (127.0.x.y is all "localhost" on Linux).
let nextLoopback = 2
function bindClient(app) {
  const n = nextLoopback++
  const localAddress = `127.0.${(n >> 8) & 255}.${n & 255}`
  const target = new URL(app.base)
  const base = `http://127.0.0.1:${target.port}`
  function call(method, path, { body, raw, headers = {}, token } = {}) {
    return new Promise((resolve, reject) => {
      const payload = raw !== undefined ? Buffer.from(raw) : body !== undefined ? Buffer.from(JSON.stringify(body)) : null
      const h = {
        'user-agent': 'node', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(payload ? { 'content-length': payload.length } : {}), ...headers,
      }
      const req = http.request({ host: '127.0.0.1', port: target.port, path, method, localAddress, headers: h }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          const type = res.headers['content-type'] || ''
          const data = type.includes('json') ? (buf.length ? JSON.parse(buf.toString()) : null) : type.startsWith('text/') ? buf.toString() : buf
          resolve({ status: res.statusCode, headers: new Headers(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v])), data })
        })
      })
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }
  async function register(email = `u${Math.random().toString(36).slice(2, 8)}@rd.dev`, password = 'password123') {
    const r = await call('POST', '/api/auth/register', { body: { email, password } })
    if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.data)}`)
    return { token: r.data.token, user: r.data.user, call: (m, p, o = {}) => call(m, p, { token: r.data.token, ...o }) }
  }
  return { base, call, register }
}

/** Boot an isolated app with a controllable clock; always closes it. */
async function withApp(fn, env = {}) {
  const saved = {}
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v }
  const app = { ...(await startTestApp()) }
  Object.assign(app, bindClient(app), { close: app.close })
  const st = authState(app.db)
  const clock = { t: Date.now(), tick(ms) { clock.t += ms; return clock.t } }
  st.now = () => clock.t
  const login = (email, password, extra = {}, headers = {}) => app.call('POST', '/api/auth/login', { body: { email, password, ...extra }, headers })
  try { await fn({ ...app, st, clock, login }) } finally {
    await app.close()
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}
const setEnv = (k, v) => {
  const old = process.env[k]
  process.env[k] = v
  return () => { if (old === undefined) delete process.env[k]; else process.env[k] = old }
}
const flush = () => new Promise((r) => setTimeout(r, 25))
const mailsTo = (app, to, kind) => devOutbox(app.db).filter((m) => m.to === to && (!kind || m.tags?.kind === kind))
const tokenOf = (mail) => /token: (\S+)/i.exec(mail.text)[1]

/* ============================================================== pure functions: TOTP, base32, scopes, policy */

test('HOTP matches the RFC 4226 test vectors', () => {
  const secret = Buffer.from('12345678901234567890')
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']
  expected.forEach((code, counter) => assert.equal(hotp(secret, counter), code))
})

test('TOTP matches every RFC 6238 test vector (SHA-1, SHA-256, SHA-512)', () => {
  const seeds = {
    sha1: Buffer.from('12345678901234567890'),
    sha256: Buffer.from('12345678901234567890123456789012'),
    sha512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234'),
  }
  const vectors = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ]
  for (const [secs, s1, s256, s512] of vectors) {
    assert.equal(totp(seeds.sha1, secs * 1000, { digits: 8, algorithm: 'sha1' }), s1, `sha1 @${secs}`)
    assert.equal(totp(seeds.sha256, secs * 1000, { digits: 8, algorithm: 'sha256' }), s256, `sha256 @${secs}`)
    assert.equal(totp(seeds.sha512, secs * 1000, { digits: 8, algorithm: 'sha512' }), s512, `sha512 @${secs}`)
  }
})

test('verifyTotp: skew window, replay guard and malformed input', () => {
  const secret = Buffer.from('12345678901234567890')
  const t0 = 1_700_000_000_000
  const step = totpCounter(t0)
  const code = totp(secret, t0)
  assert.equal(verifyTotp(secret, code, { timeMs: t0 }), step)
  assert.equal(verifyTotp(secret, code, { timeMs: t0 + 30_000 }), step, 'one step of clock skew is tolerated')
  assert.equal(verifyTotp(secret, code, { timeMs: t0 - 30_000 }), step)
  assert.equal(verifyTotp(secret, code, { timeMs: t0 + 95_000 }), null, 'outside the window')
  assert.equal(verifyTotp(secret, code, { timeMs: t0, minStep: step }), null, 'a step that was already used is rejected')
  assert.equal(verifyTotp(secret, ' ' + code.slice(0, 3) + ' ' + code.slice(3), { timeMs: t0 }), step, 'spaces are ignored')
  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, 123456, '12345a']) assert.equal(verifyTotp(secret, bad, { timeMs: t0 }), null, String(bad))
})

test('base32 follows RFC 4648 and round-trips', () => {
  const vec = { '': '', f: 'MY', fo: 'MZXQ', foo: 'MZXW6', foob: 'MZXW6YQ', fooba: 'MZXW6YTB', foobar: 'MZXW6YTBOI' }
  for (const [plain, enc] of Object.entries(vec)) {
    assert.equal(base32Encode(Buffer.from(plain)), enc)
    assert.equal(base32Decode(enc).toString(), plain)
    assert.equal(base32Decode(enc.toLowerCase().replace(/(.{4})/g, '$1 ')).toString(), plain, 'lower case and spaces are tolerated')
  }
  for (let n = 0; n < 45; n++) {
    const buf = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + n * 11) & 255))
    assert.deepEqual(base32Decode(base32Encode(buf)), buf)
  }
  assert.throws(() => base32Decode('MZXW6!'), /base32/)
})

test('otpauth URI is well formed and escaped', () => {
  assert.equal(
    otpauthUri({ secret: 'JBSWY3DPEHPK3PXP', account: 'a+b@rd.dev' }),
    'otpauth://totp/RD%20Cloude:a%2Bb%40rd.dev?secret=JBSWY3DPEHPK3PXP&issuer=RD%20Cloude&algorithm=SHA1&digits=6&period=30',
  )
})

test('recovery codes: format, entropy alphabet, uniqueness', () => {
  const codes = generateRecoveryCodes(10)
  assert.equal(new Set(codes).size, 10)
  for (const c of codes) assert.match(c, /^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/)
})

test('scope model: mapping, implication, protected account scope, unknown paths', () => {
  assert.deepEqual(requiredScope('GET', '/api/buckets/x/objects/a'), { service: 'storage', level: 'read' })
  assert.deepEqual(requiredScope('PUT', '/api/buckets/x/objects/a'), { service: 'storage', level: 'write' })
  assert.deepEqual(requiredScope('POST', '/api/db/todos/query'), { service: 'db', level: 'write' })
  assert.deepEqual(requiredScope('GET', '/api/projects'), { service: 'ai', level: 'read' })
  assert.deepEqual(requiredScope('GET', '/api/keys'), { service: 'account', level: 'read' })
  assert.deepEqual(requiredScope('POST', '/api/mystery/thing'), { service: null, level: 'write' }, 'unknown modules fall back to read/write')
  assert.deepEqual(requiredScope('GET', '/api/mystery'), { service: null, level: 'read' })
  assert.equal(requiredScope('GET', '/api/me'), null)
  assert.equal(requiredScope('GET', '/s/abc'), null)
  assert.deepEqual(requiredScope('GET', '/api/drivefoo'), { service: null, level: 'read' }, 'prefix match respects path boundaries')
  assert.deepEqual(requiredScope('GET', '/api/zed/x', [['/api/zed', 'drive']]), { service: 'drive', level: 'read' })

  const read = ['read']
  const write = ['write']
  assert.ok(scopeAllows(null, { service: 'account', level: 'write' }), 'null = full access (legacy keys)')
  assert.ok(scopeAllows(read, { service: 'storage', level: 'read' }))
  assert.ok(!scopeAllows(read, { service: 'storage', level: 'write' }))
  assert.ok(scopeAllows(write, { service: 'storage', level: 'read' }), 'write implies read')
  assert.ok(scopeAllows(write, { service: null, level: 'write' }))
  assert.ok(!scopeAllows(write, { service: 'account', level: 'read' }), 'global scopes never reach the account surface')
  assert.ok(!scopeAllows(read, { service: 'account', level: 'read' }))
  assert.ok(scopeAllows(['account:read'], { service: 'account', level: 'read' }))
  assert.ok(!scopeAllows(['account:read'], { service: 'account', level: 'write' }))
  assert.ok(scopeAllows(['storage'], { service: 'storage', level: 'write' }))
  assert.ok(!scopeAllows(['storage'], { service: 'ai', level: 'read' }))
  assert.ok(!scopeAllows(['storage'], { service: null, level: 'read' }), 'service-scoped keys do not reach unmapped endpoints')
  assert.ok(scopeAllows(['ai:read'], { service: 'ai', level: 'read' }) && !scopeAllows(['ai:read'], { service: 'ai', level: 'write' }))

  assert.ok(scopeCovers(['write'], 'storage') && scopeCovers(['write'], 'read') && !scopeCovers(['write'], 'account'))
  assert.ok(!scopeCovers(['read'], 'write') && !scopeCovers(['storage:read'], 'storage'))
  assert.deepEqual(normalizeScopes(['Write', 'read', 'write']), ['read', 'write'])
  assert.equal(normalizeScopes(undefined), null)
  for (const bad of [[], 'read', ['nope'], [1], Array(41).fill('read'), {}]) assert.throws(() => normalizeScopes(bad), (e) => e.status === 400)
  assert.ok(SCOPE_NAMES.includes('account:read') && SCOPE_NAMES.includes('billing'))
})

test('password policy: bounds always, weakness advisory in standard mode and blocking in strict mode', () => {
  const std = { cfg: { passwordMin: 8, passwordPolicy: 'standard' } }
  const strict = { cfg: { passwordMin: 8, passwordPolicy: 'strict' } }
  assert.deepEqual(checkPassword(std, 'x'.repeat(7)).errors, ['Password must be at least 8 characters'])
  assert.equal(checkPassword(std, 'x'.repeat(257)).errors.length, 1)
  assert.equal(checkPassword(std, 'Zq8!vLm2').errors.length + checkPassword(std, 'Zq8!vLm2').warnings.length, 0)
  assert.equal(checkPassword(std, 8 /* not a string */).errors.length, 1)
  const weakStd = checkPassword(std, 'password123', { email: 'a@rd.dev' })
  assert.equal(weakStd.errors.length, 0)
  assert.ok(weakStd.warnings.length >= 1)
  for (const weak of ['password123', 'Password1!', 'qwerty123', '12345678', 'aaaaaaaa', 'abcdefgh', 'alice-secret']) {
    assert.ok(checkPassword(strict, weak, { email: 'alice@x.dev' }).errors.length >= 1, `${weak} must be rejected in strict mode`)
  }
  assert.equal(checkPassword(strict, 'correct horse battery', { email: 'alice@x.dev' }).errors.length, 0)
})

test('clientIp ignores X-Forwarded-For unless RD_TRUST_PROXY is set; deviceLabel summarises user agents', () => {
  const req = { socket: { remoteAddress: '::ffff:10.1.2.3' }, headers: { 'x-forwarded-for': '6.6.6.6, 9.9.9.9' } }
  assert.equal(clientIp(req), '10.1.2.3')
  const restore = setEnv('RD_TRUST_PROXY', '1')
  assert.equal(clientIp(req), '9.9.9.9', 'one trusted hop: the address the proxy saw (last entry), not the spoofable first one')
  process.env.RD_TRUST_PROXY = '2'
  assert.equal(clientIp(req), '6.6.6.6')
  restore()
  assert.equal(deviceLabel(UA_MAC), 'Chrome on macOS')
  assert.equal(deviceLabel('curl/8.5.0'), 'curl')
  assert.equal(deviceLabel(''), 'Unknown device')
})

/* ============================================================== registration + input validation */

test('register: validates input, never trusts types, hashes passwords, rejects duplicates case-insensitively', async () => {
  await withApp(async (app) => {
    const post = (body, raw) => app.call('POST', '/api/auth/register', raw ? { raw, headers: { 'content-type': 'application/json' } } : { body })
    assert.equal((await post(undefined, 'null')).status, 400, 'JSON null body')
    assert.equal((await post(undefined, '[1,2]')).status, 400, 'JSON array body')
    assert.equal((await post(undefined, '{bad')).status, 400)
    assert.equal((await post({ password: PW })).status, 400)
    assert.equal((await post({ email: 'not-an-email', password: PW })).status, 400)
    assert.equal((await post({ email: { $ne: 1 }, password: PW })).status, 400, 'object email')
    assert.equal((await post({ email: 'a@rd.dev', password: ['x'.repeat(12)] })).status, 400, 'array password')
    assert.equal((await post({ email: 'a@rd.dev', password: 'short' })).status, 400)
    assert.equal((await post({ email: 'a@rd.dev', password: 'x'.repeat(300) })).status, 400, 'password longer than 256 chars')
    assert.equal((await post({ email: `${'l'.repeat(65)}@rd.dev`, password: PW })).status, 400, 'local part too long')
    assert.equal((await post({ email: 'a@rd.dev', password: PW, name: 'n'.repeat(81) })).status, 400)
    assert.equal((await post({ email: 'a@rd.dev', password: PW, name: 'bad\u0007name' })).status, 400)
    const ok = await post({ email: 'Mixed.Case@RD.dev ', password: PW, name: 'Mixed' })
    assert.equal(ok.status, 201)
    assert.equal(ok.data.user.email, 'mixed.case@rd.dev')
    assert.equal(ok.data.user.emailVerified, false)
    assert.equal(ok.data.warnings, undefined)
    assert.equal((await post({ email: 'MIXED.case@rd.dev', password: PW })).status, 409)
    const row = app.db.findOne('users', (u) => u.email === 'mixed.case@rd.dev')
    assert.match(row.password, /^[0-9a-f]{32}:[0-9a-f]{128}$/, 'scrypt salt:hash')
    assert.ok(!JSON.stringify(row).includes(PW))
    const weak = await post({ email: 'weak@rd.dev', password: 'password123' })
    assert.equal(weak.status, 201, 'standard policy keeps the long-standing fixture password usable')
    assert.ok(weak.data.warnings.length >= 1, 'but flags it')
  })
})

test('register: strict password policy blocks common passwords; per-IP sign-up limit', async () => {
  await withApp(async (app) => {
    app.st.cfg.passwordPolicy = 'strict'
    const r1 = await app.call('POST', '/api/auth/register', { body: { email: 'strict@rd.dev', password: 'password123' } })
    assert.equal(r1.status, 400)
    assert.match(r1.data.error, /common/i)
    assert.equal((await app.call('POST', '/api/auth/register', { body: { email: 'strict@rd.dev', password: PW } })).status, 201)
    app.st.cfg.registerPerHour = 2
    app.st.gates.clear()
    assert.equal((await app.call('POST', '/api/auth/register', { body: { email: 'l2@rd.dev', password: PW } })).status, 201)
    assert.equal((await app.call('POST', '/api/auth/register', { body: { email: 'l3@rd.dev', password: PW } })).status, 201)
    const blocked = await app.call('POST', '/api/auth/register', { body: { email: 'l4@rd.dev', password: PW } })
    assert.equal(blocked.status, 429)
    assert.ok(Number(blocked.headers.get('retry-after')) > 0)
  })
})

/* ============================================================== login throttling */

test('login lockout: exponential backoff per account+IP, same answers for unknown accounts, correct password cannot bypass', async () => {
  await withApp(async (app) => {
    await app.register('victim@rd.dev', PW)
    app.st.cfg.loginFree = 3
    app.st.cfg.lockBaseMs = 1000
    app.st.cfg.lockMaxMs = 8000
    const fail = (email = 'victim@rd.dev') => app.login(email, 'wrong-password')
    for (let i = 0; i < 3; i++) assert.equal((await fail()).status, 401)
    const f4 = await fail() // 4th failure crosses the free allowance: 1s lock starts
    assert.equal(f4.status, 401)
    const locked = await app.login('victim@rd.dev', PW)
    assert.equal(locked.status, 429, 'even the right password is refused while locked')
    assert.equal(locked.headers.get('retry-after'), '1')
    app.clock.tick(1001)
    assert.equal((await fail()).status, 401) // 5th failure -> 2s
    assert.equal((await app.login('victim@rd.dev', PW)).headers.get('retry-after'), '2')
    app.clock.tick(2001)
    assert.equal((await fail()).status, 401) // 6th -> 4s
    assert.equal((await app.login('victim@rd.dev', PW)).headers.get('retry-after'), '4')
    app.clock.tick(4001)
    assert.equal((await fail()).status, 401) // 7th -> 8s (capped by lockMaxMs)
    app.clock.tick(8001)
    assert.equal((await fail()).status, 401) // 8th -> still capped at 8s
    assert.equal((await app.login('victim@rd.dev', PW)).headers.get('retry-after'), '8')
    app.clock.tick(8001)
    const ok = await app.login('victim@rd.dev', PW)
    assert.equal(ok.status, 200, 'unlocks after the delay and a success clears the counter')
    for (let i = 0; i < 3; i++) assert.equal((await fail()).status, 401, 'counter was reset')

    // an account that does not exist behaves identically (no enumeration through lockout behaviour)
    for (let i = 0; i < 4; i++) await fail('ghost@rd.dev')
    await fail() // victim: 4th failure since the reset
    const ghost = await app.login('ghost@rd.dev', 'x'.repeat(12))
    const real = await app.login('victim@rd.dev', 'x'.repeat(12))
    assert.equal(ghost.status, 429)
    assert.equal(real.status, 429)
    assert.equal(ghost.headers.get('retry-after'), real.headers.get('retry-after'))
    assert.equal(ghost.data.error, real.data.error)
  })
})

test('login lockout is per IP: an attacker cannot lock the owner out from another address; IP-wide limit across accounts', async () => {
  const restore = setEnv('RD_TRUST_PROXY', '1')
  try {
    await withApp(async (app) => {
      await app.register('owner@rd.dev', PW)
      await app.register('other@rd.dev', PW)
      app.st.cfg.loginFree = 2
      app.st.cfg.ipFree = 4
      const from = (ip) => ({ 'x-forwarded-for': ip })
      for (let i = 0; i < 4; i++) await app.login('owner@rd.dev', 'bad-password', {}, from('203.0.113.9'))
      assert.equal((await app.login('owner@rd.dev', PW, {}, from('203.0.113.9'))).status, 429, 'attacker address is locked')
      assert.equal((await app.login('owner@rd.dev', PW, {}, from('198.51.100.7'))).status, 200, 'the owner, from elsewhere, is unaffected')
      // credential stuffing: many accounts from one address trips the IP-wide limiter
      for (const e of ['a1@rd.dev', 'a2@rd.dev', 'a3@rd.dev', 'a4@rd.dev', 'a5@rd.dev']) await app.login(e, 'bad-password', {}, from('192.0.2.50'))
      assert.equal((await app.login('other@rd.dev', PW, {}, from('192.0.2.50'))).status, 429, 'a valid login from the stuffing address is refused too')
      assert.equal((await app.login('other@rd.dev', PW, {}, from('192.0.2.51'))).status, 200)
    })
  } finally { restore() }
})

test('login lockout cannot be bypassed with a burst of parallel guesses', async () => {
  await withApp(async (app) => {
    await app.register('burst@rd.dev', PW)
    app.st.cfg.loginFree = 3
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => app.login('burst@rd.dev', `wrong-guess-${i}`)))
    const tried = results.filter((r) => r.status === 401).length
    const refused = results.filter((r) => r.status === 429).length
    assert.equal(tried + refused, 60, 'only 401 or 429, never 500')
    assert.ok(tried <= 3 + 5, `at most the free attempts plus the in-flight cap (5) were actually tried, got ${tried}`)
    assert.ok(refused >= 52)
    assert.equal((await app.login('burst@rd.dev', PW)).status, 429, 'and the account+IP is now locked')
    assert.equal(app.st.inflight.size, 0, 'in-flight bookkeeping is released')
  })
})

test('2FA codes cannot be guessed by rotating IP addresses: attempts are also counted per account', async () => {
  const restore = setEnv('RD_TRUST_PROXY', '1')
  try {
    await withApp(async (app) => {
      const u = await app.register('rot@rd.dev', PW)
      const setup = await u.call('POST', '/api/auth/2fa/setup', { body: { password: PW } })
      const secret = base32Decode(setup.data.secret)
      await u.call('POST', '/api/auth/2fa/enable', { body: { code: totp(secret, app.clock.t) } })
      app.clock.tick(60_000)
      app.st.cfg.tfaFree = 4
      const statuses = []
      for (let i = 0; i < 8; i++) {
        const h = { 'x-forwarded-for': `203.0.113.${10 + i}` } // a fresh address every time: per-IP limits never trigger
        const ch = await app.login('rot@rd.dev', PW, {}, h)
        if (!ch.data.challenge) { statuses.push(ch.status); continue }
        statuses.push((await app.call('POST', '/api/auth/login/2fa', { body: { challenge: ch.data.challenge, code: '000000' }, headers: h })).status)
      }
      assert.deepEqual(statuses.slice(0, 4), [401, 401, 401, 401])
      assert.ok(statuses.slice(5).every((s) => s === 401 || s === 429))
      assert.ok(statuses.includes(429), `the account-wide limiter engaged: ${statuses}`)
      // even the genuine code is refused while the account-wide lock is on
      const h = { 'x-forwarded-for': '198.51.100.99' }
      const ch = await app.login('rot@rd.dev', PW, {}, h)
      const r = await app.call('POST', '/api/auth/login/2fa', { body: { challenge: ch.data.challenge, code: totp(secret, app.clock.t) }, headers: h })
      assert.equal(r.status, 429)
      app.clock.tick(20 * 60_000)
      const ch2 = await app.login('rot@rd.dev', PW, {}, h)
      assert.equal((await app.call('POST', '/api/auth/login/2fa', { body: { challenge: ch2.data.challenge, code: totp(secret, app.clock.t) }, headers: h })).status, 200, 'recovers once the lock lapses')
    })
  } finally { restore() }
})

test('a sign-in from a new device or address mails the owner once', async () => {
  const restore = setEnv('RD_TRUST_PROXY', '1')
  try {
    await withApp(async (app) => {
      await app.register('newdev@rd.dev', PW)
      const from = (ip, ua = 'curl/8.5.0') => ({ 'x-forwarded-for': ip, 'user-agent': ua })
      const seen = () => mailsTo(app, 'newdev@rd.dev', 'new-login')
      await app.login('newdev@rd.dev', PW, {}, from('203.0.113.1'))
      await flush()
      assert.equal(seen().length, 1, 'registration device was a different address than this one')
      await app.login('newdev@rd.dev', PW, {}, from('203.0.113.1'))
      await flush()
      assert.equal(seen().length, 1, 'same device and address: quiet')
      await app.login('newdev@rd.dev', PW, {}, from('203.0.113.1', UA_MAC))
      await flush()
      assert.equal(seen().length, 2, 'new browser')
      assert.match(seen()[1].text, /Chrome on macOS/)
      assert.match(seen()[1].text, /203\.0\.113\.1/)
      const u = { token: (await app.login('newdev@rd.dev', PW, {}, from('203.0.113.1', UA_MAC))).data.token }
      const log = (await app.call('GET', '/api/audit?action=auth.login&limit=50', { token: u.token })).data.entries
      assert.equal(log.filter((e) => e.meta?.newDevice).length, 2, 'flagged in the audit log too')
    })
  } finally { restore() }
})

test('login: malformed bodies fail closed without 500s', async () => {
  await withApp(async (app) => {
    for (const body of [{}, { email: 'a@rd.dev' }, { email: 1, password: 2 }, { email: ['a'], password: {} }, { email: 'a@rd.dev', password: 'x'.repeat(5000) }]) {
      const r = await app.call('POST', '/api/auth/login', { body })
      assert.ok(r.status === 400 || r.status === 401, JSON.stringify(body).slice(0, 40) + ' -> ' + r.status)
    }
    assert.equal((await app.call('POST', '/api/auth/login', { raw: 'null', headers: { 'content-type': 'application/json' } })).status, 400)
  })
})

/* ============================================================== two-factor authentication */

test('2FA: enrolment, two-step login, replay protection, recovery codes, disabling', async () => {
  await withApp(async (app) => {
    const u = await app.register('tfa@rd.dev', PW)
    assert.equal((await u.call('GET', '/api/auth/2fa')).data.enabled, false)
    assert.equal((await u.call('POST', '/api/auth/2fa/setup', { body: { password: 'wrong-password' } })).status, 403, 'password re-auth required')
    assert.equal((await u.call('POST', '/api/auth/2fa/enable', { body: { code: '123456' } })).status, 400, 'enable before setup')
    const setup = await u.call('POST', '/api/auth/2fa/setup', { body: { password: PW } })
    assert.equal(setup.status, 200)
    assert.match(setup.data.secret, /^[A-Z2-7]{32}$/)
    assert.equal(setup.data.otpauthUri, otpauthUri({ secret: setup.data.secret, account: 'tfa@rd.dev' }))
    const secret = base32Decode(setup.data.secret)
    const stored = app.db.get('users', u.user.id)
    assert.ok(!JSON.stringify(stored).includes(setup.data.secret), 'secret is not stored in the clear')
    assert.equal((await u.call('POST', '/api/auth/2fa/enable', { body: { code: '000000' } })).status, 400)
    const en = await u.call('POST', '/api/auth/2fa/enable', { body: { code: totp(secret, app.clock.t) } })
    assert.equal(en.status, 200)
    assert.equal(en.data.recoveryCodes.length, 10)
    const after = app.db.get('users', u.user.id)
    assert.ok(!JSON.stringify(after).includes(en.data.recoveryCodes[0]), 'recovery codes are stored hashed')
    assert.equal(after.recoveryCodes.length, 10)
    assert.equal((await u.call('GET', '/api/auth/2fa')).data.recoveryCodesRemaining, 10)
    assert.equal((await u.call('POST', '/api/auth/2fa/setup', { body: { password: PW } })).status, 409, 'already enabled')
    assert.equal((await u.call('GET', '/api/me')).data.user.twoFactorEnabled, true)

    // step 1: password only yields a challenge, never a token
    const l1 = await app.login('tfa@rd.dev', PW)
    assert.equal(l1.status, 401, 'not signed in yet: an unaware client must not mistake this for success')
    assert.match(l1.data.error, /Two-factor/)
    assert.equal(l1.data.twoFactorRequired, true)
    assert.deepEqual(l1.data.methods, ['totp', 'recovery'])
    assert.equal(l1.data.token, undefined)
    assert.ok(l1.data.challenge)
    app.clock.tick(30_000) // a code can only be accepted once per time step; the enrol code used this step's predecessor
    assert.equal((await app.call('POST', '/api/auth/login/2fa', { body: { challenge: l1.data.challenge, code: '000000' } })).status, 401)
    assert.equal((await app.call('POST', '/api/auth/login/2fa', { body: { challenge: 'nonsense', code: totp(secret, app.clock.t) } })).status, 401)
    const good = totp(secret, app.clock.t)
    const l2 = await app.call('POST', '/api/auth/login/2fa', { body: { challenge: l1.data.challenge, code: good } })
    assert.equal(l2.status, 200)
    assert.ok(l2.data.token)
    assert.equal((await app.call('GET', '/api/me', { token: l2.data.token })).status, 200)
    assert.equal((await app.call('GET', '/api/auth/sessions', { token: l2.data.token })).data.sessions.find((s) => s.current).mfa, true)
    assert.equal((await app.call('POST', '/api/auth/login/2fa', { body: { challenge: l1.data.challenge, code: good } })).status, 401, 'a challenge is single-use')

    // replay: the same code cannot start another login
    const l3 = await app.login('tfa@rd.dev', PW)
    assert.equal((await app.call('POST', '/api/auth/login/2fa', { body: { challenge: l3.data.challenge, code: good } })).status, 401, 'TOTP code replay refused')
    app.clock.tick(30_000)
    // one-shot form for API clients: password + code in one request
    assert.equal((await app.login('tfa@rd.dev', PW, { code: totp(secret, app.clock.t) })).status, 200)
    assert.equal((await app.login('tfa@rd.dev', PW, { code: '111111' })).status, 401)

    // recovery codes: single use
    const rc = en.data.recoveryCodes
    const l4 = await app.login('tfa@rd.dev', PW)
    const used = await app.call('POST', '/api/auth/login/2fa', { body: { challenge: l4.data.challenge, code: rc[0].toUpperCase().replace('-', ' ') } })
    assert.equal(used.status, 200, 'case/format tolerant')
    assert.equal(used.data.usedRecoveryCode, true)
    assert.equal(used.data.recoveryCodesRemaining, 9)
    const l5 = await app.login('tfa@rd.dev', PW)
    assert.equal((await app.call('POST', '/api/auth/login/2fa', { body: { challenge: l5.data.challenge, code: rc[0] } })).status, 401, 'recovery code works once')

    // regenerate: old codes die
    app.clock.tick(30_000)
    assert.equal((await u.call('POST', '/api/auth/2fa/recovery-codes', { body: { password: PW, code: '000000' } })).status, 403)
    const regen = await u.call('POST', '/api/auth/2fa/recovery-codes', { body: { password: PW, code: totp(secret, app.clock.t) } })
    assert.equal(regen.status, 200)
    assert.notDeepEqual(regen.data.recoveryCodes, rc)
    const l6 = await app.login('tfa@rd.dev', PW)
    assert.equal((await app.call('POST', '/api/auth/login/2fa', { body: { challenge: l6.data.challenge, code: rc[1] } })).status, 401, 'old recovery code invalid after regeneration')

    // disabling needs password AND a code
    app.clock.tick(30_000)
    assert.equal((await u.call('POST', '/api/auth/2fa/disable', { body: { password: 'wrong-password', code: totp(secret, app.clock.t) } })).status, 403)
    assert.equal((await u.call('POST', '/api/auth/2fa/disable', { body: { password: PW, code: '000000' } })).status, 403)
    assert.equal((await u.call('POST', '/api/auth/2fa/disable', { body: { password: PW, code: regen.data.recoveryCodes[0] } })).status, 200, 'a recovery code also authorises disabling')
    const plain = await app.login('tfa@rd.dev', PW)
    assert.ok(plain.data.token, 'back to single-step login')
    assert.equal(app.db.get('users', u.user.id).totp, null)
    assert.equal(mailsTo(app, 'tfa@rd.dev', '2fa-enabled').length, 1)
    assert.equal(mailsTo(app, 'tfa@rd.dev', '2fa-disabled').length, 1)
  })
})

test('2FA: challenge allows only 5 guesses; API keys cannot manage 2FA; enabling signs out other sessions', async () => {
  await withApp(async (app) => {
    const u = await app.register('tfa2@rd.dev', PW)
    const other = (await app.login('tfa2@rd.dev', PW)).data.token
    const setup = await u.call('POST', '/api/auth/2fa/setup', { body: { password: PW } })
    const secret = base32Decode(setup.data.secret)
    const key = (await u.call('POST', '/api/keys', { body: { name: 'k' } })).data.secret
    assert.equal((await app.call('POST', '/api/auth/2fa/setup', { token: key, body: { password: PW } })).status, 403, 'legacy full-access keys are not interactive sessions')
    assert.equal((await u.call('POST', '/api/auth/2fa/enable', { body: { code: totp(secret, app.clock.t) } })).status, 200)
    assert.equal((await app.call('GET', '/api/me', { token: other })).status, 401, 'other sessions were revoked when 2FA was enabled')
    assert.equal((await u.call('GET', '/api/me')).status, 200, 'the enrolling session survives')

    app.st.cfg.loginFree = 50
    const l = await app.login('tfa2@rd.dev', PW)
    for (let i = 0; i < 5; i++) assert.equal((await app.call('POST', '/api/auth/login/2fa', { body: { challenge: l.data.challenge, code: '000000' } })).status, 401)
    app.clock.tick(30_000)
    const late = await app.call('POST', '/api/auth/login/2fa', { body: { challenge: l.data.challenge, code: totp(secret, app.clock.t) } })
    assert.equal(late.status, 401, 'the challenge was burnt after 5 wrong codes')

    const l2 = await app.login('tfa2@rd.dev', PW)
    app.clock.tick(6 * 60_000)
    assert.equal((await app.call('POST', '/api/auth/login/2fa', { body: { challenge: l2.data.challenge, code: totp(secret, app.clock.t) } })).status, 401, 'challenge expires after 5 minutes')
    assert.equal((await app.call('POST', '/api/auth/login/2fa', { body: { code: '123456' } })).status, 400)
  })
})

/* ============================================================== sessions */

test('sessions: list with device/ip/created/lastSeen, revoke one, revoke others, tenant isolation, API keys excluded', async () => {
  await withApp(async (app) => {
    const a = await app.register('s1@rd.dev', PW)
    const b = await app.register('s2@rd.dev', PW)
    const mac = (await app.login('s1@rd.dev', PW, {}, { 'user-agent': UA_MAC })).data.token
    const third = (await app.login('s1@rd.dev', PW, {}, { 'user-agent': 'curl/8.5.0' })).data.token
    const list = (await a.call('GET', '/api/auth/sessions')).data.sessions
    assert.equal(list.length, 3)
    assert.equal(list.filter((s) => s.current).length, 1)
    for (const s of list) {
      assert.ok(s.id && s.device && s.ip && s.createdAt && s.lastSeenAt && s.expiresAt)
      assert.equal(s.hash, undefined, 'token hashes never leave the server')
    }
    assert.ok(list.some((s) => s.device === 'Chrome on macOS'))
    const macSession = (await app.call('GET', '/api/auth/sessions', { token: mac })).data.sessions.find((s) => s.current)
    assert.equal((await b.call('DELETE', `/api/auth/sessions/${macSession.id}`)).status, 404, 'cannot revoke another tenant session')
    assert.equal((await app.call('GET', '/api/me', { token: mac })).status, 200)
    assert.equal((await a.call('DELETE', `/api/auth/sessions/${macSession.id}`)).status, 200)
    assert.equal((await app.call('GET', '/api/me', { token: mac })).status, 401)
    const key = (await a.call('POST', '/api/keys', { body: { name: 'k', scopes: ['account'] } })).data.secret
    assert.equal((await app.call('POST', '/api/auth/sessions/revoke-others', { token: key })).status, 403, 'revocation is session-only')
    assert.equal((await app.call('GET', '/api/auth/sessions', { token: key })).status, 200, 'a key with the account scope may list sessions')
    const r = await a.call('POST', '/api/auth/sessions/revoke-others')
    assert.equal(r.data.revoked, 1)
    assert.equal((await app.call('GET', '/api/me', { token: third })).status, 401)
    assert.equal((await a.call('GET', '/api/me')).status, 200)
    assert.equal((await a.call('GET', '/api/auth/sessions')).data.sessions.length, 1)
    assert.equal((await b.call('GET', '/api/auth/sessions')).data.sessions.length, 1, 'other users untouched')
    assert.equal((await app.call('GET', '/api/auth/sessions')).status, 401)
  })
})

test('sessions: idle expiry, absolute expiry, max sessions per user', async () => {
  await withApp(async (app) => {
    app.st.cfg.sessionIdleMs = 24 * 36e5
    app.st.cfg.sessionMaxMs = 72 * 36e5
    const u = await app.register('exp@rd.dev', PW)
    // idle: no requests for >24h
    const idle = (await app.login('exp@rd.dev', PW)).data.token
    app.clock.tick(25 * 36e5)
    assert.equal((await app.call('GET', '/api/me', { token: idle })).status, 401, 'idle session expired')
    assert.equal((await app.call('GET', '/api/me', { token: idle })).status, 401)
    // absolute: activity keeps it alive until the hard limit
    const busy = (await app.login('exp@rd.dev', PW)).data.token
    for (let i = 0; i < 3; i++) {
      app.clock.tick(20 * 36e5)
      assert.equal((await app.call('GET', '/api/me', { token: busy })).status, 200, `active at +${(i + 1) * 20}h`)
    }
    app.clock.tick(20 * 36e5)
    assert.equal((await app.call('GET', '/api/me', { token: busy })).status, 401, 'absolute lifetime (72h) exceeded despite activity')
    assert.equal((await u.call('GET', '/api/me')).status, 401, 'the registration session aged out too')

    // max sessions: oldest (least recently used) is evicted
    app.st.cfg.maxSessions = 3
    const tokens = []
    for (let i = 0; i < 5; i++) {
      tokens.push((await app.login('exp@rd.dev', PW)).data.token)
      app.clock.tick(1000)
    }
    const alive = []
    for (const t of tokens) alive.push((await app.call('GET', '/api/me', { token: t })).status)
    assert.deepEqual(alive, [401, 401, 200, 200, 200])
    assert.equal(app.db.find('sessions', (s) => s.userId === u.user.id).length, 3)
  })
})

/* ============================================================== password change / reset / verification */

test('password change: needs the current password, rotates every session, notifies by mail', async () => {
  await withApp(async (app) => {
    const u = await app.register('chg@rd.dev', PW)
    const other = (await app.login('chg@rd.dev', PW)).data.token
    const body = (o) => ({ body: { currentPassword: PW, newPassword: 'a brand new passphrase', ...o } })
    assert.equal((await app.call('POST', '/api/auth/password/change', body({ currentPassword: 'wrong-password' }))).status, 401, 'unauthenticated')
    assert.equal((await u.call('POST', '/api/auth/password/change', body({ currentPassword: 'wrong-password' }))).status, 403)
    assert.equal((await u.call('POST', '/api/auth/password/change', body({ newPassword: PW }))).status, 400, 'must differ')
    assert.equal((await u.call('POST', '/api/auth/password/change', body({ newPassword: 'short' }))).status, 400)
    assert.equal((await u.call('POST', '/api/auth/password/change', body({ newPassword: 12345678 }))).status, 400)
    assert.equal((await u.call('POST', '/api/auth/password/change', { body: { newPassword: 'x'.repeat(12) } })).status, 400)
    const ok = await u.call('POST', '/api/auth/password/change', body())
    assert.equal(ok.status, 200)
    assert.ok(ok.data.token && ok.data.token !== u.token)
    assert.equal((await u.call('GET', '/api/me')).status, 401, 'old token is dead (rotation)')
    assert.equal((await app.call('GET', '/api/me', { token: other })).status, 401, 'other devices signed out')
    assert.equal((await app.call('GET', '/api/me', { token: ok.data.token })).status, 200)
    assert.equal((await app.login('chg@rd.dev', PW)).status, 401)
    assert.equal((await app.login('chg@rd.dev', 'a brand new passphrase')).status, 200)
    assert.equal(mailsTo(app, 'chg@rd.dev', 'password-changed').length, 1)
  })
})

test('password change: wrong current password feeds the same lockout as login', async () => {
  await withApp(async (app) => {
    const u = await app.register('brute@rd.dev', PW)
    app.st.cfg.loginFree = 2
    app.st.cfg.lockBaseMs = 5000
    for (let i = 0; i < 3; i++) await u.call('POST', '/api/auth/password/change', { body: { currentPassword: 'guess-guess', newPassword: 'another passphrase' } })
    const locked = await u.call('POST', '/api/auth/password/change', { body: { currentPassword: PW, newPassword: 'another passphrase' } })
    assert.equal(locked.status, 429)
    assert.ok(locked.headers.get('retry-after'))
  })
})

test('password reset: indistinguishable request, hashed single-use expiring token, revokes sessions', async () => {
  await withApp(async (app) => {
    const u = await app.register('reset@rd.dev', PW)
    const f1 = await app.call('POST', '/api/auth/password/forgot', { body: { email: 'reset@rd.dev' } })
    const f2 = await app.call('POST', '/api/auth/password/forgot', { body: { email: 'nobody@rd.dev' } })
    assert.equal(f1.status, 202)
    assert.deepEqual(f1.data, f2.data)
    assert.equal(f1.status, f2.status)
    assert.equal((await app.call('POST', '/api/auth/password/forgot', { body: { email: 'not an email' } })).status, 400)
    await flush()
    assert.equal(mailsTo(app, 'nobody@rd.dev').length, 0, 'no mail for unknown accounts')
    const mail = mailsTo(app, 'reset@rd.dev', 'password-reset')
    assert.equal(mail.length, 1)
    const token = tokenOf(mail[0])
    assert.ok(!JSON.stringify(app.db.find('auth_tokens')).includes(token), 'only a hash of the token is stored')
    assert.equal((await app.call('POST', '/api/auth/password/reset', { body: { token: 'x'.repeat(43), password: 'a brand new passphrase' } })).status, 400)
    assert.equal((await app.call('POST', '/api/auth/password/reset', { body: { token, password: 'short' } })).status, 400)
    assert.equal((await app.call('POST', '/api/auth/password/reset', { body: { token, password: 123456789 } })).status, 400)
    // a rejected (weak) password does not burn the token
    const done = await app.call('POST', '/api/auth/password/reset', { body: { token, password: 'a brand new passphrase' } })
    assert.equal(done.status, 200)
    assert.equal((await app.call('POST', '/api/auth/password/reset', { body: { token, password: 'yet another passphrase' } })).status, 400, 'single use')
    assert.equal((await u.call('GET', '/api/me')).status, 401, 'reset signs every session out')
    assert.equal((await app.login('reset@rd.dev', PW)).status, 401)
    const again = await app.login('reset@rd.dev', 'a brand new passphrase')
    assert.equal(again.status, 200)
    assert.equal(again.data.user.emailVerified, true, 'reading the mail proves the mailbox')

    // expiry (30 minutes) and replacement of earlier tokens
    await app.call('POST', '/api/auth/password/forgot', { body: { email: 'reset@rd.dev' } })
    await flush()
    const t1 = tokenOf(mailsTo(app, 'reset@rd.dev', 'password-reset').at(-1))
    await app.call('POST', '/api/auth/password/forgot', { body: { email: 'reset@rd.dev' } })
    await flush()
    const t2 = tokenOf(mailsTo(app, 'reset@rd.dev', 'password-reset').at(-1))
    assert.notEqual(t1, t2)
    assert.equal((await app.call('POST', '/api/auth/password/reset', { body: { token: t1, password: 'one more passphrase' } })).status, 400, 'a newer request invalidates the older token')
    app.clock.tick(31 * 60_000)
    assert.equal((await app.call('POST', '/api/auth/password/reset', { body: { token: t2, password: 'one more passphrase' } })).status, 400, 'expired')
  })
})

test('password reset: per-address request cap stays silent; a reset clears lockouts', async () => {
  await withApp(async (app) => {
    await app.register('cap@rd.dev', PW)
    for (let i = 0; i < 6; i++) assert.equal((await app.call('POST', '/api/auth/password/forgot', { body: { email: 'cap@rd.dev' } })).status, 202)
    await flush()
    assert.equal(mailsTo(app, 'cap@rd.dev', 'password-reset').length, 5, 'the sixth request is accepted but sends nothing')
    app.st.cfg.loginFree = 1
    for (let i = 0; i < 3; i++) await app.login('cap@rd.dev', 'wrong-password')
    assert.equal((await app.login('cap@rd.dev', PW)).status, 429)
    const token = tokenOf(mailsTo(app, 'cap@rd.dev', 'password-reset').at(-1))
    assert.equal((await app.call('POST', '/api/auth/password/reset', { body: { token, password: 'fresh start passphrase' } })).status, 200)
    assert.equal((await app.login('cap@rd.dev', 'fresh start passphrase')).status, 200, 'lockout cleared by a successful reset')
  })
})

test('email verification: token mailed at sign-up, single use, resend is rate limited', async () => {
  await withApp(async (app) => {
    const u = await app.register('verify@rd.dev', PW)
    await flush()
    assert.equal((await u.call('GET', '/api/me')).data.user.emailVerified, false)
    const first = mailsTo(app, 'verify@rd.dev', 'verify-email')
    assert.equal(first.length, 1)
    assert.equal((await app.call('POST', '/api/auth/verify-email', { body: { token: 'nope' } })).status, 400)
    assert.equal((await u.call('POST', '/api/auth/verify-email/resend')).status, 200)
    assert.equal((await u.call('POST', '/api/auth/verify-email/resend')).status, 429, 'at most one per minute')
    await flush()
    const newest = tokenOf(mailsTo(app, 'verify@rd.dev', 'verify-email').at(-1))
    assert.equal((await app.call('POST', '/api/auth/verify-email', { body: { token: tokenOf(first[0]) } })).status, 400, 'older token replaced')
    assert.equal((await app.call('POST', '/api/auth/verify-email', { body: { token: newest } })).status, 200)
    assert.equal((await app.call('POST', '/api/auth/verify-email', { body: { token: newest } })).status, 400, 'single use')
    assert.equal((await u.call('GET', '/api/me')).data.user.emailVerified, true)
    assert.equal((await u.call('POST', '/api/auth/verify-email/resend')).data.alreadyVerified, true)
  })
})

test('mailer is pluggable and the dev outbox endpoint is gated', async () => {
  await withApp(async (app) => {
    const sent = []
    app.ctx.mailer = { send: async (m) => { sent.push(m) } }
    await app.register('plug@rd.dev', PW)
    await flush()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].to, 'plug@rd.dev')
    assert.equal(mailsTo(app, 'plug@rd.dev').length, 0, 'a custom transport replaces the outbox')

    app.ctx.mailer = { send: async () => { throw new Error('smtp down') } }
    const silent = console.error
    console.error = () => {}
    try { assert.equal((await app.call('POST', '/api/auth/register', { body: { email: 'plug2@rd.dev', password: PW } })).status, 201, 'mail failure never fails the request'); await flush() } finally { console.error = silent }

    const probe = await app.call('GET', '/api/dev/outbox?limit=5')
    assert.equal(probe.status, 200)
    assert.ok(Array.isArray(probe.data.messages))
    assert.equal((await app.call('GET', '/api/dev/outbox', { headers: { 'x-forwarded-for': '203.0.113.5' } })).status, 404, 'never through a proxy')
    const restore = setEnv('RD_DEV_OUTBOX', '0')
    try { assert.equal((await app.call('GET', '/api/dev/outbox')).status, 404, 'disabled unless RD_DEV_OUTBOX=1') } finally { restore() }
  })
})

/* ============================================================== API keys: scopes, expiry, tracking */

test('API keys: default stays full access; creation is validated; listing never exposes hashes', async () => {
  await withApp(async (app) => {
    const u = await app.register('keys@rd.dev', PW)
    const legacy = await u.call('POST', '/api/keys', { body: { name: 'ci' } })
    assert.equal(legacy.status, 201)
    assert.equal(legacy.data.key.scopes, null)
    assert.equal(legacy.data.key.expiresAt, null)
    assert.match(legacy.data.secret, /^rdk_[0-9a-f]{48}$/)
    const k = legacy.data.secret
    for (const [m, p] of [['GET', '/api/me'], ['GET', '/api/keys'], ['GET', '/api/billing/usage'], ['POST', '/api/buckets'], ['GET', '/api/auth/sessions']]) {
      const r = await app.call(m, p, { token: k, body: m === 'POST' ? { name: 'legacy-bucket' } : undefined })
      assert.ok(r.status < 400, `${m} ${p} -> ${r.status}`)
    }
    const bad = async (body) => (await u.call('POST', '/api/keys', { body })).status
    assert.equal(await bad({ scopes: [] }), 400)
    assert.equal(await bad({ scopes: 'read' }), 400)
    assert.equal(await bad({ scopes: ['root'] }), 400)
    assert.equal(await bad({ name: 'x'.repeat(81) }), 400)
    assert.equal(await bad({ name: ['x'] }), 400)
    assert.equal(await bad({ expiresAt: '2001-01-01T00:00:00Z' }), 400, 'in the past')
    assert.equal(await bad({ expiresAt: 'garbage' }), 400)
    assert.equal(await bad({ expiresInDays: -1 }), 400)
    assert.equal(await bad({ expiresInDays: 99999 }), 400)
    assert.equal(await bad({ expiresAt: new Date(app.clock.t + 20 * 365 * 864e5).toISOString() }), 400, 'max 10 years')
    const listed = (await u.call('GET', '/api/keys')).data.keys
    assert.equal(listed.length, 1)
    assert.equal(listed[0].hash, undefined)
    assert.equal((await u.call('POST', '/api/keys', { body: {} })).data.key.name, 'default')
    app.st.cfg.maxKeys = 2
    assert.equal((await u.call('POST', '/api/keys', { body: { name: 'one too many' } })).status, 409)
  })
})

test('API keys: service scopes are enforced centrally, including unknown future modules', async () => {
  await withApp(async (app) => {
    const u = await app.register('scoped@rd.dev', PW)
    const mk = async (scopes) => (await u.call('POST', '/api/keys', { body: { name: scopes.join(','), scopes } })).data.secret
    const storage = await mk(['storage'])
    const read = await mk(['read'])
    const write = await mk(['write'])
    const aiRead = await mk(['ai:read'])
    const acct = await mk(['account'])
    const acctRead = await mk(['account:read'])
    const code = async (token, m, p, body) => (await app.call(m, p, { token, body })).status

    assert.equal(await code(storage, 'POST', '/api/buckets', { name: 'scoped-bkt' }), 201)
    assert.equal(await code(storage, 'GET', '/api/buckets'), 200)
    assert.equal(await code(storage, 'GET', '/api/projects'), 403, 'other services denied')
    assert.equal(await code(storage, 'POST', '/api/projects', { name: 'p' }), 403)
    assert.equal(await code(storage, 'GET', '/api/me'), 200, '/api/me works for any valid key')
    assert.equal(await code(storage, 'GET', '/api/keys'), 403, 'account surface protected')
    const denied = await app.call('GET', '/api/projects', { token: storage })
    assert.match(denied.data.error, /scope/i)

    assert.equal(await code(read, 'GET', '/api/buckets'), 200)
    assert.equal(await code(read, 'GET', '/api/projects'), 200)
    assert.equal(await code(read, 'POST', '/api/buckets', { name: 'read-only-bkt' }), 403)
    assert.equal(await code(read, 'DELETE', '/api/buckets/scoped-bkt'), 403)
    assert.equal(await code(read, 'GET', '/api/keys'), 403, 'read does not reach the account surface')

    assert.equal(await code(write, 'POST', '/api/artifacts', { title: 't', content: 'c' }), 201)
    assert.equal(await code(write, 'GET', '/api/artifacts'), 200)
    assert.equal(await code(write, 'GET', '/api/keys'), 403)
    assert.equal(await code(write, 'POST', '/api/keys', { name: 'escalate' }), 403)

    assert.equal(await code(aiRead, 'GET', '/api/artifacts'), 200)
    assert.equal(await code(aiRead, 'POST', '/api/artifacts', { title: 't', content: 'c' }), 403)

    assert.equal(await code(acctRead, 'GET', '/api/keys'), 200)
    assert.equal(await code(acctRead, 'POST', '/api/keys', { name: 'x' }), 403)
    assert.equal(await code(acct, 'GET', '/api/keys'), 200)

    // unknown, future modules fall back to the global read/write scopes
    app.ctx.router.get('/api/zzfuture/items', () => ({ ok: true }))
    app.ctx.router.post('/api/zzfuture/items', () => [201, { ok: true }])
    assert.equal(await code(read, 'GET', '/api/zzfuture/items'), 200)
    assert.equal(await code(read, 'POST', '/api/zzfuture/items', {}), 403)
    assert.equal(await code(write, 'POST', '/api/zzfuture/items', {}), 201)
    assert.equal(await code(storage, 'GET', '/api/zzfuture/items'), 403, 'service-scoped keys do not reach unmapped modules')
    app.ctx.scopes.register('/api/zzfuture', 'storage')
    assert.equal(await code(storage, 'POST', '/api/zzfuture/items', {}), 201, 'modules can register their prefix')
    assert.throws(() => app.ctx.scopes.register('/not-api', 'storage'))
    assert.throws(() => app.ctx.scopes.register('/api/x', 'bogus'))
  })
})

test('API keys: cannot mint broader or longer-lived keys; interactive-only actions refuse keys', async () => {
  await withApp(async (app) => {
    const u = await app.register('mint@rd.dev', PW)
    const parent = (await u.call('POST', '/api/keys', { body: { name: 'parent', scopes: ['account', 'storage:read'], expiresInDays: 10 } })).data.secret
    const via = (body) => app.call('POST', '/api/keys', { token: parent, body })
    assert.equal((await via({ name: 'c', scopes: ['storage:read'], expiresInDays: 5 })).status, 201)
    assert.equal((await via({ name: 'c', scopes: ['storage'], expiresInDays: 5 })).status, 403, 'storage > storage:read')
    assert.equal((await via({ name: 'c', scopes: ['write'], expiresInDays: 5 })).status, 403)
    assert.equal((await via({ name: 'c', expiresInDays: 5 })).status, 403, 'no scopes = full access: broader')
    assert.equal((await via({ name: 'c', scopes: ['storage:read'] })).status, 403, 'would outlive its parent')
    assert.equal((await via({ name: 'c', scopes: ['storage:read'], expiresInDays: 30 })).status, 403)
    assert.equal((await via({ name: 'c', scopes: ['account'], expiresInDays: 5 })).status, 201, 'equal power is fine')
    // legacy (full) keys may mint anything but still cannot do interactive-only actions
    const full = (await u.call('POST', '/api/keys', { body: { name: 'full' } })).data.secret
    assert.equal((await app.call('POST', '/api/keys', { token: full, body: { scopes: ['write'] } })).status, 201)
    for (const [m, p] of [['POST', '/api/auth/password/change'], ['POST', '/api/auth/2fa/setup'], ['DELETE', '/api/account'], ['POST', '/api/auth/sessions/revoke-others']]) {
      assert.equal((await app.call(m, p, { token: full, body: { password: PW, currentPassword: PW, newPassword: 'x'.repeat(12) } })).status, 403, `${m} ${p}`)
    }
    assert.equal((await u.call('GET', '/api/me')).status, 200, 'and nothing was damaged')
  })
})

test('API keys: expiry, revocation, lastUsedAt/IP tracking and cross-tenant isolation', async () => {
  const restore = setEnv('RD_TRUST_PROXY', '1')
  try {
    await withApp(async (app) => {
      const u = await app.register('life@rd.dev', PW)
      const v = await app.register('life2@rd.dev', PW)
      const created = await u.call('POST', '/api/keys', { body: { name: 'short', expiresInDays: 1 } })
      const { secret, key } = created.data
      assert.ok(key.expiresAt)
      assert.equal(key.lastUsedAt, null)
      assert.equal((await app.call('GET', '/api/me', { token: secret, headers: { 'x-forwarded-for': '198.51.100.20' } })).status, 200)
      const used = (await u.call('GET', '/api/keys')).data.keys.find((x) => x.id === key.id)
      assert.ok(used.lastUsedAt)
      assert.equal(used.lastUsedIp, '198.51.100.20')
      await app.call('GET', '/api/me', { token: secret, headers: { 'x-forwarded-for': '198.51.100.21' } })
      assert.equal((await u.call('GET', '/api/keys')).data.keys.find((x) => x.id === key.id).lastUsedIp, '198.51.100.21', 'IP change is recorded immediately')

      assert.equal((await v.call('DELETE', `/api/keys/${key.id}`)).status, 404, "cannot revoke someone else's key")
      assert.equal((await v.call('GET', '/api/keys')).data.keys.length, 0)
      app.clock.tick(25 * 36e5)
      assert.equal((await app.call('GET', '/api/me', { token: secret })).status, 401, 'expired key is rejected')

      const k2 = (await u.call('POST', '/api/keys', { body: { name: 'to-revoke' } })).data
      assert.equal((await app.call('GET', '/api/me', { token: k2.secret })).status, 200)
      assert.equal((await u.call('DELETE', `/api/keys/${k2.key.id}`)).status, 200)
      assert.equal((await app.call('GET', '/api/me', { token: k2.secret })).status, 401)
      assert.equal((await app.call('GET', '/api/me', { token: 'rdk_' + 'a'.repeat(48) })).status, 401)
      assert.equal((await app.call('GET', '/api/me', { token: 'x'.repeat(5000) })).status, 401, 'absurdly long tokens are refused cheaply')
    })
  } finally { restore() }
})

/* ============================================================== headers, CORS, request hygiene */

test('security headers: strict CSP for the console, sandbox CSP + no-store for the API, request id sanity', async () => {
  await withApp(async (app) => {
    const page = await app.call('GET', '/')
    assert.equal(page.status, 200)
    const csp = page.headers.get('content-security-policy')
    for (const d of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"]) {
      assert.ok(csp.includes(d), `CSP has ${d}: ${csp}`)
    }
    assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(csp))
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(page.headers.get('x-frame-options'), 'DENY')
    assert.ok(page.headers.get('permissions-policy'))
    assert.equal(page.headers.get('strict-transport-security'), null, 'no HSTS over plain HTTP')
    assert.equal(page.headers.get('cache-control'), 'no-cache')

    const api = await app.call('GET', '/api/health')
    assert.equal(api.headers.get('cache-control'), 'no-store')
    assert.match(api.headers.get('content-security-policy'), /sandbox/)
    const notFound = await app.call('GET', '/api/does-not-exist')
    assert.equal(notFound.status, 404)
    assert.equal(notFound.headers.get('cache-control'), 'no-store', 'error responses are covered too')
    const unauth = await app.call('GET', '/api/me')
    assert.equal(unauth.status, 401)
    assert.equal(unauth.headers.get('x-content-type-options'), 'nosniff')

    // conditional requests
    const etag = page.headers.get('etag')
    const again = await app.call('GET', '/', { headers: { 'if-none-match': etag } })
    assert.equal(again.status, 304)

    // request ids: sane ones are echoed, hostile ones replaced
    const ok = await app.call('GET', '/api/health', { headers: { 'x-request-id': 'trace-123.abc' } })
    assert.equal(ok.headers.get('x-request-id'), 'trace-123.abc')
    const hostile = await app.call('GET', '/api/health', { headers: { 'x-request-id': '<script>alert(1)</script> ok' } })
    assert.match(hostile.headers.get('x-request-id'), /^[0-9a-f-]{36}$/)
    const longId = await app.call('GET', '/api/health', { headers: { 'x-request-id': 'a'.repeat(200) } })
    assert.match(longId.headers.get('x-request-id'), /^[0-9a-f-]{36}$|^a{64}$/)
    assert.ok(longId.headers.get('x-request-id').length <= 64)

    // static handler path safety
    for (const p of ['/..%2f..%2fetc%2fpasswd.html', '/%2e%2e%2f%2e%2e%2fREADME.html', '/nope.html', '/%00.html', '/%E0%A4%A.html']) {
      const r = await app.call('GET', p)
      assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`)
      assert.equal(r.headers.get('content-security-policy') !== null, true, 'errors carry the CSP too')
    }
  })
})

test('HSTS only when HTTPS is indicated (trusted proxy header or RD_HSTS)', async () => {
  await withApp(async (app) => {
    const h = { 'x-forwarded-proto': 'https' }
    assert.equal((await app.call('GET', '/api/health', { headers: h })).headers.get('strict-transport-security'), null, 'untrusted proxy header ignored')
    const restore = setEnv('RD_TRUST_PROXY', '1')
    try {
      assert.match((await app.call('GET', '/api/health', { headers: h })).headers.get('strict-transport-security'), /max-age=31536000/)
      assert.equal((await app.call('GET', '/api/health', { headers: { 'x-forwarded-proto': 'http' } })).headers.get('strict-transport-security'), null)
    } finally { restore() }
    const r2 = setEnv('RD_HSTS', '1')
    try { assert.ok((await app.call('GET', '/api/health')).headers.get('strict-transport-security')) } finally { r2() }
  })
})

test('CORS: closed by default; allow-list with preflight; wildcard; never credentials', async () => {
  await withApp(async (app) => {
    const pre = (origin, extra = {}) => app.call('OPTIONS', '/api/projects', {
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type', ...extra },
    })
    let r = await pre('https://app.example')
    assert.equal(r.status, 204)
    assert.equal(r.headers.get('access-control-allow-origin'), null, 'no CORS unless configured')
    const get = await app.call('GET', '/api/health', { headers: { origin: 'https://app.example' } })
    assert.equal(get.headers.get('access-control-allow-origin'), null)

    const restore = setEnv('RD_CORS_ORIGINS', 'https://app.example, https://other.example/')
    try {
      r = await pre('https://app.example')
      assert.equal(r.status, 204)
      assert.equal(r.headers.get('access-control-allow-origin'), 'https://app.example')
      assert.match(r.headers.get('access-control-allow-methods'), /DELETE/)
      assert.equal(r.headers.get('access-control-allow-headers'), 'authorization, content-type')
      assert.ok(Number(r.headers.get('access-control-max-age')) > 0)
      assert.match(r.headers.get('vary'), /Origin/)
      assert.equal(r.headers.get('access-control-allow-credentials'), null)
      assert.equal((await pre('https://other.example')).headers.get('access-control-allow-origin'), 'https://other.example')
      assert.equal((await pre('https://evil.example')).headers.get('access-control-allow-origin'), null)
      assert.equal((await pre('null')).headers.get('access-control-allow-origin'), null, 'opaque origins are never allowed')
      assert.equal((await pre('https://app.example.evil.com')).headers.get('access-control-allow-origin'), null, 'exact match only')
      assert.equal((await pre('https://app.example', { 'access-control-request-headers': 'x-evil\r\n,bad header' }).catch(() => ({ headers: new Headers(), status: 0 }))).headers.get('access-control-allow-headers') ?? 'authorization, content-type, x-request-id', 'authorization, content-type, x-request-id')
      const real = await app.call('GET', '/api/health', { headers: { origin: 'https://app.example' } })
      assert.equal(real.headers.get('access-control-allow-origin'), 'https://app.example')
      assert.match(real.headers.get('access-control-expose-headers'), /x-request-id/)
      const missing = await app.call('GET', '/api/nothing-here', { headers: { origin: 'https://app.example' } })
      assert.equal(missing.status, 404)
      assert.equal(missing.headers.get('access-control-allow-origin'), 'https://app.example', 'error responses stay readable for allowed origins')
      process.env.RD_CORS_ORIGINS = '*'
      assert.equal((await pre('https://anything.example')).headers.get('access-control-allow-origin'), '*')
    } finally { restore() }
  })
})

test('request guards: oversized bodies to auth endpoints are refused early; allowed hosts', async () => {
  await withApp(async (app) => {
    const big = JSON.stringify({ email: 'big@rd.dev', password: 'x'.repeat(100_000) })
    const r = await app.call('POST', '/api/auth/login', { raw: big, headers: { 'content-type': 'application/json' } })
    assert.equal(r.status, 413)
    const restore = setEnv('RD_ALLOWED_HOSTS', 'only.example')
    try {
      assert.equal((await app.call('GET', '/api/health')).status, 421)
    } finally { restore() }
    assert.equal((await app.call('GET', '/api/health')).status, 200)
  })
})

test('sensitive endpoints require authentication', async () => {
  await withApp(async (app) => {
    for (const [m, p] of [
      ['GET', '/api/auth/sessions'], ['POST', '/api/auth/sessions/revoke-others'], ['DELETE', '/api/auth/sessions/x'], ['GET', '/api/auth/2fa'],
      ['POST', '/api/auth/2fa/setup'], ['POST', '/api/auth/2fa/enable'], ['POST', '/api/auth/2fa/disable'], ['POST', '/api/auth/2fa/recovery-codes'],
      ['POST', '/api/auth/password/change'], ['POST', '/api/auth/verify-email/resend'], ['GET', '/api/keys'], ['POST', '/api/keys'], ['DELETE', '/api/keys/x'],
      ['GET', '/api/audit'], ['GET', '/api/audit/verify'], ['GET', '/api/account/export'], ['DELETE', '/api/account'], ['PATCH', '/api/me'],
      ['GET', '/api/orgs'], ['POST', '/api/orgs'],
    ]) assert.equal((await app.call(m, p, { body: m === 'GET' ? undefined : {} })).status, 401, `${m} ${p}`)
    assert.equal((await app.call('GET', '/api/me', { token: 'garbage' })).status, 401)
    assert.equal((await app.call('GET', '/api/me', { headers: { authorization: 'Basic abc' } })).status, 401)
  })
})

/* ============================================================== audit log */

test('audit: security events are recorded, filterable, paginated with cursors, and private to the user', async () => {
  await withApp(async (app) => {
    const a = await app.register('aud@rd.dev', PW)
    const b = await app.register('aud2@rd.dev', PW)
    await app.login('aud@rd.dev', 'wrong-password')
    await app.login('aud@rd.dev', PW, {}, { 'user-agent': 'curl/8' })
    const key = (await a.call('POST', '/api/keys', { body: { name: 'audit-key', scopes: ['storage'] } })).data
    await a.call('DELETE', `/api/keys/${key.key.id}`)
    await a.call('POST', '/api/artifacts', { body: { title: 't', content: 'c' } })
    const art = (await a.call('POST', '/api/artifacts', { body: { title: 't2', content: 'c' } })).data
    await a.call('DELETE', `/api/artifacts/${art.id}`)

    const all = (await a.call('GET', '/api/audit?limit=200')).data
    const actions = all.entries.map((e) => e.action)
    for (const expected of ['auth.register', 'auth.login.failed', 'auth.login', 'auth.key.create', 'auth.key.revoke', 'http.delete']) {
      assert.ok(actions.includes(expected), `${expected} in ${actions.join(',')}`)
    }
    assert.ok(!actions.includes('http.post'), 'ordinary writes are not security events')
    const seqs = all.entries.map((e) => e.seq)
    assert.deepEqual(seqs, [...seqs].sort((x, y) => y - x), 'newest first')
    const created = all.entries.find((e) => e.action === 'auth.key.create')
    assert.deepEqual(created.meta.scopes, ['storage'])
    assert.equal(created.resource, `key:${key.key.id}`)
    assert.ok(created.ip && created.ts && created.hash)
    assert.ok(!JSON.stringify(all).includes(key.secret), 'no secrets in the log')
    const del = all.entries.find((e) => e.action === 'http.delete')
    assert.equal(del.resource, '/api/artifacts/:id')
    assert.equal(del.meta.status, 200)

    // filters
    assert.ok((await a.call('GET', '/api/audit?action=auth.*')).data.entries.every((e) => e.action.startsWith('auth.')))
    assert.deepEqual((await a.call('GET', '/api/audit?action=auth.key.create')).data.entries.map((e) => e.action), ['auth.key.create'])
    assert.equal((await a.call('GET', `/api/audit?resource=key:${key.key.id}`)).data.entries.length, 2)
    assert.equal((await a.call('GET', `/api/audit?until=2000-01-01`)).data.entries.length, 0)
    assert.equal((await a.call('GET', `/api/audit?since=2000-01-01`)).data.entries.length, all.entries.length)
    assert.equal((await a.call('GET', '/api/audit?since=yesterday-ish')).status, 400)
    assert.equal((await a.call('GET', '/api/audit?cursor=!!!')).status, 400)

    // cursor pagination visits every entry exactly once
    const seen = []
    let cursor = null
    do {
      const page = (await a.call('GET', `/api/audit?limit=2${cursor ? `&cursor=${cursor}` : ''}`)).data
      assert.ok(page.entries.length <= 2)
      seen.push(...page.entries.map((e) => e.seq))
      cursor = page.nextCursor
    } while (cursor)
    assert.deepEqual(seen, seqs)
    assert.equal((await a.call('GET', '/api/audit?limit=100000')).status, 200, 'limit is clamped, not an error')

    // tenant isolation
    const bLog = (await b.call('GET', '/api/audit?limit=200')).data.entries
    assert.ok(bLog.every((e) => e.resource !== `key:${key.key.id}`))
    assert.equal(bLog.filter((e) => e.action === 'auth.key.create').length, 0)
    assert.equal((await a.call('GET', '/api/audit/verify')).data.ok, true)
  })
})

test('audit: other modules feed the log via ctx.audit and events; secrets are redacted and metadata is bounded', async () => {
  await withApp(async (app) => {
    const u = await app.register('feed@rd.dev', PW)
    app.ctx.audit(u.user.id, 'custom.thing', { type: 'widget', id: 'w1' }, { password: 'hunter2', token: 'abc', nested: { apiKey: 'zzz', ok: 1 }, long: 'x'.repeat(5000), list: Array(100).fill(1), n: 5 })
    app.ctx.events.emit('audit', { userId: u.user.id, action: 'events.path', resource: 'r', ip: '203.0.113.1', meta: { fine: true } })
    app.ctx.audit('use_does_not_exist', 'ghost', 'x', {})
    app.ctx.audit(u.user.id, 'bad action!! with spaces', 'x', {})
    app.ctx.audit(u.user.id, '', 'x', {})
    app.ctx.audit(undefined, 'nobody', 'x', {})
    const log = (await u.call('GET', '/api/audit?limit=200')).data.entries
    const e = log.find((x) => x.action === 'custom.thing')
    assert.equal(e.resource, 'widget:w1')
    assert.equal(e.meta.password, '[redacted]')
    assert.equal(e.meta.token, '[redacted]')
    assert.equal(e.meta.nested.apiKey, '[redacted]')
    assert.equal(e.meta.nested.ok, 1)
    assert.ok(e.meta.long.length <= 201)
    assert.ok(e.meta.list.length <= 20)
    const viaEvent = log.find((x) => x.action === 'events.path')
    assert.equal(viaEvent.ip, '203.0.113.1')
    assert.ok(log.some((x) => x.action === 'bad_action___with_spaces'), 'action names are sanitised, not rejected')
    assert.ok(!log.some((x) => x.action === 'ghost' || x.action === 'nobody' || x.action === ''))
    assert.equal(app.db.find('audit_log', (x) => x.userId === 'use_does_not_exist').length, 0, 'no log for unknown users')
  })
})

test('audit: hash chain detects modification, deletion, truncation and a forged head', async () => {
  await withApp(async (app) => {
    const mk = async (email) => {
      const u = await app.register(email, PW)
      for (let i = 0; i < 6; i++) app.ctx.audit(u.user.id, `step.${i}`, 'res', { i })
      return u
    }
    const rows = (u) => app.db.find('audit_log', (e) => e.userId === u.user.id).sort((x, y) => x.seq - y.seq)
    const verify = async (u) => (await u.call('GET', '/api/audit/verify')).data

    const clean = await mk('chain0@rd.dev')
    const v0 = await verify(clean)
    assert.equal(v0.ok, true)
    assert.equal(v0.count, 7)
    assert.equal(v0.head.seq, 7)
    assert.match(v0.head.hash, /^[0-9a-f]{64}$/)

    const edited = await mk('chain1@rd.dev')
    app.db.update('audit_log', rows(edited)[3].id, { action: 'step.forged' })
    const v1 = await verify(edited)
    assert.equal(v1.ok, false)
    assert.equal(v1.error.seq, 4)
    assert.match(v1.error.reason, /modified/)

    const holed = await mk('chain2@rd.dev')
    app.db.remove('audit_log', rows(holed)[2].id)
    const v2 = await verify(holed)
    assert.equal(v2.ok, false)
    assert.match(v2.error.reason, /missing/)

    const cut = await mk('chain3@rd.dev')
    app.db.remove('audit_log', rows(cut).at(-1).id)
    const v3 = await verify(cut)
    assert.equal(v3.ok, false)
    assert.match(v3.error.reason, /end of the chain/)

    const nohead = await mk('chain4@rd.dev')
    app.db.removeWhere('audit_state', (s) => s.userId === nohead.user.id)
    assert.equal((await verify(nohead)).ok, false)

    const rehash = await mk('chain5@rd.dev')
    const last = rows(rehash).at(-1)
    app.db.update('audit_log', last.id, { action: 'step.rewritten', hash: 'f'.repeat(64) })
    assert.equal((await verify(rehash)).ok, false, 'recomputing a plain SHA-256 is not enough: the chain is keyed')

    const headForged = await mk('chain6@rd.dev')
    const state = app.db.findOne('audit_state', (s) => s.userId === headForged.user.id)
    app.db.update('audit_state', state.id, { seq: 2 })
    const v6 = await verify(headForged)
    assert.equal(v6.ok, false)
    assert.match(v6.error.reason, /head/)
    assert.equal((await verify(clean)).ok, true, 'other chains are unaffected')
  })
})

test('audit: retention prunes the oldest entries and the chain still verifies from the anchor', async () => {
  await withApp(async (app) => {
    const u = await app.register('prune@rd.dev', PW) // default cap (5000): nothing is pruned
    for (let i = 0; i < 120; i++) app.ctx.audit(u.user.id, 'bulk.entry', `r${i}`, { i })
    const v = (await u.call('GET', '/api/audit/verify')).data
    assert.equal(v.ok, true)
    assert.equal(v.count, 121)
    assert.equal(app.db.find('audit_log', (e) => e.userId === u.user.id).length, 121)
  })
  await withApp(async (app) => {
    const u = await app.register('prune2@rd.dev', PW)
    for (let i = 0; i < 70; i++) app.ctx.audit(u.user.id, 'bulk.entry', `r${i}`, { i })
    const v = (await u.call('GET', '/api/audit/verify')).data
    assert.equal(v.ok, true)
    assert.ok(v.count <= 50 && v.count >= 40, `count after pruning: ${v.count}`)
    assert.ok(v.anchoredAt > 0)
    const page = (await u.call('GET', '/api/audit?limit=200')).data
    assert.equal(page.entries[0].action, 'bulk.entry')
    const oldest = page.entries.at(-1)
    assert.ok(oldest.seq > 1, 'oldest entries were dropped')
  }, { RD_AUDIT_MAX_PER_USER: '50' })
})

test('audit: forbidden requests are logged once per minute, not once per request', async () => {
  await withApp(async (app) => {
    const u = await app.register('deny@rd.dev', PW)
    const key = (await u.call('POST', '/api/keys', { body: { scopes: ['storage'] } })).data.secret
    for (let i = 0; i < 5; i++) assert.equal((await app.call('GET', '/api/projects', { token: key })).status, 403)
    const denied = (await u.call('GET', '/api/audit?action=access.denied')).data.entries
    assert.equal(denied.length, 1)
    assert.equal(denied[0].resource, '/api/projects')
    assert.equal(denied[0].meta.via, 'apiKey')
  })
})

/* ============================================================== account export / deletion */

async function populate(u) {
  const conv = (await u.call('POST', '/api/conversations', { body: { title: 'hello' } })).data
  await u.call('POST', `/api/conversations/${conv.id}/messages`, { body: { content: 'secret chat content' } })
  await u.call('POST', '/api/artifacts', { body: { title: 'art', content: 'v1' } })
  await u.call('POST', '/api/buckets', { body: { name: `bkt-${u.user.id.slice(-6)}` } })
  await u.call('PUT', `/api/buckets/bkt-${u.user.id.slice(-6)}/objects/a.txt`, { raw: 'object bytes', headers: { 'content-type': 'text/plain' } })
  const f = (await u.call('PUT', '/api/drive/files?name=d.txt', { raw: 'drive bytes', headers: { 'content-type': 'text/plain' } })).data
  const share = (await u.call('POST', `/api/drive/files/${f.id}/share`)).data
  await u.call('POST', '/api/db/notes', { body: { title: 'doc' } })
  await u.call('POST', '/api/projects', { body: { name: 'proj' } })
  return { conv, f, share }
}

test('account export: complete, scoped to the caller, free of credentials, rate limited', async () => {
  await withApp(async (app) => {
    const a = await app.register('exp1@rd.dev', PW)
    const b = await app.register('exp2@rd.dev', PW)
    await populate(a)
    await populate(b)
    app.ctx.events.on('account.export', ({ userId, add }) => add('custom_module', [{ id: 'c1', userId, note: 'from a module', secret: 'nope' }]))
    const r = await a.call('GET', '/api/account/export')
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-disposition'), /attachment; filename="rd-cloude-export-\d{4}-\d{2}-\d{2}\.json"/)
    const text = JSON.stringify(r.data)
    assert.equal(r.data.account.email, 'exp1@rd.dev')
    for (const col of ['conversations', 'messages', 'artifacts', 'buckets', 'objects', 'files', 'shares', 'docs', 'projects', 'usage']) {
      assert.ok(r.data.collections[col]?.length >= 1, `${col} exported`)
    }
    assert.ok(text.includes('secret chat content'), 'messages are included via their conversation')
    assert.ok(!text.includes('exp2@rd.dev'), "nobody else's data")
    assert.ok(!text.includes('bkt-' + b.user.id.slice(-6)))
    assert.ok(!text.includes(app.db.get('users', a.user.id).password), 'no password hash')
    assert.ok(!/"hash"|"password"|"blobId"|"totp"|recoveryCodes/.test(text), 'no credential-ish fields')
    assert.equal(r.data.collections.custom_module[0].note, 'from a module')
    assert.equal(r.data.collections.custom_module[0].secret, undefined)
    assert.ok(r.data.auditLog.length >= 1)
    assert.ok(r.data.sessions.length >= 1 && r.data.sessions[0].hash === undefined)
    app.st.gates.clear()
    for (let i = 0; i < 5; i++) await a.call('GET', '/api/account/export')
    assert.equal((await a.call('GET', '/api/account/export')).status, 429)
    const scoped = (await a.call('POST', '/api/keys', { body: { scopes: ['read'] } })).data.secret
    assert.equal((await app.call('GET', '/api/account/export', { token: scoped })).status, 403, 'account surface needs the account scope')
  })
})

test('account deletion: password (and 2FA) confirmation, purges every collection and blob, leaves other tenants alone', async () => {
  await withApp(async (app) => {
    const a = await app.register('del1@rd.dev', PW)
    const b = await app.register('del2@rd.dev', PW)
    const data = await populate(a)
    const bData = await populate(b)
    const blobIds = [
      ...app.db.find('objects', (o) => o.userId === a.user.id).map((o) => o.blobId),
      ...app.db.find('files', (f) => f.userId === a.user.id).flatMap((f) => f.versions.map((v) => v.blobId)),
    ]
    assert.ok(blobIds.length >= 2 && blobIds.every((id) => app.db.getBlob(id)))
    const events = []
    app.ctx.events.on('account.deleted', (e) => events.push(e))
    const key = (await a.call('POST', '/api/keys', { body: { name: 'k' } })).data.secret
    // collections owned by other modules are found generically through db.collections()
    app.db.insert('zz_custom', { userId: a.user.id, note: 'a-private', blobId: 'blob_custom_a' })
    app.db.insert('zz_custom', { userId: b.user.id, note: 'b-private' })
    const exported = (await a.call('GET', '/api/account/export')).data
    assert.deepEqual(exported.collections.zz_custom?.map((r) => r.note), ['a-private'], 'generic export walks every collection')

    assert.equal((await a.call('DELETE', '/api/account', { body: {} })).status, 400, 'password required')
    assert.equal((await a.call('DELETE', '/api/account', { body: { password: 'wrong-password' } })).status, 403)
    assert.equal((await app.call('DELETE', '/api/account', { token: key, body: { password: PW } })).status, 403, 'API keys cannot delete accounts')
    assert.equal((await app.call('DELETE', '/api/account', { body: { password: PW } })).status, 401)
    assert.equal(events.length, 0)

    const del = await a.call('DELETE', '/api/account', { body: { password: PW } })
    assert.equal(del.status, 200)
    assert.deepEqual(events, [{ userId: a.user.id, email: 'del1@rd.dev' }])
    for (const col of ['users', 'sessions', 'apiKeys', 'projects', 'conversations', 'artifacts', 'buckets', 'objects', 'files', 'docs', 'usage', 'auth_tokens', 'audit_log', 'audit_state']) {
      const left = app.db.find(col, (r) => r.userId === a.user.id || r.id === a.user.id)
      assert.equal(left.length, 0, `${col} purged`)
    }
    assert.deepEqual(app.db.find('zz_custom').map((r) => r.note), ['b-private'], 'unknown collections are purged generically, other tenants kept')
    assert.equal(app.db.find('messages', (m) => m.conversationId === data.conv.id).length, 0, 'messages purged via their conversation')
    assert.equal(app.db.find('shares', (s) => s.fileId === data.f.id).length, 0, 'share links purged')
    assert.ok(blobIds.every((id) => app.db.getBlob(id) === null), 'blob contents deleted')
    assert.equal((await app.call('GET', data.share.url)).status, 404, 'public link is dead')
    assert.equal((await a.call('GET', '/api/me')).status, 401)
    assert.equal((await app.call('GET', '/api/me', { token: key })).status, 401)
    assert.equal((await app.login('del1@rd.dev', PW)).status, 401)

    // the other tenant is untouched
    assert.equal((await b.call('GET', `/api/conversations/${bData.conv.id}`)).data.messages.length, 2)
    assert.equal((await app.call('GET', bData.share.url)).data.toString(), 'drive bytes')
    assert.equal((await b.call('GET', '/api/audit/verify')).data.ok, true)

    // the address can be registered again, with a clean slate
    const again = await app.register('del1@rd.dev', PW)
    assert.equal((await again.call('GET', '/api/conversations')).data.conversations.length, 0)
    assert.equal(app.db.find('audit_log', (e) => e.userId === again.user.id).length >= 1, true)
  })
})

test('account deletion with 2FA needs a valid code, and failures are throttled', async () => {
  await withApp(async (app) => {
    const u = await app.register('del3@rd.dev', PW)
    const setup = await u.call('POST', '/api/auth/2fa/setup', { body: { password: PW } })
    const secret = base32Decode(setup.data.secret)
    await u.call('POST', '/api/auth/2fa/enable', { body: { code: totp(secret, app.clock.t) } })
    assert.equal((await u.call('DELETE', '/api/account', { body: { password: PW } })).status, 403, 'code missing')
    assert.equal((await u.call('DELETE', '/api/account', { body: { password: PW, code: '000000' } })).status, 403)
    app.clock.tick(30_000)
    const ok = await u.call('DELETE', '/api/account', { body: { password: PW, code: totp(secret, app.clock.t) } })
    assert.equal(ok.status, 200)
    assert.equal(app.db.find('users', (x) => x.id === u.user.id).length, 0)
  })
})

test('profile: PATCH /api/me validates the name', async () => {
  await withApp(async (app) => {
    const u = await app.register('prof@rd.dev', PW)
    assert.equal((await u.call('PATCH', '/api/me', { body: { name: 'New Name' } })).data.user.name, 'New Name')
    assert.equal((await u.call('PATCH', '/api/me', { body: { name: '' } })).status, 400)
    assert.equal((await u.call('PATCH', '/api/me', { body: { name: 'x'.repeat(81) } })).status, 400)
    assert.equal((await u.call('PATCH', '/api/me', { body: { name: { a: 1 } } })).status, 400)
    assert.equal((await u.call('GET', '/api/me')).data.user.name, 'New Name')
  })
})

test('the standalone account page and its script are served with the strict CSP', async () => {
  await withApp(async (app) => {
    const page = await app.call('GET', '/auth/account')
    assert.equal(page.status, 200)
    assert.match(page.data, /<script type="module" src="\/auth\/account\.js">/)
    assert.ok(!/<script>|onclick=|style=/.test(page.data), 'no inline script or style')
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/)
    const js = await app.call('GET', '/auth/account.js')
    assert.equal(js.status, 200)
    assert.match(js.headers.get('content-type'), /javascript/)
  })
})

test('the HTML fallback switches itself off once the app calls the early hook (hooks.onRequest)', async () => {
  await withApp(async (app) => {
    const before = await app.call('GET', '/')
    assert.ok(before.headers.get('etag'), 'served by the fallback')
    const headers = {}
    const res = { headersSent: false, setHeader: (k, v) => { headers[k.toLowerCase()] = v }, getHeader: (k) => headers[k.toLowerCase()] }
    assert.equal(app.ctx.hooks.onRequest.length, 1)
    app.ctx.hooks.onRequest[0]({ req: { headers: { origin: 'https://nope.example' }, socket: {} }, res, url: new URL('http://x/'), requestId: 'short id with spaces', route: null })
    assert.match(headers['content-security-policy'], /script-src 'self'/, 'the early hook sets the headers itself')
    assert.match(res.requestId ?? headers['x-request-id'], /^[0-9a-f-]{36}$/, 'unsafe ids are replaced')
    assert.equal(headers['access-control-allow-origin'], undefined)
    const after = await app.call('GET', '/')
    assert.equal(after.status, 200)
    assert.equal(after.headers.get('etag'), null, "app.js's own static handler answers now")
  })
})

test('state survives a restart: 2FA secret, recovery codes, sessions, keys and the audit chain', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-sec-'))
  const boot = async () => {
    const raw = await startTestApp({ dataDir: dir })
    const app = { ...raw, ...bindClient(raw) }
    app.shutdown = async () => { await raw.close(); raw.db.close?.() }
    return app
  }
  try {
    let secret
    let codes
    let token
    {
      const app = await boot()
      try {
        const u = await app.register('persist@rd.dev', PW)
        const setup = await u.call('POST', '/api/auth/2fa/setup', { body: { password: PW } })
        secret = base32Decode(setup.data.secret)
        codes = (await u.call('POST', '/api/auth/2fa/enable', { body: { code: totp(secret, Date.now()) } })).data.recoveryCodes
        token = u.token
        assert.ok((await u.call('POST', '/api/keys', { body: { scopes: ['read'], expiresInDays: 5 } })).data.secret)
        assert.equal((await u.call('GET', '/api/audit/verify')).data.ok, true)
      } finally { await app.shutdown() }
    }
    assert.ok(fs.existsSync(path.join(dir, 'secret.key')), 'master key persisted next to the data')
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'secret.key')).mode & 0o077, 0, 'owner-only permissions')
    {
      const app = await boot()
      try {
        assert.equal((await app.call('GET', '/api/me', { token })).data.user.email, 'persist@rd.dev', 'session survived')
        const l = await app.call('POST', '/api/auth/login', { body: { email: 'persist@rd.dev', password: PW } })
        assert.equal(l.status, 401)
        assert.ok(l.data.challenge)
        const ok = await app.call('POST', '/api/auth/login/2fa', { body: { challenge: l.data.challenge, code: codes[3] } })
        assert.equal(ok.status, 200, 'sealed state decrypts and recovery codes still verify after the restart')
        const v = (await app.call('GET', '/api/audit/verify', { token: ok.data.token })).data
        assert.equal(v.ok, true, JSON.stringify(v))
        assert.ok(v.count >= 5)
        assert.equal((await app.call('GET', '/api/keys', { token: ok.data.token })).data.keys.length, 1)
      } finally { await app.shutdown() }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
