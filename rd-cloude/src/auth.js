// Authentication & identity for RD Cloude: passwords (scrypt, policy, throttling), sessions, TOTP two-factor auth,
// recovery codes, password reset / email verification, API keys with scopes + expiry, pluggable mailer.
// Zero dependencies (node:crypto only). Documented in docs/security.md. Also imported by
// src/modules/{security,orgs,audit}.js for the shared helpers exported below.
//
// Compatibility: `authRoutes(router, db[, ctx])` and `authenticate(db, req)` keep the signatures used by src/app.js.
// All mutable state is keyed by the `db` object (WeakMap) so several apps can live in one process (tests do).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { HttpError, required } from './http.js'

const scrypt = promisify(crypto.scrypt)

/* ======================================================================= small helpers */

export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const b64u = (buf) => Buffer.from(buf).toString('base64url')
export const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)

/** Compare two strings in constant time (hashes both first so lengths never leak). */
export function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest()
  const y = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(x, y)
}

/** Run synchronous db writes atomically when the engine supports transactions (all-or-nothing across a crash). */
export const tx = (db, fn) => (typeof db.transaction === 'function' ? db.transaction(fn) : fn())
/** Indexed lookups when the engine has them (O(1)), plain scans otherwise. `value` must be a defined string. */
export const many = (db, col, field, value) => (typeof db.findBy === 'function' ? db.findBy(col, field, value) : db.find(col, (r) => r[field] === value))
export const one = (db, col, field, value) => (typeof db.findOneBy === 'function' ? db.findOneBy(col, field, value) : db.findOne(col, (r) => r[field] === value))

/** Wrap a router so each route gets `meta.summary` from a "METHOD /path" table (feeds OpenAPI generation). */
export function withDocs(r, summaries) {
  const wrap = (m) => (p, h, o = {}) => r[m](p, h, { ...o, meta: { summary: summaries[`${m.toUpperCase()} ${p}`], ...o.meta } })
  return { get: wrap('get'), post: wrap('post'), put: wrap('put'), patch: wrap('patch'), delete: wrap('delete') }
}

export function bodyObj(body) {
  if (!isObj(body)) throw new HttpError(400, 'A JSON object body is required')
  return body
}

/** Validate a trimmed single-line string field. */
export function str(v, name, { min = 1, max = 200 } = {}) {
  if (typeof v !== 'string') throw new HttpError(400, `${name} must be a string`)
  const s = v.trim()
  if (s.length < min) throw new HttpError(400, `${name} is too short`)
  if (s.length > max) throw new HttpError(400, `${name} is too long (max ${max} characters)`)
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new HttpError(400, `${name} contains control characters`)
  return s
}

export function normEmail(v) {
  if (typeof v !== 'string') throw new HttpError(400, 'Invalid email')
  const e = v.trim().toLowerCase()
  if (e.length > 254 || e.indexOf('@') > 64 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, 'Invalid email')
  return e
}

export function trustedHops() {
  const v = (process.env.RD_TRUST_PROXY ?? '').trim().toLowerCase()
  if (!v || v === '0' || v === 'false') return 0
  if (v === 'true') return 1
  const n = Number(v)
  return Number.isInteger(n) && n > 0 && n <= 10 ? n : 1
}

/** Client address. X-Forwarded-For is only honoured when RD_TRUST_PROXY is set (value = number of trusted proxy hops). */
export function clientIp(req) {
  let ip = req.socket?.remoteAddress ?? ''
  const hops = trustedHops()
  if (hops) {
    const parts = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    if (parts.length) ip = parts[Math.max(0, parts.length - hops)]
  }
  return ip.replace(/^::ffff:/i, '').replace(/[^0-9a-fA-F:.]/g, '').slice(0, 64) || 'unknown'
}

/** "Chrome on macOS" style label from a User-Agent (informational only, never trusted). */
export function deviceLabel(ua = '') {
  const u = String(ua)
  if (!u) return 'Unknown device'
  const browser = /Edg\//.test(u) ? 'Edge' : /OPR\/|Opera/.test(u) ? 'Opera' : /Firefox\//.test(u) ? 'Firefox' : /Chrome\/|Chromium\//.test(u) ? 'Chrome'
    : /Safari\//.test(u) ? 'Safari' : /^curl\//i.test(u) ? 'curl' : /node|undici/i.test(u) ? 'Node.js client' : /python/i.test(u) ? 'Python client' : /^[A-Za-z][\w .-]{0,30}/.exec(u)?.[0]?.trim() || 'Unknown client'
  const os = /Windows/.test(u) ? 'Windows' : /iPhone|iPad|iOS/.test(u) ? 'iOS' : /Android/.test(u) ? 'Android' : /Mac OS X|Macintosh/.test(u) ? 'macOS' : /CrOS/.test(u) ? 'ChromeOS' : /Linux|X11/.test(u) ? 'Linux' : ''
  return os ? `${browser} on ${os}` : browser
}

/* ======================================================================= config + per-db state */

function readConfig() {
  const e = process.env
  const int = (k, d, lo, hi) => {
    if (e[k] === undefined || e[k] === '') return d
    const n = Number(e[k])
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : d
  }
  const policy = e.RD_PASSWORD_POLICY === 'strict' || (e.RD_PASSWORD_POLICY !== 'standard' && e.NODE_ENV === 'production') ? 'strict' : 'standard'
  return {
    sessionIdleMs: int('RD_SESSION_IDLE_HOURS', 168, 1, 24 * 365) * 36e5,
    sessionMaxMs: int('RD_SESSION_MAX_DAYS', 30, 1, 365) * 864e5,
    maxSessions: int('RD_MAX_SESSIONS', 10, 1, 100),
    loginFree: int('RD_LOGIN_FREE_ATTEMPTS', 5, 1, 100),
    ipFree: int('RD_LOGIN_IP_FREE_ATTEMPTS', 30, 1, 100000),
    lockBaseMs: int('RD_LOGIN_BASE_DELAY_MS', 1000, 1, 3_600_000),
    lockMaxMs: int('RD_LOGIN_MAX_DELAY_MS', 900_000, 1, 86_400_000),
    passwordPolicy: policy,
    passwordMin: int('RD_PASSWORD_MIN', 8, 8, 64),
    registerPerHour: int('RD_REGISTER_PER_HOUR', 100, 1, 1_000_000),
    maxKeys: int('RD_MAX_API_KEYS', 50, 1, 1000),
    tfaFree: int('RD_2FA_FREE_ATTEMPTS', 10, 1, 1000),
  }
}

const STATES = new WeakMap()
/** Mutable runtime state for one app (db). Tests may tweak `.cfg` and `.now`. */
export function authState(db) {
  let st = STATES.get(db)
  if (!st) {
    st = {
      db, ctx: null, cfg: readConfig(), now: () => Date.now(),
      throttle: new Map(), inflight: new Map(), challenges: new Map(), gates: new Map(), keys: {}, master: null, outbox: [], mailWarned: false,
    }
    STATES.set(db, st)
  }
  return st
}

/** Bind an app context: installs the default dev mailer and the ctx.audit() shim (audit.js replaces nothing, it listens). */
export function initAuth(ctx) {
  const st = authState(ctx.db)
  if (st.ctx !== ctx) {
    st.ctx = ctx
    ctx.mailer ??= makeMailer(st)
    ctx.audit ??= (userId, action, resource, meta, extra) => ctx.events.emit('audit', { userId, action, resource, meta, ...extra })
  }
  return st
}

/** Emit an audit event (fire-and-forget; never throws). */
export function emitAudit(ctx, req, requestId, userId, action, resource, meta) {
  try {
    ctx?.events?.emit('audit', { userId, action, resource, ip: req ? clientIp(req) : undefined, requestId, meta })
  } catch (e) {
    console.error('[rd-cloude] audit emit failed:', e.message)
  }
}

/* ======================================================================= keys at rest (AES-GCM + HMAC subkeys) */

