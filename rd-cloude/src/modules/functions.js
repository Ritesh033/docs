// Serverless functions. User JavaScript runs in a separate process (src/functions-runner.js) started inside fresh network + PID
// namespaces with the Node permission model, an empty environment, ulimits and a hard wall-clock kill. See docs/functions.md.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HttpError, required } from '../http.js'
import { record } from '../billing.js'
import { deriveKey } from '../auth.js'

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'functions-runner.js')
const envInt = (name, dflt, min, max) => { const n = Number(process.env[name]); return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : dflt }
const CFG = {
  maxFunctions: () => envInt('RD_FN_MAX_FUNCTIONS', 50, 1, 1000),
  globalConcurrency: () => envInt('RD_FN_MAX_CONCURRENCY', 8, 1, 256),
  userConcurrency: () => envInt('RD_FN_USER_CONCURRENCY', 5, 1, 64),
  fnConcurrency: () => envInt('RD_FN_CONCURRENCY', 5, 1, 64),
  maxTimeoutMs: () => envInt('RD_FN_MAX_TIMEOUT_MS', 30_000, 100, 900_000),
  warmIdleMs: () => envInt('RD_FN_WARM_IDLE_MS', 30_000, 1000, 600_000),
  allowUnsafe: () => process.env.RD_FUNCTIONS_UNSAFE === '1',
  allowPrivateFetch: () => process.env.RD_FUNCTIONS_ALLOW_PRIVATE === '1', // tests only
  codeBytes: 256 * 1024, maxVersions: 50, eventBytes: 256 * 1024, httpBodyBytes: 1024 * 1024, maxInvocationRecords: 300, maxEnvVars: 50,
  kvKeys: 1000, kvValueBytes: 256 * 1024, kvTotalBytes: 10 * 1024 * 1024, rpcKv: 50, rpcFetch: 10, fetchBody: 1024 * 1024, fetchResponse: 2 * 1024 * 1024,
  maxJobsPerUser: 1000, maxSchedules: 10, runsPerWorker: 50, maxWarm: 16,
}
const NAME_RE = /^[a-z][a-z0-9-]{0,47}$/
const ALIAS_RE = /^[a-z][a-z0-9-]{0,19}$/
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,63}$/
const KV_KEY_RE = /^[A-Za-z0-9_.:/-]{1,128}$/
const iso = (t = Date.now()) => new Date(t).toISOString()
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

/* ------------------------------------------------------------------ cron (5 fields, UTC) */
const NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
function parseField(text, min, max, names) {
  const out = new Set()
  for (const part of text.split(',')) {
    const m = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d+))?$/.exec(part)
    if (!m) throw new Error(`Invalid cron field "${text.slice(0, 30)}"`)
    const step = m[2] === undefined ? 1 : Number(m[2])
    if (!(step >= 1)) throw new Error('Cron step must be >= 1')
    const num = (s) => { const v = /^\d+$/.test(s) ? Number(s) : names?.[s.toLowerCase()]; if (v === undefined || !Number.isInteger(v)) throw new Error(`Invalid cron value "${s}"`); return v }
    let lo, hi
    if (m[1] === '*') { lo = min; hi = max } else if (m[1].includes('-')) { const [a, b] = m[1].split('-'); lo = num(a); hi = num(b) } else { lo = num(m[1]); hi = m[2] === undefined ? lo : max }
    if (lo < min || hi > max || lo > hi) throw new Error(`Cron value out of range (${min}-${max})`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}
export function parseCron(expr) {
  if (typeof expr !== 'string' || expr.length > 100) throw new Error('Cron expression must be a string')
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) throw new Error('Cron needs 5 fields: minute hour day-of-month month day-of-week')
  const dow = parseField(f[4], 0, 7, NAMES)
  if (dow.has(7)) { dow.delete(7); dow.add(0) }
  return { min: parseField(f[0], 0, 59), hour: parseField(f[1], 0, 23), dom: parseField(f[2], 1, 31), mon: parseField(f[3], 1, 12, NAMES), dow, domStar: f[2] === '*' || f[2].startsWith('*/'), dowStar: f[4] === '*' || f[4].startsWith('*/') }
}
export function nextCron(spec, afterMs) {
  const d = new Date(Math.floor(afterMs / 60_000) * 60_000 + 60_000)
  const limit = afterMs + 8 * 366 * 86_400_000 // covers leap days (Feb 29 can be up to 8 years away across a century boundary)
  while (d.getTime() <= limit) {
    if (!spec.mon.has(d.getUTCMonth() + 1)) { d.setUTCMonth(d.getUTCMonth() + 1, 1); d.setUTCHours(0, 0, 0, 0); continue }
    const domOk = spec.dom.has(d.getUTCDate()), dowOk = spec.dow.has(d.getUTCDay())
    const dayOk = spec.domStar && spec.dowStar ? true : spec.domStar ? dowOk : spec.dowStar ? domOk : domOk || dowOk
    if (!dayOk) { d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(0, 0, 0, 0); continue }
    if (!spec.hour.has(d.getUTCHours())) { d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0); continue }
    if (!spec.min.has(d.getUTCMinutes())) { d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0); continue }
    return d.getTime()
  }
  return null
}

