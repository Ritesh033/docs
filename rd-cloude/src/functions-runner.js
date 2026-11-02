// Function runner. Executes user code inside a process that the host (src/modules/functions.js) started with:
//   - an EMPTY environment and an empty cwd,
//   - fresh network and PID namespaces (`unshare --net --pid`): no network at all, cannot signal any host process,
//   - the Node permission model (--permission): no fs access except this file, no child processes, no workers, no addons, no process.binding,
//   - address-space / open-file ulimits and a hard wall-clock kill by the host.
// The vm context below only gives user code a tidy global scope; it is NOT the security boundary (vm never is) - the layers above are.
// Protocol: JSON lines. host -> runner: {t:'invoke'|'rpcres'}, runner -> host: {t:'ready'|'result'|'rpc'}. Everything the runner receives
// or sends is treated as untrusted by the host, so a forged message can only affect the invocation of the function that sent it.
import vm from 'node:vm'

const MAX_RESULT = 1024 * 1024
const MAX_LOG_LINES = 200, MAX_LOG_LINE = 2000, MAX_LOG_BYTES = 64 * 1024
const pending = new Map() // rid -> resolve/reject
let current = null // active invocation state
let rseq = 0

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')

/* ------------------------------------------------------------------ logging */
// One console for the lifetime of the process: user code captures it at load time, output is attributed to whichever invocation is active.
const fmt = (args) => args.map((a) => {
  if (typeof a === 'string') return a
  if (a instanceof Error) return `${a.name}: ${a.message}`
  try { return JSON.stringify(a) } catch { return String(a) }
}).join(' ')
const logTo = (level) => (...args) => {
  const inv = current
  if (!inv) return
  if (inv.logs.length >= MAX_LOG_LINES || inv.logBytes >= MAX_LOG_BYTES) { inv.logsTruncated = true; return }
  const line = fmt(args).slice(0, MAX_LOG_LINE)
  inv.logBytes += line.length
  inv.logs.push({ t: Date.now() - inv.start, level, line })
}
const sharedConsole = Object.freeze({ log: logTo('info'), info: logTo('info'), debug: logTo('debug'), warn: logTo('warn'), error: logTo('error') })

/* ------------------------------------------------------------------ brokered capabilities */
function rpc(kind, payload) {
  const inv = current
  if (!inv) return Promise.reject(new Error('No active invocation'))
  return new Promise((resolve, reject) => {
    const rid = ++rseq
    pending.set(rid, { resolve, reject })
    send({ t: 'rpc', id: inv.id, rid, kind, ...payload })
  })
}
const makeKv = () => ({
  get: (key) => rpc('kv', { op: 'get', key: String(key) }),
  set: (key, value) => rpc('kv', { op: 'set', key: String(key), value }),
  delete: (key) => rpc('kv', { op: 'delete', key: String(key) }),
  list: (prefix = '') => rpc('kv', { op: 'list', key: String(prefix) }),
})
function brokeredFetch(url, init = {}) {
  const headers = {}
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[String(k).toLowerCase()] = String(v)
  let body = init.body
  if (body !== undefined && body !== null && typeof body !== 'string') body = JSON.stringify(body)
  return rpc('fetch', { url: String(url), method: String(init.method ?? 'GET').toUpperCase(), headers, body }).then((r) => ({
    ok: r.status >= 200 && r.status < 300, status: r.status, statusText: r.statusText, headers: { get: (n) => r.headers[String(n).toLowerCase()] ?? null, entries: () => Object.entries(r.headers) },
    text: async () => r.body, json: async () => JSON.parse(r.body), url: r.url,
  }))
}

