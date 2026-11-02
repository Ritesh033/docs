// OpenAPI 3.1 description generated from the router: GET /api/openapi.json (public, cached after first use; it lists structure only).
// Each route's `meta` ({summary, description, request, response}) comes from the module that owns it. Browsable at /docs.html.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const toOpenApiPath = (pattern) => pattern.replace(/\/\*(\w+)/g, '/{$1}').replace(/:(\w+)/g, '{$1}')
// First path segment -> the service group shown in the API reference (anything unlisted keeps its own segment name).
const GROUPS = {
  auth: 'Account & auth', me: 'Account & auth', account: 'Account & auth', keys: 'Account & auth', orgs: 'Organizations', audit: 'Audit log',
  ai: 'AI assistant', conversations: 'AI assistant', projects: 'AI assistant', artifacts: 'AI assistant', prompts: 'AI assistant', search: 'AI assistant', shared: 'AI assistant', share: 'AI assistant', models: 'AI assistant', preview: 'AI assistant',
  buckets: 'Object storage', storage: 'Object storage', presigned: 'Object storage', site: 'Object storage',
  compute: 'Compute', network: 'Networking', functions: 'Functions', fn: 'Functions', db: 'Document database', sql: 'SQL databases',
  drive: 'Drive', s: 'Drive', pub: 'Drive', public: 'Drive',
  billing: 'Billing', plans: 'Billing', notifications: 'Notifications',
  monitoring: 'Monitoring', metrics: 'Monitoring', status: 'Monitoring', health: 'Monitoring', live: 'Monitoring', ready: 'Monitoring',
  openapi: 'System', 'openapi.json': 'System', 'ui-modules': 'System', dev: 'System',
}
const tagOf = (pattern) => {
  const seg = pattern.split('/').filter(Boolean)
  const first = (seg[0] === 'api' ? seg[1] : seg[0])?.replace(/[:{}*]/g, '') || 'root'
  return GROUPS[first] ?? first
}

export function buildOpenApi(router, { version = '0.0.0' } = {}) {
  const paths = {}
  const tags = new Set()
  for (const r of router.routes) {
    if (r.method === 'HEAD') continue                   // HEAD mirrors GET
    const p = toOpenApiPath(r.pattern)
    const tag = tagOf(r.pattern)
    tags.add(tag)
    const params = [...r.pattern.matchAll(/\/\*(\w+)|:(\w+)/g)].map((m) => ({
      name: m[1] ?? m[2], in: 'path', required: true, schema: { type: 'string' },
      ...(m[1] ? { description: 'May contain slashes (not URL-encoded as a single segment).' } : {}),
    }))
    const op = {
      operationId: `${r.method.toLowerCase()}_${p.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      tags: [tag],
      summary: r.meta?.summary ?? `${r.method} ${p}`,
      ...(r.meta?.description ? { description: r.meta.description } : {}),
      ...(params.length ? { parameters: params } : {}),
      security: r.public ? [] : r.optionalAuth ? [{}, { bearerAuth: [] }] : [{ bearerAuth: [] }],
      responses: {
        [r.method === 'POST' ? '2XX' : '200']: { description: 'Success', ...(r.meta?.response ? { content: { 'application/json': { example: r.meta.response } } } : {}) },
        default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && (r.meta?.request || r.raw || r.stream)) {
      op.requestBody = { required: false, content: r.meta?.request && !r.raw && !r.stream ? { 'application/json': { example: r.meta.request } } : { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }
    }
    if (r.stream) op['x-rd-streaming'] = true
    ;(paths[p] ??= {})[r.method.toLowerCase()] = op
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'RD Cloude API', version,
      description: 'AI assistant, cloud infrastructure and drive. Authenticate with an Authorization: Bearer header carrying a session token or an rdk_ API key. API keys can be limited to services and read/write scopes.',
    },
    servers: [{ url: '/' }],
    tags: [...tags].sort().map((name) => ({ name })),
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Session token (from /api/auth/login) or API key (rdk_…).' } },
      schemas: { Error: { type: 'object', required: ['error'], properties: { error: { type: 'string' }, errors: { type: 'array', items: { type: 'string' } } } } },
    },
  }
}

export function register(r, _db, ctx) {
  let version = '0.0.0'
  try { version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version } catch { /* keep default */ }
  let cached = null
  r.get('/api/openapi.json', () => {
    cached ??= JSON.stringify(buildOpenApi(ctx.router ?? r, { version }))
    return { text: cached, type: 'application/json; charset=utf-8', headers: { 'cache-control': 'public, max-age=60' } }
  }, { public: true, meta: { summary: 'OpenAPI 3.1 description of every route (generated from the router)' } })
}