/* ------------------------------------------------------------------ SSRF-safe fetch (parent side) */
function v4Private(a, b) {
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
}
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) { const [a, b, c] = ip.split('.').map(Number); return v4Private(a, b) || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase()
    const mapped = /^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/.exec(l) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(l)
    if (mapped) return isPrivateIp(mapped[1])
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(l)
    if (hex) { const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16); return isPrivateIp([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')) }
    return l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff') || l.startsWith('2001:db8') || l.startsWith('100::')
  }
  return true
}
function hostAllowed(host, allowed) {
  const h = host.toLowerCase()
  return allowed.some((a) => { const x = a.toLowerCase(); return x.startsWith('*.') ? h.endsWith(x.slice(1)) && h.length > x.length - 1 : x === h })
}
async function safeFetch(req, { allowedHosts }) {
  let url, method = req.method, body = req.body, headers = req.headers
  for (let hop = 0; hop <= 3; hop++) {
    try { url = new URL(req.url) } catch { throw new Error('Invalid URL') }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https URLs are allowed')
    if (url.username || url.password) throw new Error('URLs with credentials are not allowed')
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    if (!hostAllowed(host, allowedHosts) && !hostAllowed(`${host}:${port}`, allowedHosts)) throw new Error(`Host "${host}" is not in this function's network allowlist`)
    if (![80, 443].includes(port) && !hostAllowed(`${host}:${port}`, allowedHosts)) throw new Error(`Port ${port} is not allowed (allowlist "${host}:${port}" explicitly to use it)`)
    const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true, verbatim: true })
    if (!addrs.length) throw new Error('Host did not resolve')
    if (!CFG.allowPrivateFetch() && addrs.some((a) => isPrivateIp(a.address))) throw new Error('Requests to private, loopback or link-local addresses are blocked')
    const pin = addrs[0]
    const res = await new Promise((resolve, reject) => {
      const mod = url.protocol === 'https:' ? https : http
      const hdrs = { 'user-agent': 'RD-Cloude-Function/1' }
      for (const [k, v] of Object.entries(headers ?? {})) if (!/^(host|connection|content-length|transfer-encoding|expect|upgrade|proxy-.*|te|trailer|keep-alive)$/.test(k) && /^[a-z0-9-]{1,64}$/.test(k) && !/[\r\n]/.test(String(v))) hdrs[k] = String(v).slice(0, 2000)
      if (body !== undefined && body !== null) hdrs['content-length'] = Buffer.byteLength(body)
      const r = mod.request({ protocol: url.protocol, hostname: host, port, path: url.pathname + url.search, method, headers: hdrs, timeout: 10_000, servername: net.isIP(host) ? undefined : host, lookup: (_h, _o, cb) => cb(null, pin.address, pin.family) }, (resp) => {
        const chunks = []; let size = 0
        resp.on('data', (c) => { size += c.length; if (size > CFG.fetchResponse) { resp.destroy(); reject(new Error('Response too large')); return } chunks.push(c) })
        resp.on('end', () => resolve({ status: resp.statusCode, statusText: resp.statusMessage ?? '', headers: Object.fromEntries(Object.entries(resp.headers).filter(([k]) => k !== 'set-cookie').map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)])), body: Buffer.concat(chunks).toString('utf8') }))
        resp.on('error', reject)
      })
      r.on('timeout', () => r.destroy(new Error('Request timed out')))
      r.on('error', reject)
      if (body !== undefined && body !== null) r.write(body)
      r.end()
    })
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      req = { ...req, url: new URL(res.headers.location, url).toString() }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; body = undefined }
      continue // the next hop is validated from scratch
    }
    return { ...res, url: url.toString() }
  }
  throw new Error('Too many redirects')
}