/** Master secret: RD_SECRET_KEY, else <dataDir>/secret.key (created 0600), else random per process (in-memory mode). */
export function masterKey(ctx) {
  const st = authState(ctx.db)
  if (st.master) return st.master
  const env = process.env.RD_SECRET_KEY
  let raw = null
  if (env) {
    if (env.length < 16) throw new Error('RD_SECRET_KEY must be at least 16 characters')
    raw = Buffer.from(env, 'utf8')
  } else if (ctx.config?.dataDir) {
    const dir = ctx.config.dataDir
    const file = path.join(dir, 'secret.key')
    const read = () => {
      try {
        const b = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex')
        return b.length === 32 ? b : null
      } catch { return null }
    }
    raw = read()
    if (!raw) {
      fs.mkdirSync(dir, { recursive: true })
      try { fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }) } catch (e) { if (e.code !== 'EEXIST') throw e }
      raw = read()
      if (!raw) throw new Error(`Unusable secret key file ${file}`)
    }
  } else raw = crypto.randomBytes(32)
  st.master = Buffer.from(crypto.hkdfSync('sha256', raw, Buffer.alloc(0), 'rd-cloude/master', 32))
  return st.master
}

export function deriveKey(ctx, label) {
  const st = authState(ctx.db)
  return (st.keys[label] ??= Buffer.from(crypto.hkdfSync('sha256', masterKey(ctx), Buffer.alloc(0), `rd-cloude/${label}`, 32)))
}

function seal(key, plain, aad) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return ['v1', b64u(iv), b64u(c.getAuthTag()), b64u(ct)].join('.')
}
function unseal(key, sealed, aad) {
  const [v, iv, tag, ct] = String(sealed).split('.')
  if (v !== 'v1' || !ct) throw new Error('bad sealed value')
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8')
}

/* ======================================================================= passwords */

const MAX_HASHERS = 3
let activeHashers = 0
const hasherQueue = []
async function withHasherSlot(fn) {
  if (activeHashers >= MAX_HASHERS) {
    if (hasherQueue.length >= 256) throw new HttpError(503, 'Server busy, retry shortly')
    await new Promise((resolve) => hasherQueue.push(resolve))
  }
  activeHashers++
  try { return await fn() } finally {
    activeHashers--
    hasherQueue.shift()?.()
  }
}

/** scrypt, `salt:hash` (hex) - the format used since the first release. Async + bounded so floods cannot block the event loop. */
export async function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = await withHasherSlot(() => scrypt(pw, salt, 64))
  return `${salt}:${hash.toString('hex')}`
}
export async function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored ?? '').split(':')
  if (!salt || !hash) return false
  const a = Buffer.from(hash, 'hex')
  const b = await withHasherSlot(() => scrypt(pw, salt, a.length || 64))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
let dummyHash
const dummy = () => (dummyHash ??= hashPassword(crypto.randomBytes(12).toString('hex')))

// Top of the usual breach lists (lowercase). Not exhaustive: it blocks the worst offenders, it is not a strength meter.
const COMMON = new Set(`password 123456 12345678 123456789 1234567890 12345 1234567 qwerty qwerty123 qwertyuiop abc123 abcd1234 abcdefgh password1 password12
password123 password1234 passw0rd p@ssw0rd p@ssword iloveyou welcome welcome1 welcome123 admin admin123 administrator letmein monkey dragon master
sunshine princess football baseball soccer hockey batman superman trustno1 shadow michael jennifer jordan hunter ranger harley buster thomas robert
daniel andrew joshua charlie ashley nicole jessica pepper summer winter spring autumn secret secret123 changeme changeme123 default guest login
test test123 testing testing123 user user123 root toor 111111 000000 121212 654321 666666 696969 123123 112233 11111111 00000000 88888888 987654321
1q2w3e4r 1q2w3e4r5t 1qaz2wsx qazwsx zaq12wsx asdfgh asdfghjk asdfghjkl zxcvbn zxcvbnm qweasd q1w2e3r4 123qwe qwe123 1qazxsw2 passpass pass1234
mustang access flower hello hello123 freedom whatever starwars pokemon computer internet cheese cookie chocolate banana orange yankees cowboys
liverpool arsenal chelsea barcelona madrid ferrari porsche mercedes corvette matrix killer biteme fuckyou fuckyou1 lovely loveme love123 iloveu
baby123 angel angels sweet sexy bailey maggie buddy tigger sophie lucky fuckoff abc12345 aaaaaaaa aaaaaa a1b2c3d4 letmein1 letmein123 trustno1
rdcloude rd-cloude rdcloud cloud cloud123 cloudcloud superuser sysadmin qwertyui qwerty12 qwerty1 zaq1xsw2 pa55word pa$$word password! password@ password#
mynoob 7777777 1111111 11223344 12341234 1234abcd 12qwaszx 1g2w3e4r q1w2e3 123abc 123654 159753 147258369 135790 24682468 5555555 555555 55555555`.split(/\s+/))

const isSequence = (s) => {
  if (s.length < 6) return false
  const c = [...s].map((x) => x.charCodeAt(0))
  return c.every((v, i) => i === 0 || v - c[i - 1] === 1) || c.every((v, i) => i === 0 || v - c[i - 1] === -1)
}

/**
 * Password policy. Hard errors in every mode: type, length (min RD_PASSWORD_MIN, max 256).
 * Weakness findings (denylist, trivial patterns, contains the email) are errors when the policy is "strict"
 * (default when NODE_ENV=production or RD_PASSWORD_POLICY=strict) and non-blocking `warnings` otherwise, so the
 * long-standing "password123" test/dev fixtures keep working. Returns { errors, warnings }.
 */
