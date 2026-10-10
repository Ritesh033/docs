// RD Cloude entrypoint: validated configuration, graceful shutdown, crash logging.
//
//   PORT                     listen port, 0-65535 (default 3000; 0 picks a free port)
//   HOST                     bind address: IPv4/IPv6 literal or hostname (default: all interfaces)
//   RD_DATA_DIR              data directory (default ./data next to this file)
//   RD_SHUTDOWN_TIMEOUT_MS   how long SIGTERM/SIGINT waits for in-flight requests (default 10000)
//   RD_CRASH_ON_UNHANDLED    1 = treat an unhandled promise rejection as fatal (default: log and continue)
//   RD_FSYNC, RD_FSYNC_INTERVAL_MS, RD_WAL_COMPACT_MIN_BYTES, RD_KEEP_GENERATIONS, RD_LOCK_LEASE_MS, RD_RECOVER, ...
//                            storage engine tuning, see docs/storage-engine.md
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './src/app.js'
import { DbCorruptionError, DbLockedError, resolveConfig as resolveDbConfig } from './src/db.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`)
    this.name = 'ConfigError'
    this.problems = problems
  }
}

const HOSTNAME_RE = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/

function nearestExisting(p) {
  let cur = p
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur)
    if (up === cur) break
    cur = up
  }
  return cur
}

/** Parses and validates the environment. Throws ConfigError listing every problem at once. */
export function parseConfig(env = process.env) {
  const problems = []
  const cfg = {}

  const rawPort = env.PORT
  if (rawPort === undefined || rawPort === '') cfg.port = 3000
  else if (!/^\d{1,5}$/.test(rawPort.trim()) || Number(rawPort) > 65535) { problems.push(`PORT must be an integer between 0 and 65535 (got "${rawPort}")`); cfg.port = 3000 } else cfg.port = Number(rawPort)

  const rawHost = env.HOST
  if (rawHost === undefined || rawHost === '') cfg.host = undefined
  else {
    const h = rawHost.trim().replace(/^\[(.*)\]$/, '$1')
    if (net.isIP(h) || HOSTNAME_RE.test(h)) cfg.host = h
    else problems.push(`HOST must be an IP address or a hostname (got "${rawHost}")`)
  }

  const rawDir = env.RD_DATA_DIR
  if (rawDir !== undefined && rawDir !== '' && rawDir.includes('\0')) problems.push('RD_DATA_DIR must not contain NUL characters')
  else {
    cfg.dataDir = path.resolve(rawDir ? rawDir : path.join(HERE, 'data'))
    try {
      if (fs.existsSync(cfg.dataDir)) {
        if (!fs.statSync(cfg.dataDir).isDirectory()) problems.push(`RD_DATA_DIR ${cfg.dataDir} exists and is not a directory`)
        else fs.accessSync(cfg.dataDir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK)
      } else {
        const anc = nearestExisting(cfg.dataDir)
        if (!fs.statSync(anc).isDirectory()) problems.push(`RD_DATA_DIR ${cfg.dataDir} cannot be created: ${anc} is not a directory`)
        else fs.accessSync(anc, fs.constants.W_OK | fs.constants.X_OK)
      }
    } catch (e) {
      problems.push(`RD_DATA_DIR ${cfg.dataDir} is not usable: ${e.code ?? e.message}`)
    }
  }

  const rawTimeout = env.RD_SHUTDOWN_TIMEOUT_MS
  if (rawTimeout === undefined || rawTimeout === '') cfg.shutdownTimeoutMs = 10_000
  else if (!/^\d{1,6}$/.test(rawTimeout.trim()) || Number(rawTimeout) > 600_000) { problems.push(`RD_SHUTDOWN_TIMEOUT_MS must be an integer between 0 and 600000 (got "${rawTimeout}")`); cfg.shutdownTimeoutMs = 10_000 } else cfg.shutdownTimeoutMs = Number(rawTimeout)

  const crash = (env.RD_CRASH_ON_UNHANDLED ?? '').toLowerCase()
  if (['', '0', 'false', 'no', 'off'].includes(crash)) cfg.crashOnUnhandled = false
  else if (['1', 'true', 'yes', 'on'].includes(crash)) cfg.crashOnUnhandled = true
  else problems.push(`RD_CRASH_ON_UNHANDLED must be 1 or 0 (got "${env.RD_CRASH_ON_UNHANDLED}")`)

  try { resolveDbConfig() } catch (e) { problems.push(e.message) } // storage engine tuning variables

  if (problems.length) throw new ConfigError(problems)
  return cfg
}