/* ------------------------------------------------------------------ code loading */
const ALLOWED_MODULES = new Set(['crypto', 'util', 'path', 'url', 'querystring', 'string_decoder', 'events', 'assert', 'zlib', 'buffer', 'stream', 'timers', 'perf_hooks'])
function rewrite(code) {
  // light ESM -> CJS convenience: `export default x` and `export [async] function handler`
  return code
    .replace(/^(\s*)export\s+default\s+/m, '$1module.exports = ')
    .replace(/^(\s*)export\s+(async\s+function\s+handler\b)/m, '$1exports.handler = $2')
    .replace(/^(\s*)export\s+(function\s+handler\b)/m, '$1exports.handler = $2')
    .replace(/^(\s*)export\s+const\s+handler\s*=/m, '$1exports.handler =')
}
const loaded = new Map() // code hash + env -> handler (module body runs ONCE per warm process, like a warm Lambda container)
function load(hash, code, env) {
  const key = `${hash}:${JSON.stringify(env)}`
  if (loaded.has(key)) return loaded.get(key)
  const script = new vm.Script(`(function (module, exports, require, process, console, fetch) {\n${rewrite(code)}\n})`, { filename: 'function.js', lineOffset: -1 })
  const fn = script.runInThisContext()
  const frozenEnv = Object.freeze({ ...env })
  const fakeProcess = Object.freeze({ env: frozenEnv, version: process.version, versions: Object.freeze({ node: process.versions.node }), platform: process.platform, arch: process.arch, hrtime: process.hrtime, nextTick: process.nextTick, uptime: () => process.uptime(), cwd: () => '/' })
  const mod = { exports: {} }
  fn(mod, mod.exports, makeRequire(), fakeProcess, sharedConsole, brokeredFetch)
  const handler = pickHandler(mod)
  loaded.set(key, handler)
  if (loaded.size > 10) loaded.delete(loaded.keys().next().value)
  return handler
}
function makeRequire() {
  return (name) => {
    const n = String(name).replace(/^node:/, '')
    if (!ALLOWED_MODULES.has(n)) throw Object.assign(new Error(`Cannot find module '${String(name).slice(0, 60)}' (available: ${[...ALLOWED_MODULES].join(', ')})`), { code: 'MODULE_NOT_FOUND' })
    return process.getBuiltinModule(`node:${n}`)
  }
}
function pickHandler(mod) {
  const e = mod.exports
  if (typeof e === 'function') return e
  if (e && typeof e.handler === 'function') return e.handler
  if (e && typeof e.default === 'function') return e.default
  throw new Error('The function must export a handler: `module.exports = async (event, ctx) => {...}` or `export default async (event, ctx) => {...}`')
}

/* ------------------------------------------------------------------ invocation */
const errInfo = (e) => ({
  name: String(e?.name ?? 'Error').slice(0, 100), message: String(e?.message ?? e).slice(0, 2000),
  stack: String(e?.stack ?? '').split('\n').filter((l) => !l.includes('functions-runner.js') && !l.includes('node:internal')).slice(0, 8).join('\n').slice(0, 2000),
})

async function invoke(msg) {
  const inv = { id: msg.id, start: Date.now(), logs: [], logBytes: 0, deadline: Date.now() + (msg.timeoutMs ?? 3000) }
  current = inv
  const done = (payload) => { current = null; send({ t: 'result', id: inv.id, ms: Date.now() - inv.start, logs: inv.logs, logsTruncated: inv.logsTruncated || undefined, ...payload }) }
  try {
    const handler = load(msg.hash, msg.code, msg.env ?? {})
    const ctx = {
      requestId: msg.ctx.requestId, functionName: msg.ctx.functionName, version: msg.ctx.version, alias: msg.ctx.alias, memoryMb: msg.ctx.memoryMb,
      getRemainingTimeMs: () => Math.max(0, inv.deadline - Date.now()), log: sharedConsole.log, env: Object.freeze({ ...(msg.env ?? {}) }), kv: makeKv(), fetch: brokeredFetch,
    }
    const out = await handler(msg.event, ctx)
    let json
    try { json = JSON.stringify(out === undefined ? null : out) } catch (e) { throw new Error(`The result is not JSON-serialisable: ${e.message}`) }
    if (json === undefined) json = 'null'
    if (json.length > MAX_RESULT) throw new Error(`The result is larger than ${MAX_RESULT} bytes`)
    done({ ok: true, json })
  } catch (e) {
    done({ ok: false, error: errInfo(e) })
  }
}

/* ------------------------------------------------------------------ stdin protocol */
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg?.t === 'invoke') invoke(msg)
    else if (msg?.t === 'rpcres') {
      const p = pending.get(msg.rid)
      if (!p) continue
      pending.delete(msg.rid)
      msg.ok ? p.resolve(msg.value) : p.reject(Object.assign(new Error(String(msg.error ?? 'request failed').slice(0, 500)), { code: msg.code }))
    }
  }
})
process.stdin.on('end', () => process.exit(0))
process.on('uncaughtException', (e) => {
  if (current) { const id = current.id, logs = current.logs; current = null; send({ t: 'result', id, ok: false, ms: 0, logs, error: errInfo(e) }) } else process.exit(1)
})
process.on('unhandledRejection', (e) => {
  if (current) { const id = current.id, logs = current.logs; current = null; send({ t: 'result', id, ok: false, ms: 0, logs, error: errInfo(e) }) }
})
send({ t: 'ready' })