export function checkPassword(st, pw, { email = '' } = {}) {
  const errors = []
  const weak = []
  if (typeof pw !== 'string') return { errors: ['Password must be a string'], warnings: [] }
  if (pw.length < st.cfg.passwordMin) errors.push(`Password must be at least ${st.cfg.passwordMin} characters`)
  else if (pw.length > 256) errors.push('Password must be at most 256 characters')
  if (!errors.length) {
    const lower = pw.toLowerCase()
    const local = email.split('@')[0].toLowerCase()
    if (COMMON.has(lower) || COMMON.has(lower.replace(/[\d!@#$%^&*._-]+$/, ''))) weak.push('This password is on the list of commonly used passwords')
    if (new Set(pw).size < 4) weak.push('This password has too few distinct characters')
    if (isSequence(lower)) weak.push('This password is a simple character sequence')
    if (email && (lower === email.toLowerCase() || (local.length >= 4 && lower.includes(local)))) weak.push('This password contains your email address')
  }
  if (st.cfg.passwordPolicy === 'strict') return { errors: [...errors, ...weak], warnings: [] }
  return { errors, warnings: weak }
}

/* ======================================================================= throttling + rate gates */

const acctKey = (email, ip) => `a:${email}|${ip}`
const ipKey = (ip) => `i:${ip}`

function lockMs(st, fails, free) {
  if (fails <= free) return 0
  return Math.min(st.cfg.lockMaxMs, st.cfg.lockBaseMs * 2 ** Math.min(30, fails - free - 1))
}
function tooMany(secs, msg = 'Too many failed attempts') {
  const e = new HttpError(429, `${msg}. Try again in ${secs}s.`)
  e.headers = { 'retry-after': String(secs) }
  return e
}
/** Throw 429 (+Retry-After) if any of the keys is currently locked. Locked requests do not extend the lock. */
function assertNotLocked(st, keys) {
  const now = st.now()
  let wait = 0
  for (const k of keys) {
    const e = st.throttle.get(k)
    if (e && e.lockedUntil > now) wait = Math.max(wait, e.lockedUntil - now)
  }
  if (wait > 0) throw tooMany(Math.ceil(wait / 1000))
}
function noteFailure(st, key, free) {
  const now = st.now()
  let e = st.throttle.get(key)
  if (!e || (e.lockedUntil <= now && now - e.last > 3_600_000)) e = { fails: 0, lockedUntil: 0, last: now }
  e.fails++
  e.last = now
  const ms = lockMs(st, e.fails, free)
  if (ms) e.lockedUntil = now + ms
  st.throttle.delete(key)
  st.throttle.set(key, e)
  if (st.throttle.size > 50_000) st.throttle.delete(st.throttle.keys().next().value)
  return e
}
function failCredential(st, email, ip) {
  const a = noteFailure(st, acctKey(email, ip), st.cfg.loginFree)
  noteFailure(st, ipKey(ip), st.cfg.ipFree)
  return a
}
// Second-factor guesses are also counted per ACCOUNT across all addresses, so rotating IPs cannot multiply the 10^6 code space.
const userKey = (id) => `t:${id}`
function failSecondFactor(st, user, ip) {
  failCredential(st, user.email, ip)
  noteFailure(st, userKey(user.id), st.cfg.tfaFree)
}
const factorKeys = (user, ip) => [acctKey(user.email, ip), ipKey(ip), userKey(user.id)]

/**
 * Password checks are slow (scrypt) and asynchronous, so a burst of parallel guesses would all pass the lock test before the
 * first failure is recorded. Cap the attempts in flight per account+IP (5) and per IP (20); the rest get 429 without being tried.
 */
function beginAttempt(st, limits) {
  const taken = []
  for (const [k, max] of limits) {
    const n = st.inflight.get(k) ?? 0
    if (n >= max) {
      endAttempt(st, taken)
      throw tooMany(1, 'Too many simultaneous sign-in attempts')
    }
    st.inflight.set(k, n + 1)
    taken.push(k)
  }
  return taken
}
function endAttempt(st, taken) {
  for (const k of taken) {
    const n = (st.inflight.get(k) ?? 1) - 1
    if (n > 0) st.inflight.set(k, n)
    else st.inflight.delete(k)
  }
}
function clearAccountThrottle(st, email, ip) {
  st.throttle.delete(acctKey(email, ip))
}
function clearAllForEmail(st, email) {
  for (const k of st.throttle.keys()) if (k.startsWith(`a:${email}|`)) st.throttle.delete(k)
}

/** Fixed-window counter. Returns true when the call is within the limit. */
export function rateGate(st, key, max, windowMs) {
  const now = st.now()
  const g = st.gates.get(key)
  if (!g || now - g.start > windowMs) {
    st.gates.set(key, { start: now, n: 1 })
    if (st.gates.size > 50_000) st.gates.delete(st.gates.keys().next().value)
    return true
  }
  return ++g.n <= max
}

/**
 * Re-authenticate for a sensitive action. Wrong password -> 403 (not 401: the console treats 401 as "session expired")
 * and counts toward the same per-account+IP / per-IP lockout as login.
 */
export async function confirmPassword(ctx, req, user, password) {
  const st = initAuth(ctx)
  if (typeof password !== 'string' || !password || password.length > 1024) throw new HttpError(400, 'Password confirmation required')
  const ip = clientIp(req)
  assertNotLocked(st, [acctKey(user.email, ip), ipKey(ip)])
  const held = beginAttempt(st, [[acctKey(user.email, ip), 5], [ipKey(ip), 20]])
  let ok
  try { ok = await verifyPassword(password, user.password) } finally { endAttempt(st, held) }
  if (!ok) {
    failCredential(st, user.email, ip)
    throw new HttpError(403, 'Incorrect password')
  }
  clearAccountThrottle(st, user.email, ip)
}

/** Require a valid second factor (TOTP or recovery code) when the user has 2FA enabled; no-op otherwise. Throws 403. */
export function confirmSecondFactor(ctx, req, user, code) {
  const st = initAuth(ctx)
  if (!user.totp?.enabled) return
  const ip = clientIp(req)
  assertNotLocked(st, factorKeys(user, ip))
  if (!consumeSecondFactor(st, user.id, String(code ?? ''))) {
    failSecondFactor(st, user, ip)
    throw new HttpError(403, 'Invalid verification code')
  }
  st.throttle.delete(userKey(user.id))
}

/* ======================================================================= TOTP (RFC 6238) + HOTP (RFC 4226) */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export function base32Encode(buf) {
  let bits = 0
  let val = 0
  let out = ''
  for (const byte of buf) {
    val = (val << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31]
      bits -= 5
    }
    val &= (1 << bits) - 1
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31]
  return out
}
export function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let val = 0
  const out = []
  for (const ch of clean) {
    const i = B32.indexOf(ch)
    if (i < 0) throw new Error('Invalid base32')
    val = (val << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255)
      bits -= 8
    }
    val &= (1 << bits) - 1
  }
  return Buffer.from(out)
}

/** RFC 4226 HOTP. `secret` is a Buffer; algorithm sha1 | sha256 | sha512. */
export function hotp(secret, counter, { digits = 6, algorithm = 'sha1' } = {}) {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const mac = crypto.createHmac(algorithm, secret).update(msg).digest()
  const o = mac[mac.length - 1] & 0xf
  const bin = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3]
  return String(bin % 10 ** digits).padStart(digits, '0')
}
export const totpCounter = (timeMs, period = 30) => Math.floor(timeMs / 1000 / period)
/** RFC 6238 TOTP for a point in time (ms since epoch). */
export function totp(secret, timeMs = Date.now(), { period = 30, ...opts } = {}) {
  return hotp(secret, totpCounter(timeMs, period), opts)
}
/**
 * Check a code against the window [-window, +window] steps (clock skew). Every candidate is compared in constant time.
 * `minStep` rejects replays (pass the last accepted step). Returns the matching step or null.
 */
export function verifyTotp(secret, code, { timeMs = Date.now(), window = 1, minStep = -1, period = 30, digits = 6, algorithm = 'sha1' } = {}) {
  const c = String(code ?? '').replace(/\s/g, '')
  if (c.length !== digits || !/^\d+$/.test(c)) return null
  const now = totpCounter(timeMs, period)
  let hit = null
  for (let d = -window; d <= window; d++) {
    const step = now + d
    if (step < 0) continue
    const ok = crypto.timingSafeEqual(Buffer.from(hotp(secret, step, { digits, algorithm })), Buffer.from(c))
    if (ok && step > minStep && hit === null) hit = step
  }
  return hit
}
export function otpauthUri({ secret, account, issuer = 'RD Cloude', algorithm = 'SHA1', digits = 6, period = 30 }) {
  const e = encodeURIComponent
  return `otpauth://totp/${e(issuer)}:${e(account)}?secret=${secret}&issuer=${e(issuer)}&algorithm=${algorithm}&digits=${digits}&period=${period}`
}

