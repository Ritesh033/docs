// Platform security: response headers (CSP, HSTS, CORS...), central API-key scope enforcement, account export/deletion,
// dev outbox, the standalone password-reset / verify-email page. See docs/security.md.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { HttpError, HANDLED } from '../http.js'
import {
  initAuth, masterKey, requiredScope, scopeAllows, sweep, SERVICES, bodyObj, confirmPassword, confirmSecondFactor, devOutbox,
  trustedHops, publicUser, rateGate, emitAudit, tx, many,
} from '../auth.js'

const APPLIED = Symbol('rd.security.headers')
const REQUEST_ID_OK = /^[A-Za-z0-9._:=+/-]{1,64}$/
const GUARDED = /^\/api\/(auth|account|keys|orgs|audit)(\/|$)/
const MAX_AUTH_BODY = 64 * 1024
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
}
const CORE_COLLECTIONS = ['projects', 'conversations', 'messages', 'artifacts', 'instances', 'buckets', 'objects', 'files', 'shares', 'docs', 'usage']
const NEVER_EXPORT = new Set(['users', 'sessions', 'apiKeys', 'auth_tokens', 'audit_log', 'audit_state'])
const SECRET_FIELDS = /^(password|hash|secret|token|tokenHash|totp|totpPending|recoveryCodes|blobId|blobIds)$/i

const isLoopback = (a = '') => a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.')

/* ----------------------------------------------------------------------------- CSP */

/** Content-Security-Policy builder. Modules may widen it at register time: ctx.csp.add('frame-src', 'blob:'). */
function createCsp() {
  const d = new Map(Object.entries({
    'default-src': ["'none'"],
    'script-src': ["'self'"],
    'style-src': ["'self'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'"],
    'media-src': ["'self'", 'blob:'],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'self'"],
  }))
  return {
    directives: d,
    add(name, ...values) {
      if (!/^[a-z-]+$/.test(name) || values.some((v) => /[;,\s]/.test(v))) throw new Error('invalid CSP directive/value')
      const cur = (d.get(name) ?? []).filter((v) => v !== "'none'")
      d.set(name, [...new Set([...cur, ...values])])
    },
    /** Policy for HTML/JS/CSS served from public/. */
    app: () => [...d].map(([k, v]) => `${k} ${v.join(' ')}`).join('; '),
    /** Policy for API and share responses: nothing may load, nothing may run (a served HTML file is inert). */
    api: () => "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox",
  }
}

/* ----------------------------------------------------------------------------- CORS */

let corsMemo = { raw: null, list: [], any: false }
function corsConfig() {
  const raw = process.env.RD_CORS_ORIGINS ?? ''
  if (raw !== corsMemo.raw) {
    const list = raw.split(',').map((s) => s.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean)
    corsMemo = { raw, list: list.filter((x) => x !== '*'), any: list.includes('*') }
  }
  return corsMemo
}
/** Returns the value for Access-Control-Allow-Origin, or null if the origin is not allowed. */
function corsOrigin(origin) {
  if (!origin || origin.length > 300) return null
  const c = corsConfig()
  if (c.any) return '*'
  return c.list.includes(origin.toLowerCase()) ? origin : null
}

function appendVary(res, value) {
  const cur = res.getHeader('vary')
  if (!cur) return res.setHeader('vary', value)
  if (!String(cur).toLowerCase().split(/\s*,\s*/).includes(value.toLowerCase())) res.setHeader('vary', `${cur}, ${value}`)
}

const isHttps = (req) => !!req.socket?.encrypted
  || (trustedHops() > 0 && String(req.headers['x-forwarded-proto'] ?? '').split(',').pop().trim().toLowerCase() === 'https')
  || process.env.RD_HSTS === '1'

/* ----------------------------------------------------------------------------- module */

