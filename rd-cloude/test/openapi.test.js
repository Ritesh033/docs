// OpenAPI generation (src/modules/openapi.js): structure, auth markers, path templating, grouping and that it never leaks private data.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp } from './helpers.js'
import { buildOpenApi } from '../src/modules/openapi.js'
import { Router } from '../src/http.js'

describe('OpenAPI', () => {
  let t, spec
  before(async () => { t = await startTestApp(); spec = (await t.call('GET', '/api/openapi.json')).data })
  after(() => t.close())

  test('is public, JSON, cacheable and a well-formed 3.1 document', async () => {
    const r = await t.call('GET', '/api/openapi.json')
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /application\/json/)
    assert.match(r.headers.get('cache-control'), /max-age/)
    assert.equal(spec.openapi, '3.1.0')
    assert.ok(spec.info.title && spec.info.version)
    assert.ok(Object.keys(spec.paths).length > 100)
    assert.ok(spec.components.securitySchemes.bearerAuth)
  })

  test('every registered route (except HEAD) appears exactly once with a unique operationId', () => {
    const expected = t.ctx.router.routes.filter((r) => r.method !== 'HEAD').length
    const ops = Object.values(spec.paths).flatMap((p) => Object.values(p))
    assert.equal(ops.length, expected)
    const ids = ops.map((o) => o.operationId)
    assert.equal(new Set(ids).size, ids.length)
  })

  test('path templating, splat parameters and auth markers', () => {
    const get = spec.paths['/api/buckets/{bucket}/objects/{key}'].get
    assert.deepEqual(get.parameters.map((p) => p.name), ['bucket', 'key'])
    assert.ok(get.parameters.every((p) => p.required && p.in === 'path'))
    assert.deepEqual(get.security, [{ bearerAuth: [] }])
    assert.deepEqual(spec.paths['/api/health'].get.security, [], 'public routes declare no security')
    assert.deepEqual(spec.paths['/api/auth/login'].post.security, [])
    assert.ok(spec.paths['/api/me'].get.security.length === 1)
  })

  test('groups routes into services and uses route meta', () => {
    const tags = new Set(spec.tags.map((x) => x.name))
    for (const g of ['Object storage', 'Compute', 'Networking', 'Functions', 'SQL databases', 'Document database', 'Drive', 'Billing', 'AI assistant', 'Monitoring', 'Account & auth']) assert.ok(tags.has(g), `missing group ${g}`)
    assert.ok(spec.paths['/api/openapi.json'].get.summary.includes('OpenAPI'))
    assert.ok(Object.values(spec.paths).flatMap((p) => Object.values(p)).some((o) => o.summary && !/^[A-Z]+ \//.test(o.summary)), 'some summaries come from route meta')
  })

  test('buildOpenApi is pure and handles meta bodies, raw/stream routes and HEAD', () => {
    const r = new Router()
    r.post('/x/:id', () => ({}), { meta: { summary: 'Make X', request: { a: 1 }, response: { ok: true } } })
    r.put('/raw/*key', () => ({}), { raw: true })
    r.get('/pub', () => ({}), { public: true })
    r.add('HEAD', '/pub', () => ({}), { public: true })
    r.get('/maybe', () => ({}), { optionalAuth: true })
    const d = buildOpenApi(r, { version: '9.9.9' })
    assert.equal(d.info.version, '9.9.9')
    assert.deepEqual(d.paths['/x/{id}'].post.requestBody.content['application/json'].example, { a: 1 })
    assert.ok(d.paths['/raw/{key}'].put.requestBody.content['application/octet-stream'])
    assert.equal(d.paths['/pub'].head, undefined)
    assert.deepEqual(d.paths['/maybe'].get.security, [{}, { bearerAuth: [] }], 'optional auth = anonymous or bearer')
  })

  test('contains no user data or secrets', async () => {
    const u = await t.register('openapi-leak@rd.dev')
    const text = JSON.stringify((await t.call('GET', '/api/openapi.json')).data)
    assert.ok(!text.includes(u.token) && !text.includes('openapi-leak@rd.dev'))
  })

  test('the docs page and its assets are served', async () => {
    for (const p of ['/docs.html', '/docs.js', '/docs.css']) assert.equal((await t.call('GET', p)).status, 200, p)
  })
})