const RC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789' // no look-alikes (i l o 0 1)
export function generateRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    let s = ''
    for (let i = 0; i < 10; i++) s += RC_ALPHABET[crypto.randomInt(RC_ALPHABET.length)]
    return `${s.slice(0, 5)}-${s.slice(5)}`
  })
}
const normRecovery = (c) => String(c ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const recoveryHash = (st, code) => crypto.createHmac('sha256', deriveKey(st.ctx, 'recovery')).update(normRecovery(code)).digest('hex')

/**
 * Atomically verify + consume a second factor for `userId` (synchronous, so concurrent requests cannot replay a code).
 * `code` is a 6-digit TOTP code or a recovery code. Returns { kind, remaining } or null.
 */
function consumeSecondFactor(st, userId, code) {
  const user = st.db.get('users', userId)
  const t = user?.totp
  if (!t?.enabled) return null
  const raw = String(code ?? '').trim()
  if (raw.length > 64) return null
  if (/^\d{3}\s?\d{3}$/.test(raw)) {
    let secret
    try { secret = base32Decode(unseal(deriveKey(st.ctx, 'totp'), t.secret, user.id)) } catch { return null }
    const step = verifyTotp(secret, raw, { timeMs: st.now(), minStep: t.lastStep ?? -1 })
    if (step === null) return null
    st.db.update('users', user.id, { totp: { ...t, lastStep: step } })
    return { kind: 'totp', remaining: (user.recoveryCodes ?? []).filter((c) => !c.usedAt).length }
  }
  if (normRecovery(raw).length !== 10) return null
  const h = recoveryHash(st, raw)
  const codes = user.recoveryCodes ?? []
  let idx = -1
  codes.forEach((c, i) => { if (safeEqual(c.hash, h) && !c.usedAt && idx < 0) idx = i })
  if (idx < 0) return null
  const next = codes.map((c, i) => (i === idx ? { ...c, usedAt: new Date(st.now()).toISOString() } : c))
  st.db.update('users', user.id, { recoveryCodes: next })
  return { kind: 'recovery', remaining: next.filter((c) => !c.usedAt).length }
}

/* ======================================================================= sessions */

const iso = (ms) => new Date(ms).toISOString()

export function createSession(st, user, req, { mfa = false } = {}) {
  const { db } = st
  const now = st.now()
  const token = crypto.randomBytes(32).toString('hex')
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 256)
  const ip = clientIp(req)
  const row = tx(db, () => {
    // drop this user's dead sessions, then evict the least recently used ones beyond the cap
    const mine = many(db, 'sessions', 'userId', user.id)
    for (const s of mine) if (Date.parse(s.expiresAt) <= now || now - Date.parse(s.lastSeenAt ?? s.createdAt) > st.cfg.sessionIdleMs) db.remove('sessions', s.id)
    const live = many(db, 'sessions', 'userId', user.id).sort((a, b) => Date.parse(a.lastSeenAt ?? a.createdAt) - Date.parse(b.lastSeenAt ?? b.createdAt))
    for (const s of live.slice(0, Math.max(0, live.length - st.cfg.maxSessions + 1))) db.remove('sessions', s.id)
    return db.insert('sessions', {
      hash: sha(token), userId: user.id, expiresAt: iso(now + st.cfg.sessionMaxMs), lastSeenAt: iso(now),
      ip, lastIp: ip, userAgent: ua, device: deviceLabel(ua), mfa: !!mfa,
    })
  })
  return { token, session: row }
}

export function revokeSessions(db, userId, exceptId = null) {
  return tx(db, () => {
    let n = 0
    for (const s of many(db, 'sessions', 'userId', userId)) if (s.id !== exceptId && db.remove('sessions', s.id)) n++
    return n
  })
}

const sessionView = (s, currentId) => ({
  id: s.id, device: s.device ?? 'Unknown device', ip: s.ip ?? null, lastIp: s.lastIp ?? s.ip ?? null,
  createdAt: s.createdAt, lastSeenAt: s.lastSeenAt ?? s.createdAt, expiresAt: s.expiresAt, mfa: !!s.mfa, current: s.id === currentId,
})

/* ======================================================================= API key scopes */

export const SERVICES = ['ai', 'storage', 'compute', 'drive', 'db', 'billing', 'orgs', 'audit', 'account']
export const SCOPE_NAMES = ['read', 'write', ...SERVICES, ...SERVICES.map((s) => `${s}:read`)]

/** Path prefix -> service. Longest prefix wins; unknown paths fall back to the global read/write scopes. */
export const SCOPE_RULES = [
  ['/api/projects', 'ai'], ['/api/conversations', 'ai'], ['/api/artifacts', 'ai'], ['/api/ai', 'ai'],
  ['/api/buckets', 'storage'], ['/api/storage', 'storage'],
  ['/api/compute', 'compute'], ['/api/net', 'compute'], ['/api/functions', 'compute'],
  ['/api/drive', 'drive'],
  ['/api/db', 'db'], ['/api/sql', 'db'],
  ['/api/billing', 'billing'], ['/api/plans', 'billing'], ['/api/quotas', 'billing'], ['/api/notifications', 'billing'],
  ['/api/orgs', 'orgs'], ['/api/audit', 'audit'],
  ['/api/keys', 'account'], ['/api/auth', 'account'], ['/api/account', 'account'], ['/api/sessions', 'account'],
]

/** Scope needed for a request: { service|null, level: 'read'|'write' }, or null when any valid key may call it. */
export function requiredScope(method, pathname, extraRules = []) {
  const m = String(method).toUpperCase()
  const level = m === 'GET' || m === 'HEAD' || m === 'OPTIONS' ? 'read' : 'write'
  if (pathname === '/api/me' && level === 'read') return null
  if (!pathname.startsWith('/api/')) return null // static files, /s/ share links: never key-scoped
  let best = null
  for (const [prefix, service] of [...SCOPE_RULES, ...extraRules]) {
    if ((pathname === prefix || pathname.startsWith(prefix + '/')) && (!best || prefix.length > best[0].length)) best = [prefix, service]
  }
  return { service: best ? best[1] : null, level }
}

/** Does a key with scope list `S` (null = full access) permit `need`? "write" implies "read"; `account` is never implied by the globals. */
export function scopeAllows(S, need) {
  if (!need || !S) return true
  const { service, level } = need
  if (service === 'account') return S.includes('account') || (level === 'read' && S.includes('account:read'))
  if (S.includes('write')) return true
  if (level === 'read' && S.includes('read')) return true
  if (service) return S.includes(service) || (level === 'read' && S.includes(`${service}:read`))
  return false
}
/** True when scope list S grants everything that scope `s` would (used to stop a key minting a broader key). */
export function scopeCovers(S, s) {
  if (!S) return true
  if (s === 'write') return S.includes('write')
  if (s === 'read') return S.includes('read') || S.includes('write')
  const [svc, lvl] = s.split(':')
  return scopeAllows(S, { service: svc, level: lvl === 'read' ? 'read' : 'write' })
}

export function normalizeScopes(input) {
  if (input === undefined || input === null) return null
  if (!Array.isArray(input)) throw new HttpError(400, 'scopes must be an array of strings')
  if (!input.length) throw new HttpError(400, 'scopes must not be empty (omit it for full access)')
  if (input.length > 40) throw new HttpError(400, 'Too many scopes')
  const out = [...new Set(input.map((s) => {
    if (typeof s !== 'string') throw new HttpError(400, 'scopes must be an array of strings')
    return s.trim().toLowerCase()
  }))]
  for (const s of out) if (!SCOPE_NAMES.includes(s)) throw new HttpError(400, `Unknown scope: ${s.slice(0, 40)}`)
  return out.sort()
}

/* ======================================================================= authenticate (sync, called by src/app.js) */

export function authenticate(db, req) {
  const st = authState(db)
  const h = req.headers.authorization ?? ''
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : null
  if (!token || token.length > 256) return null
  const now = st.now()
  const hash = sha(token)
  if (token.startsWith('rdk_')) {
    const key = one(db, 'apiKeys', 'hash', hash)
    if (!key || key.revoked || (key.expiresAt && Date.parse(key.expiresAt) <= now)) return null
    const user = db.get('users', key.userId)
    if (!user) return null
    const ip = clientIp(req)
    if (!key.lastUsedAt || now - Date.parse(key.lastUsedAt) > 10_000 || key.lastUsedIp !== ip) db.update('apiKeys', key.id, { lastUsedAt: iso(now), lastUsedIp: ip })
    return { user, via: 'apiKey', keyId: key.id, scopes: key.scopes ?? null }
  }
  const s = one(db, 'sessions', 'hash', hash)
  if (!s) return null
  const last = Date.parse(s.lastSeenAt ?? s.createdAt)
  if (Date.parse(s.expiresAt) <= now || now - last > st.cfg.sessionIdleMs) {
    db.remove('sessions', s.id)
    return null
  }
  const user = db.get('users', s.userId)
  if (!user) return null
  const ip = clientIp(req)
  if (now - last > 60_000 || s.lastIp !== ip) db.update('sessions', s.id, { lastSeenAt: iso(now), lastIp: ip })
  return { user, via: 'session', sessionId: s.id, mfa: !!s.mfa, scopes: null }
}

