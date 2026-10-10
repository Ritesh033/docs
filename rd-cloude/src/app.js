import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Router, HttpError, readBody, readJson, sendJson, sendBuffer } from './http.js'
import { createDb } from './db.js'
import { authRoutes, authenticate } from './auth.js'
import { aiRoutes } from './ai.js'
import { cloudRoutes } from './cloud.js'
import { driveRoutes } from './drive.js'
import { billingRoutes } from './billing.js'

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }

// Fixed-window rate limit per client (key or IP): 300 req/min.
const hits = new Map()
function rateLimited(id) {
  const now = Date.now()
  const h = hits.get(id)
  if (!h || now - h.start > 60_000) return hits.set(id, { start: now, n: 1 }), false
  return ++h.n > 300
}

export function createApp({ dataDir } = {}) {
  const db = createDb(dataDir)
  const router = new Router()
  authRoutes(router, db)
  aiRoutes(router, db)
  cloudRoutes(router, db)
  driveRoutes(router, db)
  billingRoutes(router, db)
  router.get('/api/health', () => ({ ok: true, name: 'RD Cloude' }), { public: true })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    try {
      const m = router.match(req.method, url.pathname)
      if (!m) {
        if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res)
        throw new HttpError(404, 'Not found')
      }
      const auth = m.route.public ? null : authenticate(db, req)
      if (!m.route.public && !auth) throw new HttpError(401, 'Authentication required')
      if (rateLimited(auth?.keyId ?? auth?.user.id ?? req.socket.remoteAddress)) throw new HttpError(429, 'Rate limit exceeded')
      const raw = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : Buffer.alloc(0)
      const isRawRoute = /\/objects\/|^\/api\/drive\/files$/.test(url.pathname)
      const body = !isRawRoute && raw.length ? readJson(raw) : {}
      let out = await m.route.handler({ req, res, params: m.params, query: url.searchParams, body, raw, user: auth?.user })
      let status = 200
      if (Array.isArray(out)) [status, out] = out
      if (out?.binary) {
        const extra = out.filename ? { 'content-disposition': `attachment; filename="${encodeURIComponent(out.filename)}"` } : {}
        return sendBuffer(res, status, out.binary, out.type, extra)
      }
      sendJson(res, status, out)
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message })
      console.error(e)
      sendJson(res, 500, { error: 'Internal server error' })
    }
  })
  server.on('close', () => db.flush())
  return { server, db }
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1)
  const file = path.join(PUBLIC_DIR, rel)
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return sendJson(res, 404, { error: 'Not found' })
  sendBuffer(res, 200, fs.readFileSync(file), MIME[path.extname(file)] ?? 'application/octet-stream')
}