export async function register(r, db, ctx) {
  const by = (col, field, value) => (typeof db.findBy === 'function' ? db.findBy(col, field, value) : db.find(col, (x) => x[field] === value))
  const audit = (userId, action, resource, meta) => { try { ctx.events.emit('audit', { userId, action, resource, meta }) } catch { /* ignore */ } }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-fn-'))

  /* ------------------------------------------------------------------ isolation detection */
  const find = (names) => names.find((p) => fs.existsSync(p))
  const UNSHARE = find(['/usr/bin/unshare', '/bin/unshare', '/usr/sbin/unshare'])
  const SH = find(['/bin/sh', '/usr/bin/sh'])
  const run = (cmd, args) => new Promise((resolve) => { try { const c = spawn(cmd, args, { stdio: 'ignore', env: {} }); c.on('exit', (code) => resolve(code === 0)); c.on('error', () => resolve(false)) } catch { resolve(false) } })
  const NS_ARGS = ['--net', '--pid', '--fork', '--kill-child', '--']
  const permission = await run(process.execPath, ['--permission', '-e', '0'])
  let mode = 'none'
  if (UNSHARE && SH) {
    if (await run(UNSHARE, [...NS_ARGS, SH, '-c', 'exit 0'])) mode = 'namespaces'
    else if (await run(UNSHARE, ['-r', ...NS_ARGS, SH, '-c', 'exit 0'])) mode = 'user-namespaces'
  }
  const isolation = { mode, network: mode !== 'none', pidNamespace: mode !== 'none', permissionModel: permission, ready: (mode !== 'none' && permission) || CFG.allowUnsafe() }
  if (!isolation.ready) console.error('[functions] no sandbox primitives available (need `unshare` namespaces and the Node permission model). Function execution is disabled; set RD_FUNCTIONS_UNSAFE=1 for development only.')

  function launch(memoryMb) {
    const nodeArgs = ['--disable-warning=ExperimentalWarning', `--max-old-space-size=${Math.max(32, Math.floor(memoryMb * 0.7))}`, ...(permission ? ['--permission', `--allow-fs-read=${RUNNER}`] : []), RUNNER]
    const vmKb = Math.max(1_048_576, memoryMb * 4096)
    const inner = `ulimit -v ${vmKb} 2>/dev/null; ulimit -n 64 2>/dev/null; ulimit -c 0 2>/dev/null; exec "$@"`
    const tail = [SH, '-c', inner, 'sh', process.execPath, ...nodeArgs]
    if (mode === 'namespaces') return [UNSHARE, [...NS_ARGS, ...tail]]
    if (mode === 'user-namespaces') return [UNSHARE, ['-r', ...NS_ARGS, ...tail]]
    return [SH, tail.slice(1)]
  }

  /* ------------------------------------------------------------------ worker processes */
  class Worker {
    constructor(fn) { this.fnId = fn.id; this.userId = fn.userId; this.dead = false; this.runs = 0; this.lastUsed = Date.now(); this.stderr = ''; this.buf = ''; this.cur = null }
    start(memoryMb) {
      const [cmd, args] = launch(memoryMb)
      const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: {}, cwd: workDir })
      this.child = child
      this.ready = new Promise((resolve, reject) => { this._ready = resolve; this._fail = reject })
      child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-2000) })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (d) => {
        this.buf += d
        if (this.buf.length > 4 * 1024 * 1024) { this.kill(); return }
        let i
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1)
          let m; try { m = JSON.parse(line) } catch { continue } // unparseable output is ignored (it can only hurt the sender)
          if (m?.t === 'ready') this._ready()
          else if (m?.t === 'result' && this.cur && m.id === this.cur.id) { const c = this.cur; this.cur = null; clearTimeout(c.timer); c.resolve(m) }
          else if (m?.t === 'rpc' && this.cur && m.id === this.cur.id) this.handleRpc(m)
        }
      })
      child.on('exit', (code, signal) => {
        this.dead = true
        const err = Object.assign(new Error(`The function process stopped unexpectedly (${signal ?? `exit ${code}`})`), { crashed: true, stderr: this.stderr })
        this._fail?.(err)
        if (this.cur) { const c = this.cur; this.cur = null; clearTimeout(c.timer); c.reject(err) }
      })
      child.on('error', (e) => this._fail?.(e))
      child.stdin.on('error', () => {})
      return this.ready
    }
    kill() { this.dead = true; try { this.child?.kill('SIGKILL') } catch { /* gone */ } }
    send(m) { if (!this.dead) this.child.stdin.write(JSON.stringify(m) + '\n') }
    handleRpc(m) {
      const c = this.cur
      const reply = (ok, value, error) => this.send({ t: 'rpcres', rid: m.rid, ok, ...(ok ? { value } : { error: String(error?.message ?? error).slice(0, 300) }) })
      Promise.resolve().then(() => c.onRpc(m)).then((v) => reply(true, v ?? null), (e) => reply(false, null, e))
    }
    call(msg, timeoutMs, onRpc) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.cur = null; this.kill(); reject(Object.assign(new Error(`Function timed out after ${timeoutMs} ms`), { timeout: true })) }, timeoutMs)
        this.cur = { id: msg.id, resolve, reject, timer, onRpc }
        this.send(msg)
      })
    }
  }

  const warm = new Map() // fnId -> Worker[] (idle)
  const live = new Set()
  function warmCount() { let n = 0; for (const a of warm.values()) n += a.length; return n }
  async function getWorker(fn) {
    const idle = warm.get(fn.id)
    while (idle?.length) { const w = idle.pop(); if (!w.dead) return w }
    while (warmCount() >= CFG.maxWarm) { // evict the least recently used idle worker
      let oldest = null
      for (const arr of warm.values()) for (const w of arr) if (!oldest || w.lastUsed < oldest.lastUsed) oldest = w
      if (!oldest) break
      oldest.kill(); warm.set(oldest.fnId, (warm.get(oldest.fnId) ?? []).filter((x) => x !== oldest))
    }
    const w = new Worker(fn)
    live.add(w)
    try { await w.start(fn.memoryMb) } catch (e) { w.kill(); live.delete(w); throw new HttpError(500, `Could not start the sandbox: ${(w.stderr.split('\n').filter(Boolean).pop() ?? e.message).slice(0, 200)}`) }
    w.child.on('exit', () => live.delete(w))
    return w
  }
  function release(fn, w) {
    w.runs++; w.lastUsed = Date.now()
    if (w.dead || w.runs >= CFG.runsPerWorker) { w.kill(); return }
    const arr = warm.get(fn.id) ?? []
    if (arr.length >= 2) { w.kill(); return }
    arr.push(w); warm.set(fn.id, arr)
  }
  const warmTimer = setInterval(() => {
    for (const [id, arr] of warm) { const keep = arr.filter((w) => { if (!w.dead && Date.now() - w.lastUsed > CFG.warmIdleMs()) w.kill(); return !w.dead }); if (keep.length) warm.set(id, keep); else warm.delete(id) }
  }, 5000)
  warmTimer.unref?.()

  /* ------------------------------------------------------------------ concurrency gate */
  const gate = { global: 0, user: new Map(), fn: new Map(), waiters: [] }
  const canTake = (fn) => gate.global < CFG.globalConcurrency() && (gate.user.get(fn.userId) ?? 0) < CFG.userConcurrency() && (gate.fn.get(fn.id) ?? 0) < CFG.fnConcurrency()
  const take = (fn) => { gate.global++; gate.user.set(fn.userId, (gate.user.get(fn.userId) ?? 0) + 1); gate.fn.set(fn.id, (gate.fn.get(fn.id) ?? 0) + 1) }
  function giveBack(fn) {
    gate.global--
    for (const [m, k] of [[gate.user, fn.userId], [gate.fn, fn.id]]) { const v = (m.get(k) ?? 1) - 1; if (v <= 0) m.delete(k); else m.set(k, v) }
    const i = gate.waiters.findIndex((w) => canTake(w.fn))
    if (i >= 0) { const [w] = gate.waiters.splice(i, 1); take(w.fn); clearTimeout(w.timer); w.resolve() }
  }
  const acquire = (fn, waitMs) => new Promise((resolve, reject) => {
    if (canTake(fn)) { take(fn); return resolve() }
    if (waitMs <= 0) return reject(new HttpError(429, 'Too many concurrent function invocations'))
    const w = { fn, resolve }
    w.timer = setTimeout(() => { gate.waiters.splice(gate.waiters.indexOf(w), 1); reject(new HttpError(429, 'Too many concurrent function invocations')) }, waitMs)
    gate.waiters.push(w)
  })

  /* ------------------------------------------------------------------ secrets at rest */
  const fnKey = () => deriveKey(ctx, 'functions-env')
  function seal(plain, aad) {
    const iv = crypto.randomBytes(12)
    const c = crypto.createCipheriv('aes-256-gcm', fnKey(), iv); c.setAAD(Buffer.from(aad))
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')
  }
  function open(blob, aad) {
    const b = Buffer.from(blob, 'base64')
    const d = crypto.createDecipheriv('aes-256-gcm', fnKey(), b.subarray(0, 12)); d.setAAD(Buffer.from(aad)); d.setAuthTag(b.subarray(12, 28))
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')
  }
  const envAad = (fn, k) => `fnenv:${fn.userId}:${fn.id}:${k}`
  const plainEnv = (fn) => {
    const out = {}
    for (const [k, e] of Object.entries(fn.env ?? {})) { try { out[k] = e.secret ? open(e.v, envAad(fn, k)) : e.v } catch { /* unreadable secret: omitted */ } }
    return out
  }

  /* ------------------------------------------------------------------ records */
  const own = (user, id) => {
    const fn = typeof id === 'string' ? db.get('fn_functions', id) : null
    if (!fn || fn.userId !== user.id) throw new HttpError(404, 'Function not found')
    return fn
  }
  const view = (fn, full = false) => ({
    id: fn.id, name: fn.name, description: fn.description ?? '', runtime: 'node22', memoryMb: fn.memoryMb, timeoutMs: fn.timeoutMs, latestVersion: fn.versions.at(-1)?.n ?? 0, aliases: fn.aliases ?? {},
    allowNetwork: !!fn.allowNetwork, allowedHosts: fn.allowedHosts ?? [], http: fn.http ?? { enabled: false, auth: 'apiKey' }, schedule: fn.schedule ?? null, url: fn.http?.enabled ? `/fn/${fn.id}` : null,
    createdAt: fn.createdAt, updatedAt: fn.updatedAt ?? fn.createdAt,
    ...(full ? { code: fn.versions.at(-1)?.code ?? '', env: Object.fromEntries(Object.entries(fn.env ?? {}).map(([k, e]) => [k, { secret: !!e.secret, value: e.secret ? null : e.v }])) } : {}),
  })
  function validateCode(code) {
    if (typeof code !== 'string' || !code.trim()) throw new HttpError(400, 'code is required')
    if (Buffer.byteLength(code) > CFG.codeBytes) throw new HttpError(413, `Code is larger than ${CFG.codeBytes} bytes`)
    return code
  }
  const memOf = (v, dflt = 128) => { if (v === undefined) return dflt; if (!Number.isInteger(v) || v < 64 || v > 512) throw new HttpError(400, 'memoryMb must be an integer between 64 and 512'); return v }
  const timeoutOf = (v, dflt = 3000) => { if (v === undefined) return dflt; if (!Number.isInteger(v) || v < 100 || v > CFG.maxTimeoutMs()) throw new HttpError(400, `timeoutMs must be an integer between 100 and ${CFG.maxTimeoutMs()}`); return v }
  function addVersion(fn, code) {
    const n = (fn.versions.at(-1)?.n ?? 0) + 1
    let versions = [...fn.versions, { n, code, sha256: sha(code), createdAt: iso() }]
    const pinned = new Set(Object.values(fn.aliases ?? {}))
    while (versions.length > CFG.maxVersions) { const i = versions.findIndex((v, idx) => idx < versions.length - 1 && !pinned.has(v.n)); if (i < 0) break; versions.splice(i, 1) }
    return versions
  }

  /* ------------------------------------------------------------------ kv + fetch brokers */
  function kvOp(fn, m, counters) {
    if (++counters.kv > CFG.rpcKv) throw new Error(`At most ${CFG.rpcKv} ctx.kv calls per invocation`)
    const rows = by('fn_kv', 'fnId', fn.id)
    if (m.op === 'list') return rows.filter((x) => x.key.startsWith(String(m.key ?? ''))).map((x) => x.key).sort().slice(0, 100)
    if (!KV_KEY_RE.test(m.key)) throw new Error('kv keys use letters, digits and _ . : / - (max 128)')
    const row = rows.find((x) => x.key === m.key)
    if (m.op === 'get') return row ? row.value : null
    if (m.op === 'delete') { if (row) db.remove('fn_kv', row.id); return true }
    if (m.op === 'set') {
      const json = JSON.stringify(m.value ?? null)
      if (json === undefined || json.length > CFG.kvValueBytes) throw new Error(`kv values must be JSON of at most ${CFG.kvValueBytes} bytes`)
      const total = rows.reduce((s, x) => s + (x.size ?? 0), 0) - (row?.size ?? 0) + json.length
      if (!row && rows.length >= CFG.kvKeys) throw new Error(`At most ${CFG.kvKeys} kv keys per function`)
      if (total > CFG.kvTotalBytes) throw new Error('kv storage limit reached')
      if (row) db.update('fn_kv', row.id, { value: JSON.parse(json), size: json.length })
      else db.insert('fn_kv', { userId: fn.userId, fnId: fn.id, key: m.key, value: JSON.parse(json), size: json.length })
      return true
    }
    throw new Error('Unknown kv operation')
  }
  async function fetchOp(fn, m, counters) {
    if (!fn.allowNetwork) throw new Error('Network access is disabled for this function (enable allowNetwork and set allowedHosts)')
    if (++counters.fetch > CFG.rpcFetch) throw new Error(`At most ${CFG.rpcFetch} ctx.fetch calls per invocation`)
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(m.method)) throw new Error('Unsupported method')
    if (m.body !== undefined && m.body !== null && (typeof m.body !== 'string' || m.body.length > CFG.fetchBody)) throw new Error(`Request bodies are limited to ${CFG.fetchBody} bytes`)
    return safeFetch({ url: m.url, method: m.method, headers: m.headers, body: m.body }, { allowedHosts: fn.allowedHosts ?? [] })
  }

  /* ------------------------------------------------------------------ the invocation core */
  async function invokeFunction(fn, { event, version, alias, trigger = 'invoke', waitMs = 2000, requestId = crypto.randomUUID() }) {
    if (!isolation.ready) throw new HttpError(503, 'Function execution is unavailable on this host: the sandbox needs Linux namespaces (unshare) and the Node permission model. Set RD_FUNCTIONS_UNSAFE=1 for development only.')
    const ver = fn.versions.find((v) => v.n === version)
    if (!ver) throw new HttpError(404, 'Version not found')
    let json; try { json = JSON.stringify(event ?? null) } catch { throw new HttpError(400, 'event must be JSON') }
    if (json === undefined || json.length > CFG.eventBytes) throw new HttpError(413, `event is larger than ${CFG.eventBytes} bytes`)
    ctx.quotas?.enforce?.(fn.userId, 'functions.invocations', 1)
    await acquire(fn, waitMs)
    let released = false
    const rel = () => { if (!released) { released = true; giveBack(fn) } }
    const started = Date.now()
    const counters = { kv: 0, fetch: 0 }
    let out = { status: 'ok' }, w
    try {
      w = await getWorker(fn)
      const msg = {
        t: 'invoke', id: requestId, hash: ver.sha256, code: ver.code, event: JSON.parse(json), env: plainEnv(fn), timeoutMs: fn.timeoutMs,
        caps: { kv: true, fetch: true }, ctx: { requestId, functionName: fn.name, version: ver.n, alias: alias ?? null, memoryMb: fn.memoryMb },
      }
      const res = await w.call(msg, fn.timeoutMs + 500, (m) => (m.kind === 'kv' ? kvOp(fn, m, counters) : m.kind === 'fetch' ? fetchOp(fn, m, counters) : Promise.reject(new Error('Unknown request'))))
      out = res.ok ? { status: 'ok', result: JSON.parse(res.json), logs: res.logs, logsTruncated: res.logsTruncated } : { status: 'error', error: res.error, logs: res.logs }
      release(fn, w)
    } catch (e) {
      if (w) { w.kill(); live.delete(w) }
      if (e instanceof HttpError) { rel(); throw e }
      out = e?.timeout ? { status: 'timeout', error: { name: 'Timeout', message: e.message }, logs: [] }
        : { status: 'crash', error: { name: 'FunctionCrashed', message: `${e.message}${/out of memory|heap/i.test(e.stderr ?? '') ? ' (out of memory)' : ''}` }, logs: [] }
    } finally { rel() }
    const durationMs = Date.now() - started
    const billedMs = out.status === 'timeout' ? fn.timeoutMs : Math.max(100, Math.ceil(durationMs / 100) * 100)
    record(db, fn.userId, 'functions.invocations', 1)
    record(db, fn.userId, 'functions.gb_seconds', (fn.memoryMb / 1024) * (billedMs / 1000))
    const rec = db.insert('fn_invocations', { userId: fn.userId, fnId: fn.id, requestId, version: ver.n, alias: alias ?? null, trigger, status: out.status, durationMs, billedMs, memoryMb: fn.memoryMb, error: out.error ? `${out.error.name}: ${out.error.message}`.slice(0, 500) : undefined, logs: (out.logs ?? []).slice(0, 50), ts: Date.now() })
    const recs = by('fn_invocations', 'fnId', fn.id)
    if (recs.length > CFG.maxInvocationRecords) for (const old of recs.sort((a, b) => a.ts - b.ts).slice(0, recs.length - CFG.maxInvocationRecords)) db.remove('fn_invocations', old.id)
    return { requestId, status: out.status, result: out.result, error: out.error, logs: out.logs ?? [], logsTruncated: out.logsTruncated, durationMs, billedMs, version: ver.n, id: rec.id }
  }
  const resolveTarget = (fn, { version, alias }) => {
    if (version !== undefined && alias !== undefined) throw new HttpError(400, 'Specify version or alias, not both')
    if (version !== undefined) { if (!Number.isInteger(version)) throw new HttpError(400, 'version must be an integer'); return { version, alias: null } }
    const a = alias ?? 'live'
    if (!ALIAS_RE.test(a)) throw new HttpError(400, 'Invalid alias')
    const v = fn.aliases?.[a] ?? (a === 'live' ? fn.versions.at(-1)?.n : undefined)
    if (v === undefined) throw new HttpError(404, `Alias "${a}" does not exist`)
    return { version: v, alias: a }
  }

  /* ================================================================== routes ================================================================== */
  r.get('/api/functions/_runtime', () => ({ isolation, limits: { maxFunctions: CFG.maxFunctions(), maxTimeoutMs: CFG.maxTimeoutMs(), codeBytes: CFG.codeBytes, concurrency: CFG.fnConcurrency(), kvKeys: CFG.kvKeys }, note: isolation.ready ? undefined : 'Function execution is disabled on this host.' }))
  r.get('/api/functions', ({ user }) => ({ functions: by('fn_functions', 'userId', user.id).sort((a, b) => a.name.localeCompare(b.name)).map((f) => view(f)), isolation: { mode: isolation.mode, ready: isolation.ready } }))
  r.post('/api/functions', ({ user, body }) => {
    required(body, 'name', 'code')
    if (typeof body.name !== 'string' || !NAME_RE.test(body.name)) throw new HttpError(400, 'Function names are 1-48 characters: lowercase letters, digits and "-", starting with a letter')
    const mine = by('fn_functions', 'userId', user.id)
    if (mine.length >= CFG.maxFunctions()) throw new HttpError(409, `At most ${CFG.maxFunctions()} functions`)
    if (mine.some((f) => f.name === body.name)) throw new HttpError(409, 'You already have a function with that name')
    const code = validateCode(body.code)
    const fn = db.insert('fn_functions', {
      userId: user.id, name: body.name, description: String(body.description ?? '').slice(0, 300), memoryMb: memOf(body.memoryMb), timeoutMs: timeoutOf(body.timeoutMs), allowNetwork: false, allowedHosts: [],
      versions: [{ n: 1, code, sha256: sha(code), createdAt: iso() }], aliases: { live: 1 }, env: {}, http: { enabled: false, auth: 'apiKey' }, schedule: null,
    })
    audit(user.id, 'functions.create', fn.id, { name: fn.name })
    return [201, view(fn, true)]
  })
  r.get('/api/functions/:id', ({ user, params }) => view(own(user, params.id), true))
  r.patch('/api/functions/:id', ({ user, params, body }) => {
    const fn = own(user, params.id)
    const patch = {}
    if (body.description !== undefined) patch.description = String(body.description).slice(0, 300)
    if (body.memoryMb !== undefined) patch.memoryMb = memOf(body.memoryMb)
    if (body.timeoutMs !== undefined) patch.timeoutMs = timeoutOf(body.timeoutMs)
    if (body.allowNetwork !== undefined) patch.allowNetwork = body.allowNetwork === true
    if (body.allowedHosts !== undefined) {
      if (!Array.isArray(body.allowedHosts) || body.allowedHosts.length > 20 || body.allowedHosts.some((h) => typeof h !== 'string' || !/^(\*\.)?[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/i.test(h))) throw new HttpError(400, 'allowedHosts must be up to 20 hostnames like "api.example.com", "*.example.com" or "host:port"')
      patch.allowedHosts = body.allowedHosts.map((h) => h.toLowerCase())
    }
    const upd = db.update('fn_functions', fn.id, patch)
    for (const x of warm.get(fn.id) ?? []) x.kill()
    warm.delete(fn.id)
    return view(upd, true)
  })
  r.delete('/api/functions/:id', ({ user, params }) => {
    const fn = own(user, params.id)
    for (const x of warm.get(fn.id) ?? []) x.kill()
    warm.delete(fn.id)
    for (const col of ['fn_invocations', 'fn_kv', 'fn_jobs']) db.removeWhere(col, (x) => x.fnId === fn.id)
    db.remove('fn_functions', fn.id)
    audit(user.id, 'functions.delete', fn.id, { name: fn.name })
    return { ok: true }
  })

  r.put('/api/functions/:id/code', ({ user, params, body }) => {
    const fn = own(user, params.id)
    const code = validateCode(body.code)
    if (fn.versions.at(-1)?.sha256 === sha(code)) return { ...view(fn), unchanged: true }
    const upd = db.update('fn_functions', fn.id, { versions: addVersion(fn, code), aliases: { ...(fn.aliases ?? {}), live: (fn.versions.at(-1)?.n ?? 0) + 1 } })
    return view(upd)
  })
  r.get('/api/functions/:id/versions', ({ user, params }) => ({ versions: own(user, params.id).versions.map((v) => ({ version: v.n, sha256: v.sha256, createdAt: v.createdAt, bytes: Buffer.byteLength(v.code) })) }))
  r.get('/api/functions/:id/versions/:n', ({ user, params }) => {
    const v = own(user, params.id).versions.find((x) => x.n === Number(params.n))
    if (!v) throw new HttpError(404, 'Version not found')
    return { version: v.n, code: v.code, createdAt: v.createdAt }
  })
  r.put('/api/functions/:id/aliases/:alias', ({ user, params, body }) => {
    const fn = own(user, params.id)
    if (!ALIAS_RE.test(params.alias)) throw new HttpError(400, 'Alias names are 1-20 characters: lowercase letters, digits and "-"')
    if (!fn.versions.some((v) => v.n === body.version)) throw new HttpError(404, 'Version not found')
    if (Object.keys(fn.aliases ?? {}).length >= 10 && !fn.aliases?.[params.alias]) throw new HttpError(409, 'At most 10 aliases')
    return view(db.update('fn_functions', fn.id, { aliases: { ...(fn.aliases ?? {}), [params.alias]: body.version } }))
  })
  r.delete('/api/functions/:id/aliases/:alias', ({ user, params }) => {
    const fn = own(user, params.id)
    if (params.alias === 'live') throw new HttpError(400, 'The "live" alias cannot be removed')
    const { [params.alias]: _gone, ...rest } = fn.aliases ?? {}
    return view(db.update('fn_functions', fn.id, { aliases: rest }))
  })

  r.put('/api/functions/:id/env', ({ user, params, body }) => {
    const fn = own(user, params.id)
    if (body.env === null || typeof body.env !== 'object' || Array.isArray(body.env)) throw new HttpError(400, 'env must be an object of {KEY: {value, secret}}')
    const entries = Object.entries(body.env)
    if (entries.length > CFG.maxEnvVars) throw new HttpError(400, `At most ${CFG.maxEnvVars} variables`)
    const env = {}
    let total = 0
    for (const [k, spec] of entries) {
      if (!ENV_KEY_RE.test(k) || k.startsWith('RD_')) throw new HttpError(400, `Invalid variable name "${k.slice(0, 40)}" (use A-Z, 0-9, _; "RD_" is reserved)`)
      const prev = fn.env?.[k]
      const s = spec !== null && typeof spec === 'object' ? spec : { value: spec }
      const secret = s.secret === true || (s.secret === undefined && prev?.secret === true)
      let value = s.value
      if (value === undefined || value === null) { if (!prev) throw new HttpError(400, `Variable ${k} needs a value`); env[k] = prev; continue } // keep the stored value
      if (typeof value !== 'string' || value.length > 4096) throw new HttpError(400, `Value of ${k} must be a string of at most 4096 characters`)
      total += value.length
      env[k] = { secret, v: secret ? seal(value, envAad(fn, k)) : value }
    }
    if (total > 32 * 1024) throw new HttpError(413, 'Environment is too large')
    const upd = db.update('fn_functions', fn.id, { env })
    for (const x of warm.get(fn.id) ?? []) x.kill()
    warm.delete(fn.id)
    return view(upd, true)
  })

  r.post('/api/functions/:id/invoke', async ({ user, params, body }) => {
    const fn = own(user, params.id)
    const tgt = resolveTarget(fn, body)
    if (body.async === true) return [202, enqueue(fn, body.event, tgt, 'async')]
    const out = await invokeFunction(fn, { event: body.event ?? {}, ...tgt })
    return { ...out, result: out.result }
  })

  r.get('/api/functions/:id/invocations', ({ user, params, query }) => {
    const fn = own(user, params.id)
    const limit = Math.min(100, Math.max(1, Number(query.get('limit')) || 30))
    const before = query.get('cursor') ? Number(query.get('cursor')) : Infinity
    const rows = by('fn_invocations', 'fnId', fn.id).filter((x) => x.ts < before).sort((a, b) => b.ts - a.ts)
    const page = rows.slice(0, limit)
    return { invocations: page.map(({ id, requestId, version, alias, trigger, status, durationMs, billedMs, memoryMb, error, logs, ts }) => ({ id, requestId, version, alias, trigger, status, durationMs, billedMs, memoryMb, error, logs, at: iso(ts) })), nextCursor: rows.length > limit ? String(page.at(-1).ts) : null }
  })
  r.get('/api/functions/:id/metrics', ({ user, params, query }) => {
    const fn = own(user, params.id)
    const windowMs = query.get('window') === '1h' ? 3600_000 : 24 * 3600_000
    const from = Date.now() - windowMs
    const rows = by('fn_invocations', 'fnId', fn.id).filter((x) => x.ts >= from)
    const dur = rows.map((x) => x.durationMs).sort((a, b) => a - b)
    const pct = (p) => (dur.length ? dur[Math.min(dur.length - 1, Math.floor((p / 100) * dur.length))] : null)
    const bucket = windowMs === 3600_000 ? 300_000 : 3600_000
    const series = new Map()
    for (const x of rows) { const k = Math.floor(x.ts / bucket) * bucket; const b = series.get(k) ?? { t: iso(k), invocations: 0, errors: 0 }; b.invocations++; if (x.status !== 'ok') b.errors++; series.set(k, b) }
    return { window: windowMs === 3600_000 ? '1h' : '24h', invocations: rows.length, errors: rows.filter((x) => x.status !== 'ok').length, timeouts: rows.filter((x) => x.status === 'timeout').length, p50: pct(50), p95: pct(95), billedMs: rows.reduce((s, x) => s + x.billedMs, 0), series: [...series.values()].sort((a, b) => a.t.localeCompare(b.t)) }
  })

  /* ---- triggers ---- */
  r.put('/api/functions/:id/trigger', ({ user, params, body }) => {
    const fn = own(user, params.id)
    const patch = {}
    if (body.http !== undefined) {
      const h = body.http
      if (h === null || typeof h !== 'object' || (h.auth !== undefined && !['none', 'apiKey'].includes(h.auth))) throw new HttpError(400, 'http must be {enabled, auth: "none"|"apiKey"}')
      patch.http = { enabled: h.enabled === true, auth: h.auth ?? fn.http?.auth ?? 'apiKey' }
    }
    if (body.schedule !== undefined) {
      if (body.schedule === null) patch.schedule = null
      else {
        const s = body.schedule
        let spec; try { spec = parseCron(s.cron) } catch (e) { throw new HttpError(400, e.message) }
        if (!ALIAS_RE.test(s.alias ?? 'live')) throw new HttpError(400, 'Invalid alias')
        if (JSON.stringify(s.event ?? {}).length > 16 * 1024) throw new HttpError(413, 'Schedule event is too large')
        if (by('fn_functions', 'userId', user.id).filter((f) => f.schedule?.enabled && f.id !== fn.id).length >= CFG.maxSchedules && s.enabled !== false) throw new HttpError(409, `At most ${CFG.maxSchedules} scheduled functions`)
        patch.schedule = { cron: s.cron.trim(), alias: s.alias ?? 'live', event: s.event ?? {}, enabled: s.enabled !== false, nextRunAt: s.enabled === false ? null : nextCron(spec, Date.now()) }
      }
    }
    return view(db.update('fn_functions', fn.id, patch))
  })

  /* ---- async jobs + DLQ ---- */
  function enqueue(fn, event, tgt, source) {
    let json; try { json = JSON.stringify(event ?? {}) } catch { throw new HttpError(400, 'event must be JSON') }
    if (json.length > CFG.eventBytes) throw new HttpError(413, 'event is too large')
    if (by('fn_jobs', 'userId', fn.userId).filter((j) => j.status === 'queued' || j.status === 'running').length >= CFG.maxJobsPerUser) throw new HttpError(429, 'Too many queued invocations')
    const j = db.insert('fn_jobs', { userId: fn.userId, fnId: fn.id, event: JSON.parse(json), version: tgt.version, alias: tgt.alias, source, status: 'queued', attempts: 0, nextAt: Date.now() })
    return { jobId: j.id, status: 'queued' }
  }
  const BACKOFF = [1000, 4000, 15_000]
  let jobTimer = null
  async function processJob(j) {
    const fn = db.get('fn_functions', j.fnId)
    if (!fn) { db.remove('fn_jobs', j.id); return }
    db.update('fn_jobs', j.id, { status: 'running' })
    try {
      const out = await invokeFunction(fn, { event: j.event, version: j.version, alias: j.alias, trigger: j.source, waitMs: 60_000 })
      if (out.status !== 'ok') throw new Error(out.error?.message ?? out.status)
      db.remove('fn_jobs', j.id)
    } catch (e) {
      const attempts = (j.attempts ?? 0) + 1
      if (attempts >= 3) db.update('fn_jobs', j.id, { status: 'dead', attempts, lastError: String(e.message).slice(0, 300), diedAt: Date.now() })
      else db.update('fn_jobs', j.id, { status: 'queued', attempts, lastError: String(e.message).slice(0, 300), nextAt: Date.now() + BACKOFF[attempts - 1] })
    }
  }
  function tickJobs(now = Date.now()) {
    const due = db.find('fn_jobs', (j) => j.status === 'queued' && j.nextAt <= now).sort((a, b) => a.nextAt - b.nextAt).slice(0, 8)
    for (const j of due) { const fn = db.get('fn_functions', j.fnId); if (fn && !canTake(fn)) continue; processJob(j).catch(() => {}) }
    return due.length
  }
  for (const j of db.find('fn_jobs', (x) => x.status === 'running')) db.update('fn_jobs', j.id, { status: 'queued', nextAt: Date.now() }) // at-least-once across restarts
  jobTimer = setInterval(() => tickJobs(), 500); jobTimer.unref?.()
  r.get('/api/functions/:id/dlq', ({ user, params }) => ({ jobs: by('fn_jobs', 'fnId', own(user, params.id).id).filter((j) => j.status === 'dead').map((j) => ({ id: j.id, event: j.event, attempts: j.attempts, lastError: j.lastError, diedAt: iso(j.diedAt ?? j.createdAt) })) }))
  r.post('/api/functions/:id/dlq/:jobId/retry', ({ user, params }) => {
    const fn = own(user, params.id)
    const j = db.get('fn_jobs', params.jobId)
    if (!j || j.fnId !== fn.id || j.status !== 'dead') throw new HttpError(404, 'Job not found')
    db.update('fn_jobs', j.id, { status: 'queued', attempts: 0, nextAt: Date.now() })
    return { ok: true }
  })
  r.delete('/api/functions/:id/dlq/:jobId', ({ user, params }) => {
    const fn = own(user, params.id)
    const j = db.get('fn_jobs', params.jobId)
    if (!j || j.fnId !== fn.id) throw new HttpError(404, 'Job not found')
    db.remove('fn_jobs', j.id)
    return { ok: true }
  })
  r.get('/api/functions/:id/jobs', ({ user, params }) => ({ jobs: by('fn_jobs', 'fnId', own(user, params.id).id).map((j) => ({ id: j.id, status: j.status, attempts: j.attempts, nextAt: iso(j.nextAt), lastError: j.lastError })) }))

  /* ---- scheduler ---- */
  function tickSchedules(now = Date.now()) {
    let fired = 0
    for (const fn of db.find('fn_functions', (f) => f.schedule?.enabled && f.schedule.nextRunAt && f.schedule.nextRunAt <= now)) {
      let next = null
      try { next = nextCron(parseCron(fn.schedule.cron), now) } catch { /* disable below */ }
      db.update('fn_functions', fn.id, { schedule: { ...fn.schedule, nextRunAt: next, lastRunAt: now, enabled: next !== null } })
      try { enqueue(fn, { source: 'schedule', time: iso(now), ...fn.schedule.event }, resolveTarget(fn, { alias: fn.schedule.alias }), 'schedule'); fired++ } catch (e) { console.error('[functions] schedule enqueue failed:', e.message) }
    }
    return fired
  }
  const schedTimer = setInterval(() => tickSchedules(), 10_000); schedTimer.unref?.()

  /* ---- public HTTP trigger ---- */
  const HEADER_OK = /^(cache-control|content-language|etag|last-modified|location|access-control-allow-origin|access-control-allow-methods|access-control-allow-headers|access-control-max-age|x-[a-z0-9-]{1,60})$/
  const TYPE_OK = /^(text\/(plain|html|css|csv|markdown)|application\/(json|xml)|image\/(svg\+xml|png|jpeg|gif|webp))(;\s*charset=[\w-]+)?$/i
  async function httpTrigger({ params, req, raw, query, auth }) {
    const fn = typeof params.id === 'string' ? db.get('fn_functions', params.id) : null
    if (!fn || !fn.http?.enabled) throw new HttpError(404, 'Not found')
    if (fn.http.auth === 'apiKey' && !(auth && auth.user?.id === fn.userId)) { const e = new HttpError(401, 'Authentication required'); e.headers = { 'www-authenticate': 'Bearer' }; throw e }
    if (raw.length > CFG.httpBodyBytes) throw new HttpError(413, 'Request body too large')
    const text = !raw.length || (!raw.includes(0) && Buffer.from(raw.toString('utf8'), 'utf8').equals(raw))
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) if (!['authorization', 'cookie', 'proxy-authorization'].includes(k)) headers[k] = Array.isArray(v) ? v.join(', ') : String(v)
    const event = { source: 'http', method: req.method, path: `/${params.rest ?? ''}`, query: Object.fromEntries(query.entries()), headers, body: text ? raw.toString('utf8') : raw.toString('base64'), isBase64: !text, requestId: req.headers['x-request-id'] ?? undefined }
    const tgt = resolveTarget(fn, { alias: 'live' })
    const out = await invokeFunction(fn, { event, ...tgt, trigger: 'http', waitMs: 2000 })
    if (out.status !== 'ok') throw new HttpError(out.status === 'timeout' ? 504 : 502, out.status === 'timeout' ? 'Function timed out' : 'Function failed')
    const res = out.result
    const base = { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'referrer-policy': 'no-referrer', 'x-function-request-id': out.requestId }
    if (res && typeof res === 'object' && Number.isInteger(res.statusCode) && res.statusCode >= 100 && res.statusCode <= 599 && ![101, 103].includes(res.statusCode)) {
      const h = { ...base }
      let type = typeof res.body === 'string' && !res.isBase64 ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8'
      let n = 0
      for (const [k, v] of Object.entries(res.headers ?? {})) {
        const key = String(k).toLowerCase(), val = String(v)
        if (/[\r\n\0]/.test(val) || val.length > 1024) continue
        if (key === 'content-type') type = TYPE_OK.test(val) ? val : 'application/octet-stream'
        else if (HEADER_OK.test(key) && ++n <= 20) { if (key === 'location' && !/^(https?:\/\/|\/)/i.test(val)) continue; h[key] = val }
      }
      const bodyBuf = res.isBase64 ? Buffer.from(String(res.body ?? ''), 'base64') : Buffer.from(typeof res.body === 'string' ? res.body : res.body === undefined ? '' : JSON.stringify(res.body))
      return { binary: bodyBuf, type, status: res.statusCode, headers: h }
    }
    return { text: JSON.stringify(res ?? null), type: 'application/json; charset=utf-8', status: 200, headers: base }
  }
  const trig = { public: true, optionalAuth: true, raw: true }
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    r.add(method, '/fn/:id', (rc) => httpTrigger(rc), trig)
    r.add(method, '/fn/:id/*rest', (rc) => httpTrigger(rc), trig)
  }

  /* ---- housekeeping ---- */
  ctx.functions = { isolation, tickJobs, tickSchedules, workers: () => live.size, warmCount, killAll: () => { for (const w of live) w.kill(); warm.clear() }, parseCron, nextCron }
  ctx.quotas?.registerGauge?.('functions.count', (userId) => by('fn_functions', 'userId', userId).length)
  ctx.events.on('shutdown', () => { clearInterval(warmTimer); clearInterval(jobTimer); clearInterval(schedTimer); for (const w of live) w.kill(); try { fs.rmSync(workDir, { recursive: true, force: true }) } catch { /* ignore */ } })
  ctx.events.on('account.deleted', ({ userId }) => {
    for (const fn of by('fn_functions', 'userId', userId)) { for (const x of warm.get(fn.id) ?? []) x.kill(); warm.delete(fn.id) }
    for (const col of ['fn_functions', 'fn_invocations', 'fn_kv', 'fn_jobs']) db.removeWhere(col, (x) => x.userId === userId)
  })
  ;(ctx.scopeRules ??= []).push(['/api/functions', 'compute'])
}