/** Housekeeping: expired sessions, tokens, challenges, throttle state. Cheap; called periodically by security.js. */
export function sweep(db) {
  const st = authState(db)
  const now = st.now()
  db.removeWhere('sessions', (s) => Date.parse(s.expiresAt) <= now || now - Date.parse(s.lastSeenAt ?? s.createdAt) > st.cfg.sessionIdleMs)
  db.removeWhere('auth_tokens', (t) => Date.parse(t.expiresAt) <= now)
  for (const [k, c] of st.challenges) if (c.expiresAt <= now) st.challenges.delete(k)
  for (const [k, e] of st.throttle) if (e.lockedUntil <= now && now - e.last > 3_600_000) st.throttle.delete(k)
  for (const [k, g] of st.gates) if (now - g.start > 86_400_000) st.gates.delete(k)
}

/* ======================================================================= mailer + one-time tokens */

/**
 * Default mailer. `ctx.mailer.send({ to, subject, text, tags? })` returns a promise. There is no SMTP transport in this
 * zero-dependency build: assign your own object with the same `send` to `ctx.mailer` (before requests are served) to
 * deliver real mail. Without a transport mail is dropped, or kept in a 200-entry in-memory outbox when RD_DEV_OUTBOX=1
 * (readable via GET /api/dev/outbox from loopback only - development only!).
 */
function makeMailer(st) {
  return {
    transport: 'dev-outbox',
    async send(msg) {
      if (!msg || typeof msg.to !== 'string' || typeof msg.subject !== 'string' || typeof msg.text !== 'string') throw new Error('mail needs to, subject and text')
      if (process.env.RD_DEV_OUTBOX === '1') {
        st.outbox.push({ id: crypto.randomUUID(), at: iso(st.now()), to: msg.to, subject: msg.subject.slice(0, 200), text: msg.text.slice(0, 10_000), tags: msg.tags ?? {} })
        if (st.outbox.length > 200) st.outbox.shift()
      } else if (!st.mailWarned) {
        st.mailWarned = true
        console.warn('[rd-cloude] no mail transport configured: outgoing email is discarded (set ctx.mailer, or RD_DEV_OUTBOX=1 for development)')
      }
      return { queued: true }
    },
  }
}
export const devOutbox = (db) => authState(db).outbox

/** Absolute URL when RD_PUBLIC_URL is set (never derived from the Host header: that enables reset-link poisoning). */
export const appUrl = (p) => `${(process.env.RD_PUBLIC_URL ?? '').replace(/\/+$/, '')}${p}`

export function sendMail(st, msg) {
  Promise.resolve()
    .then(() => st.ctx.mailer.send(msg))
    .catch((e) => console.error('[rd-cloude] mail send failed:', e.message))
}

function issueToken(st, userId, kind, ttlMs, extra = {}) {
  const raw = b64u(crypto.randomBytes(32))
  tx(st.db, () => {
    for (const t of many(st.db, 'auth_tokens', 'userId', userId)) if (t.kind === kind) st.db.remove('auth_tokens', t.id)
    st.db.insert('auth_tokens', { userId, kind, hash: sha(raw), expiresAt: iso(st.now() + ttlMs), ...extra })
  })
  return raw
}
function findToken(st, kind, raw) {
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 200) return null
  const h = sha(raw)
  const t = one(st.db, 'auth_tokens', 'hash', h)
  return t && t.kind === kind && Date.parse(t.expiresAt) > st.now() ? t : null
}

function sendVerification(st, user) {
  const token = issueToken(st, user.id, 'verify', 24 * 36e5)
  sendMail(st, {
    to: user.email, subject: 'Verify your RD Cloude email address', tags: { kind: 'verify-email' },
    text: `Hi ${user.name},\n\nConfirm your email address to finish setting up RD Cloude:\n${appUrl(`/auth/account#mode=verify&token=${token}`)}\n\nVerification token: ${token}\nThis link expires in 24 hours. If you did not create an account, ignore this message.\n`,
  })
}

/* ======================================================================= views */

export const publicUser = (u) => ({
  id: u.id, email: u.email, name: u.name, createdAt: u.createdAt, emailVerified: !!u.emailVerified, twoFactorEnabled: !!u.totp?.enabled,
})

const keyView = ({ hash, ...k }) => ({ ...k, scopes: k.scopes ?? null, expiresAt: k.expiresAt ?? null, lastUsedAt: k.lastUsedAt ?? null, lastUsedIp: k.lastUsedIp ?? null })

/* ======================================================================= routes */

const DOCS = {
  'POST /api/auth/register': 'Create an account and sign in',
  'POST /api/auth/login': 'Sign in; answers 401 {twoFactorRequired, challenge} when a second factor is needed (or send `code` with the password)',
  'POST /api/auth/login/2fa': 'Second step of sign-in: authenticator code or recovery code',
  'POST /api/auth/logout': 'Sign out (revokes the calling session)',
  'GET /api/me': 'Current user, authentication method and key scopes',
  'PATCH /api/me': 'Update the display name',
  'GET /api/auth/sessions': 'List your sessions (device, IP, created, last seen)',
  'POST /api/auth/sessions/revoke-others': 'Sign out every other session (session only)',
  'DELETE /api/auth/sessions/:id': 'Revoke one session (session only)',
  'POST /api/auth/password/change': 'Change the password; replaces all sessions and returns a new token (session only)',
  'POST /api/auth/password/forgot': 'Request a password reset email; always answers 202',
  'POST /api/auth/password/reset': 'Set a new password with a single-use reset token',
  'POST /api/auth/verify-email': 'Confirm an email address with a token',
  'POST /api/auth/verify-email/resend': 'Resend the verification email (1 per minute)',
  'GET /api/auth/2fa': 'Two-factor status',
  'POST /api/auth/2fa/setup': 'Start TOTP enrolment: returns the secret and otpauth:// URI (session only, needs password)',
  'POST /api/auth/2fa/enable': 'Confirm enrolment with a code; returns 10 recovery codes once (session only)',
  'POST /api/auth/2fa/disable': 'Turn off two-factor (session only, needs password and a code)',
  'POST /api/auth/2fa/recovery-codes': 'Regenerate recovery codes (session only, needs password and a code)',
  'GET /api/keys': 'List API keys (no secrets)',
  'POST /api/keys': 'Create an API key: optional scopes and expiry; the secret is shown once',
  'DELETE /api/keys/:id': 'Revoke an API key',
}