export async function register(r, db, ctx) {
  const st = initAuth(ctx)
  masterKey(ctx) // fail fast on a bad RD_SECRET_KEY / unwritable data dir
  const csp = createCsp()
  ctx.csp = csp
  const extraRules = []
  ctx.scopes = {
    services: SERVICES,
    /** Map a path prefix to a service so API-key scopes apply to your module: ctx.scopes.register('/api/widgets', 'compute'). */
    register(prefix, service) {
      if (!/^\/api\/[\w/-]*$/.test(prefix) || !SERVICES.includes(service)) throw new Error('invalid scope rule')
      extraRules.push([prefix.replace(/\/+$/, ''), service])
    },
  }
  let earlyActive = false

  /* ------------------------------------------------------------- headers */
  function secure(rc) {
    const { req, res } = rc
    if (!rc.route) earlyActive = true // the app invoked us before routing: static files get headers without our fallback
    if (res[APPLIED] || res.headersSent) return
    res[APPLIED] = true
    if (!REQUEST_ID_OK.test(rc.requestId ?? '')) {
      rc.requestId = crypto.randomUUID() // never echo/log attacker-controlled ids
      res.setHeader('x-request-id', rc.requestId)
    }
    const pathname = rc.url?.pathname ?? '/'
    const api = pathname.startsWith('/api/')
    const share = pathname.startsWith('/s/')
    const policy = api || share ? csp.api() : csp.app()
    res.setHeader(process.env.RD_CSP_REPORT_ONLY === '1' ? 'content-security-policy-report-only' : 'content-security-policy', policy)
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('x-frame-options', 'DENY')
    res.setHeader('referrer-policy', 'same-origin')
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()')
    res.setHeader('x-permitted-cross-domain-policies', 'none')
    if (!share) res.setHeader('cross-origin-opener-policy', 'same-origin')
    if (api) res.setHeader('cache-control', 'no-store')
    if (!api && !share && !corsConfig().list.length && !corsConfig().any) res.setHeader('cross-origin-resource-policy', 'same-origin')
    if (isHttps(req)) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains')
    const origin = req.headers.origin
    if (origin) {
      appendVary(res, 'Origin')
      const allow = corsOrigin(origin)
      if (allow) {
        res.setHeader('access-control-allow-origin', allow)
        res.setHeader('access-control-expose-headers', 'x-request-id, retry-after, content-disposition')
      }
    }
  }

  ctx.hooks.onRequest ??= []
  ctx.hooks.onRequest.push(secure) // app.js calls these before routing when it supports the early hook (see docs/security.md)

  /* ------------------------------------------------------------- guards (run after auth, before the body is read) */
  const allowedHosts = () => (process.env.RD_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  ctx.hooks.beforeRoute.push(async (rc) => {
    secure(rc)
    const { req, auth, route } = rc
    const hosts = allowedHosts()
    if (hosts.length && !hosts.includes(String(req.headers.host ?? '').toLowerCase())) throw new HttpError(421, 'Unrecognised host')
    const len = Number(req.headers['content-length'] ?? 0)
    if (len > MAX_AUTH_BODY && GUARDED.test(rc.url.pathname)) throw new HttpError(413, 'Payload too large for this endpoint')
    if (auth?.via === 'apiKey') {
      if (route?.meta?.sessionOnly) throw new HttpError(403, 'This action requires an interactive session')
      if (auth.scopes) {
        const need = requiredScope(req.method, rc.url.pathname, extraRules)
        if (need && !scopeAllows(auth.scopes, need)) {
          const want = need.service ? `${need.service}${need.level === 'read' ? ':read' : ''}` : need.level
          throw new HttpError(403, `API key scope insufficient: this endpoint needs "${want}"${need.service ? ` (or "${need.level}")` : ''}`)
        }
      }
    }
  })

  /* ------------------------------------------------------------- routing fallbacks (CORS preflight, static files) */
  const publicDir = path.join(ctx.config?.root ?? path.resolve('.'), 'public')
  const preflight = {
    method: 'OPTIONS', pattern: '/*preflight', public: true, optionalAuth: false, raw: false, stream: true, meta: null,
    handler({ req, res }) {
      const origin = req.headers.origin
      const allow = origin && req.headers['access-control-request-method'] ? corsOrigin(origin) : null
      const headers = { allow: 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS' }
      if (allow) {
        const asked = String(req.headers['access-control-request-headers'] ?? '')
        headers['access-control-allow-methods'] = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS'
        headers['access-control-allow-headers'] = asked.length <= 300 && /^[\w-]+(\s*,\s*[\w-]+){0,15}$/.test(asked) ? asked : 'authorization, content-type, x-request-id'
        headers['access-control-max-age'] = '600'
      }
      res.writeHead(204, headers)
      res.end()
      return HANDLED
    },
  }
  const staticRoute = {
    method: 'GET', pattern: '/*static', public: true, optionalAuth: false, raw: false, stream: false, meta: null,
    handler({ req }) {
      let rel
      const pathname = new URL(req.url, 'http://localhost').pathname // the same parse app.js routes with
      try { rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '') } catch { throw new HttpError(400, 'Bad path') }
      if (rel.includes('\0')) throw new HttpError(400, 'Bad path')
      const file = path.resolve(publicDir, rel)
      let stat
      try { stat = fs.statSync(file) } catch { stat = null }
      if (!file.startsWith(publicDir + path.sep) || !stat?.isFile()) throw new HttpError(404, 'Not found')
      const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
      const headers = { etag, 'cache-control': 'no-cache' }
      if (req.headers['if-none-match'] === etag) return { text: '', status: 304, headers }
      return { binary: fs.readFileSync(file), type: MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', headers }
    },
  }
  const apiNotFound = {
    method: '*', pattern: '/api/*unmatched', public: true, optionalAuth: false, raw: false, stream: true, meta: null,
    handler() { throw new HttpError(404, 'Not found') },
  }
  const origMatch = r.match.bind(r)
  r.match = (method, pathname) => {
    const m = origMatch(method, pathname)
    if (m) return m
    if (method === 'OPTIONS') return { route: preflight, params: {} }
    if (pathname.startsWith('/api/') || pathname === '/api') return { route: apiNotFound, params: {} } // so unknown API paths get the same headers
    // Only HTML documents need a CSP, and a matched route counts toward app.js's per-IP rate limit, so we leave the
    // sub-resources (js/css/images) to app.js's own static handler.
    if (method === 'GET' && !earlyActive && (pathname === '/' || pathname.endsWith('.html')) && process.env.RD_SECURITY_STATIC !== '0') return { route: staticRoute, params: {} }
    return null
  }

  /* ------------------------------------------------------------- dev outbox */
  // Loopback only, and never through a proxy: a reverse proxy on this host would make every visitor look like 127.0.0.1.
  const devOnly = (req) => process.env.RD_DEV_OUTBOX === '1' && isLoopback(req.socket?.remoteAddress) && !req.headers['x-forwarded-for'] && !req.headers.forwarded && !req.headers['x-real-ip']
  r.get('/api/dev/outbox', ({ req, query }) => {
    if (!devOnly(req)) throw new HttpError(404, 'Not found')
    const to = (query.get('to') ?? '').toLowerCase()
    const limit = Math.min(200, Math.max(1, Number(query.get('limit')) || 50))
    return { messages: devOutbox(db).filter((m) => !to || m.to === to).slice(-limit).reverse() }
  }, { public: true, meta: { summary: 'Development mail outbox (RD_DEV_OUTBOX=1, loopback only)' } })
  r.delete('/api/dev/outbox', ({ req }) => {
    if (!devOnly(req)) throw new HttpError(404, 'Not found')
    devOutbox(db).length = 0
    return { ok: true }
  }, { public: true })

  /* ------------------------------------------------------------- account export / deletion */
  const collections = () => [...new Set([...(typeof db.collections === 'function' ? db.collections() : []), ...CORE_COLLECTIONS])]
    .filter((c) => !NEVER_EXPORT.has(c) && !c.startsWith('org_') && !c.startsWith('audit_') && !c.startsWith('auth_'))
  const clean = (v) => {
    if (Array.isArray(v)) return v.map(clean)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET_FIELDS.test(k)).map(([k, x]) => [k, clean(x)]))
    return v
  }

  /** Rows that belong to `uid`: carry userId, or hang off an owned parent (messages -> conversations, shares -> files). */
  function ownedRows(uid) {
    const out = {}
    const convs = new Set(db.find('conversations', (c) => c.userId === uid).map((c) => c.id))
    const files = new Set(db.find('files', (f) => f.userId === uid).map((f) => f.id))
    for (const col of collections()) {
      out[col] = db.find(col, (row) => row.userId === uid
        || (col === 'messages' && convs.has(row.conversationId))
        || (col === 'shares' && files.has(row.fileId)))
    }
    return out
  }

  r.get('/api/account/export', ({ user, auth, requestId, req }) => {
    if (!rateGate(st, `export:${user.id}`, 5, 3_600_000)) throw new HttpError(429, 'Export limit reached (5 per hour)')
    const rows = ownedRows(user.id)
    const data = {
      exportedAt: new Date().toISOString(),
      notes: ['File and object contents (blobs) are not included: download them from Drive / Storage.', 'Credentials (password hash, 2FA secret, key hashes, recovery codes) are never exported.'],
      account: { ...publicUser(db.get('users', user.id)), passwordChangedAt: user.passwordChangedAt ?? null },
      sessions: many(db, 'sessions', 'userId', user.id).map((s) => ({ id: s.id, device: s.device, ip: s.ip, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt })),
      apiKeys: many(db, 'apiKeys', 'userId', user.id).map(({ hash, ...k }) => k),
      organizations: many(db, 'org_members', 'userId', user.id).map((m) => ({ orgId: m.orgId, role: m.role, joinedAt: m.createdAt, name: db.get('org_orgs', m.orgId)?.name ?? null })),
      auditLog: many(db, 'audit_log', 'userId', user.id).map(({ hash, prev, ...e }) => e),
      collections: Object.fromEntries(Object.entries(rows).filter(([, v]) => v.length).map(([k, v]) => [k, v.map(clean)])),
    }
    // Other modules contribute their own collections: ctx.events.on('account.export', ({ userId, add }) => add('fn_functions', rows))
    ctx.events.emit('account.export', { userId: user.id, add(name, list) { if (typeof name === 'string' && Array.isArray(list)) (data.collections[name] ??= []).push(...list.map((x) => (x && typeof x === 'object' ? clean(x) : x))) } })
    emitAudit(ctx, req, requestId, user.id, 'account.export', `user:${user.id}`, { via: auth.via })
    const day = new Date().toISOString().slice(0, 10)
    return { binary: Buffer.from(JSON.stringify(data, null, 2)), type: 'application/json; charset=utf-8', filename: `rd-cloude-export-${day}.json` }
  }, { meta: { summary: 'Download all your data as JSON' } })

  function deleteBlobs(row) {
    for (const id of [row.blobId, ...(row.blobIds ?? []), ...(row.versions ?? []).map((v) => v?.blobId)]) {
      if (typeof id === 'string') { try { db.deleteBlob(id) } catch { /* best effort */ } }
    }
  }

  r.delete('/api/account', async (rc) => {
    if (rc.auth.via !== 'session') throw new HttpError(403, 'Deleting an account requires an interactive session')
    const b = bodyObj(rc.body)
    const u = db.get('users', rc.user.id)
    await confirmPassword(ctx, rc.req, u, b.password)
    confirmSecondFactor(ctx, rc.req, u, b.code) // no-op unless 2FA is enabled
    const vetoes = []
    ctx.events.emit('account.deleting', { userId: u.id, veto: (msg) => vetoes.push(String(msg).slice(0, 300)) })
    if (vetoes.length) throw new HttpError(409, vetoes[0])
    const rows = ownedRows(u.id)
    // Records shared into an organization that keeps other members outlive their creator: they pass to the org owner
    // (the organization, not the leaver, is what owns them). Everything else goes.
    const handover = (x) => {
      const org = typeof x.orgId === 'string' ? db.get('org_orgs', x.orgId) : null
      return org && org.ownerId !== u.id && many(db, 'org_members', 'orgId', org.id).some((m) => m.userId !== u.id) ? org.ownerId : null
    }
    const kept = new Set()
    tx(db, () => { // rows go all-or-nothing; blobs (plain files) are removed after the commit
      for (const [col, list] of Object.entries(rows)) {
        for (const x of list) {
          const heir = handover(x)
          if (heir) { db.update(col, x.id, { userId: heir }); kept.add(x) } else db.remove(col, x.id)
        }
      }
      for (const col of ['sessions', 'apiKeys', 'auth_tokens']) for (const x of many(db, col, 'userId', u.id)) db.remove(col, x.id)
      db.remove('users', u.id)
    })
    for (const list of Object.values(rows)) for (const x of list) if (!kept.has(x)) deleteBlobs(x)
    ctx.events.emit('account.deleted', { userId: u.id, email: u.email })
    return { ok: true }
  }, { meta: { summary: 'Delete the account and all its data (password confirmation)', sessionOnly: true } })

  /* ------------------------------------------------------------- standalone page for reset / verify links */
  const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>RD Cloude account</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/ui/security.css"></head>
<body><main id="root" class="sec-page"></main><script type="module" src="/auth/account.js"></script></body></html>`
  const PAGE_JS = "import { lib } from '/lib.js'\nimport { mountAccountPage } from '/ui/security.js'\nmountAccountPage(document.getElementById('root'), lib)\n"
  r.get('/auth/account', () => ({ text: PAGE, type: 'text/html; charset=utf-8' }), { public: true })
  r.get('/auth/account.js', () => ({ text: PAGE_JS, type: 'text/javascript; charset=utf-8' }), { public: true })

  /* ------------------------------------------------------------- housekeeping */
  const timer = setInterval(() => { try { sweep(db) } catch (e) { console.error('[rd-cloude] sweep failed:', e.message) } }, 10 * 60_000)
  timer.unref?.()
  ctx.events.on('shutdown', () => clearInterval(timer))
}
