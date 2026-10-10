import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Router, HttpError, HANDLED, readBody, readJson, sendJson, sendBuffer, sendText } from './http.js'
import { createDb } from './db.js'
import { authRoutes, authenticate } from './auth.js'
import { aiRoutes } from './ai.js'
import { driveRoutes } from './drive.js'
import { billingRoutes } from './billing.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_DIR = path.join(ROOT, 'public')
const MODULES_DIR = path.join(ROOT, 'src', 'modules')
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
}

// Fixed-window rate limit per client (key or IP): 300 req/min.
const hits = new Map()
function rateLimited(id) {
  const now = Date.now()
  const h = hits.get(id)
  if (!h || now - h.start > 60_000) return hits.set(id, { start: now, n: 1 }), false
  return ++h.n > 300
}

const BASE_SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
}

/**
 * Build the application. Feature modules in src/modules/*.js are auto-loaded and must export
 * `register(router, db, ctx)` (may be async). ctx = { db, router, events, hooks, config, HANDLED }.
 * See docs/ARCHITECTURE.md.
 */
export async function createApp({ dataDir, strictModules = process.env.RD_STRICT_MODULES === '1' } = {}) {
  const db = createDb(dataDir)
  const router = new Router()
  const events = new EventEmitter()
  events.setMaxListeners(100)
  const hooks = { beforeRoute: [], onRequestEnd: [] }
  const ctx = { db, router, events, hooks, config: { dataDir, root: ROOT }, HANDLED, startedAt: new Date().toISOString() }

  authRoutes(router, db)
  aiRoutes(router, db, ctx)
  driveRoutes(router, db, ctx)
  billingRoutes(router, db, ctx)
  router.get('/api/health', () => ({ ok: true, name: 'RD Cloude' }), { public: true })
  router.get('/api/ui-modules', () => {
    const dir = path.join(PUBLIC_DIR, 'ui')
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
    return { modules: files.filter((f) => f.endsWith('.js')), styles: files.filter((f) => f.endsWith('.css')) }
  }, { public: true })

  const loadErrors = []
  if (fs.existsSync(MODULES_DIR)) {
    for (const f of fs.readdirSync(MODULES_DIR).filter((f) => f.endsWith('.js')).sort()) {
      try {
        const mod = await import(pathToFileURL(path.join(MODULES_DIR, f)).href)
        if (typeof mod.register !== 'function') throw new Error('module must export register(router, db, ctx)')
        await mod.register(router, db, ctx)
      } catch (e) {
        if (strictModules) throw new Error(`Failed to load module ${f}: ${e.stack || e.message}`)
        loadErrors.push({ module: f, error: e.message })
        console.error(`[rd-cloude] module ${f} failed to load: ${e.message}`)
      }
    }
  }
  ctx.loadErrors = loadErrors

  const server = http.createServer(async (req, res) => {
    const started = process.hrtime.bigint()
    const requestId = req.headers['x-request-id']?.toString().slice(0, 64) || crypto.randomUUID()
    res.setHeader('x-request-id', requestId)
    for (const [k, v] of Object.entries(BASE_SECURITY_HEADERS)) res.setHeader(k, v)
    const url = new URL(req.url, 'http://localhost')
    const rc = { req, res, url, requestId, user: null, auth: null, route: null, params: {} }
    res.on('finish', () => {
      const info = { ...rc, status: res.statusCode, durationMs: Number(process.hrtime.bigint() - started) / 1e6, pattern: rc.route?.pattern ?? null }
      for (const fn of hooks.onRequestEnd) { try { fn(info) } catch (e) { console.error('[rd-cloude] onRequestEnd hook failed:', e.message) } }
    })
    try {
      const m = router.match(req.method, url.pathname)
      if (!m) {
        if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res)
        throw new HttpError(404, 'Not found')
      }
      rc.route = m.route
      rc.params = m.params
      let auth = null
      if (!m.route.public || m.route.optionalAuth) auth = authenticate(db, req)
      if (!m.route.public && !auth) throw new HttpError(401, 'Authentication required')
      rc.auth = auth
      rc.user = auth?.user ?? null
      if (rateLimited(auth?.keyId ?? auth?.user.id ?? req.socket.remoteAddress)) throw new HttpError(429, 'Rate limit exceeded')
      for (const fn of hooks.beforeRoute) await fn(rc)
      const hasBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !m.route.stream
      const raw = hasBody ? await readBody(req) : Buffer.alloc(0)
      const body = !m.route.raw && !m.route.stream && raw.length ? readJson(raw) : {}
      let out = await m.route.handler({
        req, res, params: m.params, query: url.searchParams, body, raw, user: rc.user, auth, requestId, ctx,
      })
      if (out === HANDLED) return
      let status = 200
      if (Array.isArray(out)) [status, out] = out
      if (out?.redirect) { res.writeHead(out.status ?? 302, { location: out.redirect }); return res.end() }
      if (out?.binary) {
        const extra = { ...(out.filename ? { 'content-disposition': `attachment; filename="${encodeURIComponent(out.filename)}"` } : {}), ...out.headers }
        return sendBuffer(res, out.status ?? status, out.binary, out.type, extra)
      }
      if (typeof out?.text === 'string') return sendText(res, out.status ?? status, out.text, out.type, out.headers)
      sendJson(res, status, out)
    } catch (e) {
      if (res.headersSent) return res.end()
      if (e instanceof HttpError) {
        if (e.headers) for (const [k, v] of Object.entries(e.headers)) res.setHeader(k, v)
        return sendJson(res, e.status, { error: e.message })
      }
      console.error(e)
      sendJson(res, 500, { error: 'Internal server error' })
    }
  })
  server.on('close', () => { events.emit('shutdown'); db.flush() })
  return { server, db, ctx }
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
  const file = path.resolve(PUBLIC_DIR, rel)
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return sendJson(res, 404, { error: 'Not found' })
  sendBuffer(res, 200, fs.readFileSync(file), MIME[path.extname(file)] ?? 'application/octet-stream')
}