export function authRoutes(router, db, ctxArg) {
  const r = withDocs(router, DOCS)
  const st0 = ctxArg ? initAuth(ctxArg) : authState(db)
  dummy().catch(() => {}) // warm the constant-time dummy hash
  const S = (ctx) => (ctx ? initAuth(ctx) : st0)
  const sessionOnly = (auth) => {
    if (auth?.via !== 'session') throw new HttpError(403, 'This action requires an interactive session (sign in with your password)')
  }
  const audit = (st, rc, userId, action, resource, meta) => emitAudit(st.ctx, rc.req, rc.requestId, userId, action, resource, meta)
  const fresh = (id) => db.get('users', id)

  /* ------------------------------------------------------------- register / login / logout */
  r.post('/api/auth/register', async (rc) => {
    const st = S(rc.ctx)
    const b = bodyObj(rc.body)
    required(b, 'email', 'password')
    const email = normEmail(b.email)
    if (typeof b.password !== 'string') throw new HttpError(400, 'Password must be a string')
    const name = b.name === undefined || b.name === null || b.name === '' ? email.split('@')[0] : str(b.name, 'name', { max: 80 })
    const ip = clientIp(rc.req)
    if (!rateGate(st, `register:${ip}`, st.cfg.registerPerHour, 3_600_000)) throw tooMany(600, 'Too many sign-ups from this address')
    const pol = checkPassword(st, b.password, { email })
    if (pol.errors.length) throw new HttpError(400, pol.errors[0])
    if (one(db, 'users', 'email', email)) throw new HttpError(409, 'Email already registered')
    const hashed = await hashPassword(b.password)
    if (one(db, 'users', 'email', email)) throw new HttpError(409, 'Email already registered') // lost a race while hashing
    const { user, token } = tx(db, () => {
      const u = db.insert('users', { email, name, password: hashed, emailVerified: false, passwordChangedAt: iso(st.now()) })
      return { user: u, token: createSession(st, u, rc.req).token }
    })
    noteDevice(st, rc, user)
    audit(st, rc, user.id, 'auth.register', `user:${user.id}`, { passwordWarnings: pol.warnings.length || undefined })
    sendVerification(st, user)
    return [201, { user: publicUser(user), token, ...(pol.warnings.length ? { warnings: pol.warnings } : {}) }]
  }, { public: true, meta: { summary: 'Create an account and sign in' } })

  r.post('/api/auth/login', async (rc) => {
    const st = S(rc.ctx)
    const b = bodyObj(rc.body)
    required(b, 'email', 'password')
    if (typeof b.email !== 'string' || typeof b.password !== 'string' || b.password.length > 1024) throw new HttpError(401, 'Invalid credentials')
    const email = b.email.toLowerCase().trim().slice(0, 254)
    const ip = clientIp(rc.req)
    assertNotLocked(st, [acctKey(email, ip), ipKey(ip)])
    const held = beginAttempt(st, [[acctKey(email, ip), 5], [ipKey(ip), 20]])
    let user
    let ok
    try {
      user = one(db, 'users', 'email', email)
      // Always burn one scrypt so unknown accounts and wrong passwords take the same time.
      ok = await verifyPassword(b.password, user ? user.password : await dummy())
    } finally { endAttempt(st, held) }
    if (!user || !ok) {
      const e = failCredential(st, email, ip)
      if (user && (e.fails === 1 || e.fails === st.cfg.loginFree || e.fails === st.cfg.loginFree + 1 || e.fails % 10 === 0)) {
        audit(st, rc, user.id, 'auth.login.failed', `user:${user.id}`, { failures: e.fails, locked: e.lockedUntil > st.now() || undefined })
      }
      throw new HttpError(401, 'Invalid credentials')
    }
    if (user.totp?.enabled) {
      if (b.code !== undefined && b.code !== null && b.code !== '') {
        // one-shot variant for API clients: password + code in a single request
        if (typeof b.code !== 'string' && typeof b.code !== 'number') throw new HttpError(401, 'Invalid credentials')
        assertNotLocked(st, factorKeys(user, ip))
        const f = consumeSecondFactor(st, user.id, String(b.code))
        if (!f) {
          failSecondFactor(st, user, ip)
          audit(st, rc, user.id, 'auth.2fa.failed', `user:${user.id}`, {})
          throw new HttpError(401, 'Invalid credentials or verification code')
        }
        clearAccountThrottle(st, email, ip)
        st.throttle.delete(userKey(user.id))
        return finishLogin(st, rc, user, f)
      }
      const raw = b64u(crypto.randomBytes(24))
      st.challenges.set(sha(raw), { userId: user.id, email, ip, attempts: 0, expiresAt: st.now() + 5 * 60_000 })
      if (st.challenges.size > 5000) st.challenges.delete(st.challenges.keys().next().value)
      // 401 on purpose: credentials are not yet sufficient, and an unmodified console shows `error` instead of misreading a 200 as a session.
      return [401, {
        error: 'Two-factor authentication is on for this account. Finish signing in at /auth/account#mode=signin',
        twoFactorRequired: true, challenge: raw, expiresIn: 300, methods: ['totp', 'recovery'],
      }]
    }
    clearAccountThrottle(st, email, ip)
    return finishLogin(st, rc, user, null)
  }, { public: true, meta: { summary: 'Sign in (returns a challenge when 2FA is enabled)' } })

  /** Remember (ip, device) pairs per user; returns true (and mails the owner) when a returning user signs in from a new one. */
  function noteDevice(st, rc, user) {
    const ua = String(rc.req.headers['user-agent'] ?? '').slice(0, 256)
    const device = deviceLabel(ua)
    const ip = clientIp(rc.req)
    const fp = sha(`${ip}|${device}`).slice(0, 16)
    const known = db.get('users', user.id)?.knownDevices ?? []
    if (known.includes(fp)) return false
    db.update('users', user.id, { knownDevices: [...known, fp].slice(-25) })
    if (!known.length) return false // first device: the sign-up itself
    sendMail(st, { to: user.email, subject: 'New sign-in to your RD Cloude account', tags: { kind: 'new-login' },
      text: `Your account was just signed in to from a device or address we have not seen before.\n\nDevice: ${device}\nIP address: ${ip}\nTime: ${iso(st.now())}\n\nIf this was you, no action is needed. If not, change your password and sign out other sessions:\n${appUrl('/#security/password')}\n` })
    return true
  }

  function finishLogin(st, rc, user, factor) {
    const { token } = createSession(st, user, rc.req, { mfa: !!factor })
    const newDevice = noteDevice(st, rc, user)
    audit(st, rc, user.id, 'auth.login', `user:${user.id}`, { mfa: factor?.kind, newDevice: newDevice || undefined })
    return { user: publicUser(user), token, ...(factor?.kind === 'recovery' ? { usedRecoveryCode: true, recoveryCodesRemaining: factor.remaining } : {}) }
  }

  r.post('/api/auth/login/2fa', (rc) => {
    const st = S(rc.ctx)
    const b = bodyObj(rc.body)
    if (typeof b.challenge !== 'string' || (typeof b.code !== 'string' && typeof b.code !== 'number')) throw new HttpError(400, 'challenge and code are required')
    const key = sha(b.challenge.slice(0, 200))
    const ch = st.challenges.get(key)
    if (!ch || ch.expiresAt <= st.now()) {
      st.challenges.delete(key)
      throw new HttpError(401, 'Sign-in expired, start again')
    }
    const ip = clientIp(rc.req)
    const user = fresh(ch.userId)
    assertNotLocked(st, user ? factorKeys(user, ip) : [acctKey(ch.email, ip), ipKey(ip)])
    const f = user && consumeSecondFactor(st, user.id, String(b.code))
    if (!f) {
      ch.attempts++
      if (user) failSecondFactor(st, user, ip)
      else failCredential(st, ch.email, ip)
      if (user) audit(st, rc, user.id, 'auth.2fa.failed', `user:${user.id}`, { attempts: ch.attempts })
      if (ch.attempts >= 5 || !user) st.challenges.delete(key)
      throw new HttpError(401, 'Invalid verification code')
    }
    st.challenges.delete(key)
    clearAccountThrottle(st, ch.email, ip)
    st.throttle.delete(userKey(user.id))
    return finishLogin(st, rc, user, f)
  }, { public: true, meta: { summary: 'Second step of sign-in: TOTP or recovery code' } })

  r.post('/api/auth/logout', (rc) => {
    const st = S(rc.ctx)
    const token = (rc.req.headers.authorization ?? '').slice(7).trim().slice(0, 256)
    const s = rc.auth.via === 'session' ? one(db, 'sessions', 'hash', sha(token)) : null
    if (s && s.userId === rc.user.id && db.remove('sessions', s.id)) audit(st, rc, rc.user.id, 'auth.logout', `user:${rc.user.id}`, {})
    return { ok: true }
  })

  r.get('/api/me', ({ user, auth }) => ({ user: publicUser(user), via: auth.via, scopes: auth.scopes ?? null }))
  r.patch('/api/me', (rc) => {
    const st = S(rc.ctx)
    const b = bodyObj(rc.body)
    const name = str(b.name, 'name', { max: 80 })
    const u = db.update('users', rc.user.id, { name })
    audit(st, rc, u.id, 'account.profile.update', `user:${u.id}`, {})
    return { user: publicUser(u) }
  })

  /* ------------------------------------------------------------- sessions */
  r.get('/api/auth/sessions', ({ user, auth }) => ({
    sessions: many(db, 'sessions', 'userId', user.id)
      .sort((a, b) => Date.parse(b.lastSeenAt ?? b.createdAt) - Date.parse(a.lastSeenAt ?? a.createdAt))
      .map((s) => sessionView(s, auth.sessionId)),
  }))
  r.post('/api/auth/sessions/revoke-others', (rc) => {
    const st = S(rc.ctx)
    sessionOnly(rc.auth)
    const n = revokeSessions(db, rc.user.id, rc.auth.sessionId)
    audit(st, rc, rc.user.id, 'auth.session.revoke_others', `user:${rc.user.id}`, { revoked: n })
    return { ok: true, revoked: n }
  })
  r.delete('/api/auth/sessions/:id', (rc) => {
    const st = S(rc.ctx)
    sessionOnly(rc.auth)
    const s = db.get('sessions', rc.params.id)
    if (!s || s.userId !== rc.user.id) throw new HttpError(404, 'Session not found')
    db.remove('sessions', s.id)
    audit(st, rc, rc.user.id, 'auth.session.revoke', `session:${s.id}`, { current: s.id === rc.auth.sessionId || undefined })
    return { ok: true }
  })

  /* ------------------------------------------------------------- password change / reset */
  r.post('/api/auth/password/change', async (rc) => {
    const st = S(rc.ctx)
    sessionOnly(rc.auth)
    const b = bodyObj(rc.body)
    required(b, 'currentPassword', 'newPassword')
    if (typeof b.newPassword !== 'string') throw new HttpError(400, 'newPassword must be a string')
    await confirmPassword(st.ctx, rc.req, rc.user, b.currentPassword)
    if (b.newPassword === b.currentPassword) throw new HttpError(400, 'New password must differ from the current one')
    const pol = checkPassword(st, b.newPassword, { email: rc.user.email })
    if (pol.errors.length) throw new HttpError(400, pol.errors[0])
    const hashed = await hashPassword(b.newPassword)
    // rotation: every session (this one included) is replaced by a single fresh one; other devices are signed out
    const { u, token } = tx(db, () => {
      const updated = db.update('users', rc.user.id, { password: hashed, passwordChangedAt: iso(st.now()) })
      revokeSessions(db, updated.id)
      return { u: updated, token: createSession(st, updated, rc.req, { mfa: rc.auth.mfa }).token }
    })
    audit(st, rc, u.id, 'auth.password.change', `user:${u.id}`, {})
    sendMail(st, { to: u.email, subject: 'Your RD Cloude password was changed', tags: { kind: 'password-changed' },
      text: `Your RD Cloude password was just changed and all other sessions were signed out.\nIf this was not you, reset your password immediately: ${appUrl('/auth/account#mode=forgot')}\n` })
    return { ok: true, token, user: publicUser(u), ...(pol.warnings.length ? { warnings: pol.warnings } : {}) }
  })

  r.post('/api/auth/password/forgot', (rc) => {
    const st = S(rc.ctx)
    const b = bodyObj(rc.body)
    const email = normEmail(b.email)
    const ip = clientIp(rc.req)
    if (!rateGate(st, `forgot:ip:${ip}`, 20, 3_600_000)) throw tooMany(600, 'Too many reset requests')
    const quiet = !rateGate(st, `forgot:email:${email}`, 5, 3_600_000)
    const snap = { req: { headers: rc.req.headers, socket: { remoteAddress: rc.req.socket?.remoteAddress } }, requestId: rc.requestId }
    // Same answer whether or not the account exists; the work happens after the response is queued.
    setImmediate(() => {
      try {
        const user = one(db, 'users', 'email', email)
        if (!user || quiet) return
        const token = issueToken(st, user.id, 'reset', 30 * 60_000)
        audit(st, snap, user.id, 'auth.password.reset_requested', `user:${user.id}`, {})
        sendMail(st, { to: user.email, subject: 'Reset your RD Cloude password', tags: { kind: 'password-reset' },
          text: `Someone (hopefully you) asked to reset your RD Cloude password:\n${appUrl(`/auth/account#mode=reset&token=${token}`)}\n\nReset token: ${token}\nThis link works once and expires in 30 minutes. If you did not ask for it, ignore this message; your password is unchanged.\n` })
      } catch (e) { console.error('[rd-cloude] reset request failed:', e.message) }
    })
    return [202, { ok: true, message: 'If an account exists for that address, a reset link has been sent.' }]
  }, { public: true, meta: { summary: 'Request a password reset email (always answers the same)' } })

  r.post('/api/auth/password/reset', async (rc) => {
    const st = S(rc.ctx)
    const b = bodyObj(rc.body)
    required(b, 'token', 'password')
    if (typeof b.password !== 'string') throw new HttpError(400, 'Password must be a string')
    const ip = clientIp(rc.req)
    assertNotLocked(st, [ipKey(ip)])
    const t = findToken(st, 'reset', b.token)
    if (!t) {
      noteFailure(st, ipKey(ip), st.cfg.ipFree)
      throw new HttpError(400, 'This reset link is invalid or has expired')
    }
    const user = fresh(t.userId)
    if (!user) throw new HttpError(400, 'This reset link is invalid or has expired')
    const pol = checkPassword(st, b.password, { email: user.email })
    if (pol.errors.length) throw new HttpError(400, pol.errors[0]) // token not burnt: the user can retry
    const hashed = await hashPassword(b.password)
    const u = tx(db, () => {
      if (!db.remove('auth_tokens', t.id)) return null // single use, race-safe
      const updated = db.update('users', user.id, { password: hashed, passwordChangedAt: iso(st.now()), emailVerified: true })
      revokeSessions(db, updated.id)
      return updated
    })
    if (!u) throw new HttpError(400, 'This reset link is invalid or has expired')
    clearAllForEmail(st, u.email)
    audit(st, rc, u.id, 'auth.password.reset', `user:${u.id}`, {})
    sendMail(st, { to: u.email, subject: 'Your RD Cloude password was reset', tags: { kind: 'password-reset-done' },
      text: 'Your RD Cloude password was reset and every session was signed out. If this was not you, contact your administrator.\n' })
    return { ok: true, ...(pol.warnings.length ? { warnings: pol.warnings } : {}) }
  }, { public: true, meta: { summary: 'Set a new password with a reset token' } })

  /* ------------------------------------------------------------- email verification */
  r.post('/api/auth/verify-email', (rc) => {
    const st = S(rc.ctx)
    const b = bodyObj(rc.body)
    const ip = clientIp(rc.req)
    assertNotLocked(st, [ipKey(ip)])
    const t = findToken(st, 'verify', b.token)
    const u = t && tx(db, () => (db.remove('auth_tokens', t.id) ? db.update('users', t.userId, { emailVerified: true, emailVerifiedAt: iso(st.now()) }) : null))
    if (!u) {
      noteFailure(st, ipKey(ip), st.cfg.ipFree)
      throw new HttpError(400, 'This verification link is invalid or has expired')
    }
    if (u) audit(st, rc, u.id, 'auth.email.verified', `user:${u.id}`, {})
    return { ok: true }
  }, { public: true, meta: { summary: 'Confirm an email address with a token' } })

  r.post('/api/auth/verify-email/resend', (rc) => {
    const st = S(rc.ctx)
    if (rc.user.emailVerified) return { ok: true, alreadyVerified: true }
    if (!rateGate(st, `verify:${rc.user.id}`, 1, 60_000)) throw tooMany(60, 'Verification email already sent')
    sendVerification(st, rc.user)
    return { ok: true }
  })

  /* ------------------------------------------------------------- two-factor authentication */
  const twoFaStatus = (st, u) => ({
    enabled: !!u.totp?.enabled, enabledAt: u.totp?.enabledAt ?? null,
    recoveryCodesRemaining: u.totp?.enabled ? (u.recoveryCodes ?? []).filter((c) => !c.usedAt).length : 0,
    pending: !!u.totpPending && Date.parse(u.totpPending.at) > st.now() - 15 * 60_000,
  })
  const storeRecoveryCodes = (st, userId) => {
    const codes = generateRecoveryCodes(10)
    db.update('users', userId, { recoveryCodes: codes.map((c) => ({ hash: recoveryHash(st, c), usedAt: null })) })
    return codes
  }

  r.get('/api/auth/2fa', (rc) => twoFaStatus(S(rc.ctx), db.get('users', rc.user.id)))

  r.post('/api/auth/2fa/setup', async (rc) => {
    const st = S(rc.ctx)
    sessionOnly(rc.auth)
    const b = bodyObj(rc.body)
    if (rc.user.totp?.enabled) throw new HttpError(409, 'Two-factor authentication is already enabled')
    await confirmPassword(st.ctx, rc.req, rc.user, b.password)
    const secret = base32Encode(crypto.randomBytes(20))
    db.update('users', rc.user.id, { totpPending: { secret: seal(deriveKey(st.ctx, 'totp'), secret, rc.user.id), at: iso(st.now()) } })
    audit(st, rc, rc.user.id, 'auth.2fa.setup', `user:${rc.user.id}`, {})
    return { secret, otpauthUri: otpauthUri({ secret, account: rc.user.email }), issuer: 'RD Cloude', account: rc.user.email, algorithm: 'SHA1', digits: 6, period: 30 }
  })

  r.post('/api/auth/2fa/enable', (rc) => {
    const st = S(rc.ctx)
    sessionOnly(rc.auth)
    const b = bodyObj(rc.body)
    const u = fresh(rc.user.id)
    if (u.totp?.enabled) throw new HttpError(409, 'Two-factor authentication is already enabled')
    const p = u.totpPending
    if (!p || Date.parse(p.at) < st.now() - 15 * 60_000) throw new HttpError(400, 'Start setup first (POST /api/auth/2fa/setup); setup codes expire after 15 minutes')
    const ip = clientIp(rc.req)
    assertNotLocked(st, [acctKey(u.email, ip), ipKey(ip)])
    const secret = base32Decode(unseal(deriveKey(st.ctx, 'totp'), p.secret, u.id))
    const step = verifyTotp(secret, String(b.code ?? ''), { timeMs: st.now() })
    if (step === null) {
      failCredential(st, u.email, ip)
      throw new HttpError(400, 'That code is not valid. Check the time on your device and try again')
    }
    const { codes, others } = tx(db, () => {
      db.update('users', u.id, { totp: { enabled: true, secret: p.secret, enabledAt: iso(st.now()), lastStep: step }, totpPending: null })
      const out = { codes: storeRecoveryCodes(st, u.id), others: revokeSessions(db, u.id, rc.auth.sessionId) }
      db.update('sessions', rc.auth.sessionId, { mfa: true })
      return out
    })
    audit(st, rc, u.id, 'auth.2fa.enabled', `user:${u.id}`, { sessionsRevoked: others })
    sendMail(st, { to: u.email, subject: 'Two-factor authentication enabled', tags: { kind: '2fa-enabled' }, text: 'Two-factor authentication was enabled on your RD Cloude account. Other sessions were signed out.\n' })
    return { enabled: true, recoveryCodes: codes }
  })

  const needSecondFactor = async (st, rc, u, b) => {
    await confirmPassword(st.ctx, rc.req, u, b.password)
    if (!u.totp?.enabled) throw new HttpError(409, 'Two-factor authentication is not enabled')
    confirmSecondFactor(st.ctx, rc.req, u, b.code)
  }
  r.post('/api/auth/2fa/disable', async (rc) => {
    const st = S(rc.ctx)
    sessionOnly(rc.auth)
    const b = bodyObj(rc.body)
    const u = fresh(rc.user.id)
    await needSecondFactor(st, rc, u, b)
    db.update('users', u.id, { totp: null, totpPending: null, recoveryCodes: [] })
    audit(st, rc, u.id, 'auth.2fa.disabled', `user:${u.id}`, {})
    sendMail(st, { to: u.email, subject: 'Two-factor authentication disabled', tags: { kind: '2fa-disabled' }, text: 'Two-factor authentication was disabled on your RD Cloude account. If this was not you, change your password now.\n' })
    return { enabled: false }
  })
  r.post('/api/auth/2fa/recovery-codes', async (rc) => {
    const st = S(rc.ctx)
    sessionOnly(rc.auth)
    const b = bodyObj(rc.body)
    const u = fresh(rc.user.id)
    await needSecondFactor(st, rc, u, b)
    const codes = storeRecoveryCodes(st, u.id)
    audit(st, rc, u.id, 'auth.2fa.recovery_regenerated', `user:${u.id}`, {})
    return { recoveryCodes: codes }
  })

  /* ------------------------------------------------------------- API keys */
  r.get('/api/keys', ({ user }) => ({ keys: many(db, 'apiKeys', 'userId', user.id).map(keyView) }))

  r.post('/api/keys', (rc) => {
    const st = S(rc.ctx)
    const b = isObj(rc.body) ? rc.body : {}
    const name = b.name === undefined || b.name === null || b.name === '' ? 'default' : str(b.name, 'name', { max: 80 })
    const scopes = normalizeScopes(b.scopes)
    const now = st.now()
    let expiresAt = null
    if (b.expiresAt !== undefined && b.expiresAt !== null) {
      const t = typeof b.expiresAt === 'string' ? Date.parse(b.expiresAt) : NaN
      if (!Number.isFinite(t) || t <= now) throw new HttpError(400, 'expiresAt must be an ISO date in the future')
      if (t > now + 10 * 365 * 864e5) throw new HttpError(400, 'expiresAt is too far in the future (max 10 years)')
      expiresAt = iso(t)
    } else if (b.expiresInDays !== undefined && b.expiresInDays !== null) {
      const d = Number(b.expiresInDays)
      if (!Number.isFinite(d) || d <= 0 || d > 3650) throw new HttpError(400, 'expiresInDays must be between 0 and 3650')
      expiresAt = iso(now + d * 864e5)
    }
    // A key may only mint keys that are no more powerful or long-lived than itself.
    if (rc.auth.via === 'apiKey' && rc.auth.scopes) {
      if (!scopes || !scopes.every((s) => scopeCovers(rc.auth.scopes, s))) throw new HttpError(403, 'A scoped API key cannot create a key with broader scopes than its own')
      const parent = db.get('apiKeys', rc.auth.keyId)
      if (parent?.expiresAt && (!expiresAt || Date.parse(expiresAt) > Date.parse(parent.expiresAt))) throw new HttpError(403, 'A key cannot create a key that outlives it')
    }
    if (many(db, 'apiKeys', 'userId', rc.user.id).filter((k) => !k.revoked).length >= st.cfg.maxKeys) throw new HttpError(409, `Too many active API keys (max ${st.cfg.maxKeys})`)
    const token = 'rdk_' + crypto.randomBytes(24).toString('hex')
    const key = db.insert('apiKeys', { userId: rc.user.id, name, hash: sha(token), prefix: token.slice(0, 10), revoked: false, scopes, expiresAt, lastUsedAt: null, lastUsedIp: null })
    audit(st, rc, rc.user.id, 'auth.key.create', `key:${key.id}`, { name, scopes: scopes ?? 'full', expiresAt })
    return [201, { key: keyView(key), secret: token }] // secret is shown once
  })

  r.delete('/api/keys/:id', (rc) => {
    const st = S(rc.ctx)
    const k = db.get('apiKeys', rc.params.id)
    if (!k || k.userId !== rc.user.id) throw new HttpError(404, 'Key not found')
    db.update('apiKeys', k.id, { revoked: true, revokedAt: iso(st.now()) })
    audit(st, rc, rc.user.id, 'auth.key.revoke', `key:${k.id}`, { name: k.name })
    return { ok: true }
  })
}