const log = (level, msg) => {
  const line = `${new Date().toISOString()} [rd-cloude] ${level.toUpperCase()} ${msg}`
  if (level === 'error' || level === 'warn') console.error(line)
  else console.log(line)
}

async function main() {
  let cfg
  try { cfg = parseConfig() } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    console.error(e.message)
    process.exit(1)
  }

  let shuttingDown = false
  let app = null
  const inflight = new Set()
  const hardExit = (code) => { try { app?.db.flush() } catch { /* best effort */ } process.exit(code) }

  async function shutdown(reason, code = 0) {
    if (shuttingDown) return
    shuttingDown = true
    log('info', `${reason}: shutting down (${inflight.size} request(s) in flight, waiting up to ${cfg.shutdownTimeoutMs}ms)`)
    for (const res of inflight) if (!res.headersSent) res.setHeader('connection', 'close') // keep-alive connections end after their response
    setTimeout(() => { log('error', 'shutdown did not finish in time; forcing exit'); hardExit(code || 1) }, cfg.shutdownTimeoutMs + 5000).unref()
    const server = app?.server
    if (server?.listening) {
      const force = setTimeout(() => { log('warn', `drain timeout: closing ${inflight.size} open request(s)`); server.closeAllConnections() }, cfg.shutdownTimeoutMs)
      const sweep = setInterval(() => server.closeIdleConnections(), 100)
      try { await new Promise((resolve) => server.close(() => resolve())) } catch (e) { log('error', `closing the server failed: ${e.message}`) }
      clearTimeout(force)
      clearInterval(sweep)
    }
    try { app?.db.close() } catch (e) { log('error', `closing the database failed: ${e.stack || e.message}`); code ||= 1 }
    log('info', 'shutdown complete')
    process.exit(code)
  }

  for (const [sig, n] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(sig, () => {
      if (shuttingDown) { log('warn', `${sig} received again: exiting immediately`); hardExit(n) }
      shutdown(sig, 0)
    })
  }
  process.on('uncaughtException', (err) => {
    log('error', `uncaught exception: ${err?.stack || err}`)
    if (shuttingDown) hardExit(1)
    shutdown('uncaughtException', 1)
  })
  let rejections = 0
  process.on('unhandledRejection', (reason) => {
    rejections++
    log('error', `unhandled promise rejection #${rejections}: ${reason?.stack || reason}`)
    if (cfg.crashOnUnhandled && !shuttingDown) shutdown('unhandledRejection', 1)
  })

  try {
    app = await createApp({ dataDir: cfg.dataDir })
  } catch (e) {
    if (e instanceof DbLockedError || e instanceof DbCorruptionError) log('error', e.message)
    else log('error', `startup failed: ${e.stack || e}`)
    process.exit(1)
  }
  const { server } = app
  server.prependListener('request', (req, res) => {
    if (shuttingDown) res.setHeader('connection', 'close')
    inflight.add(res)
    res.once('close', () => inflight.delete(res))
  })
  server.once('error', (e) => {
    if (e.syscall !== 'listen') return
    log('error', e.code === 'EADDRINUSE' ? `port ${cfg.port} is already in use` : e.code === 'EACCES' ? `no permission to listen on port ${cfg.port}` : `cannot listen: ${e.message}`)
    try { app.db.close() } catch { /* ignore */ }
    process.exit(1)
  })
  const onListening = () => {
    const port = server.address().port
    const shown = !cfg.host || cfg.host === '0.0.0.0' || cfg.host === '::' ? 'localhost' : cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host
    console.log(`RD Cloude running on http://${shown}:${port}`)
    log('info', `data directory ${cfg.dataDir}`)
  }
  if (cfg.host) server.listen(cfg.port, cfg.host, onListening)
  else server.listen(cfg.port, onListening)
}

let isMain = false
try { isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { /* not the entrypoint */ }
if (isMain) await main()
