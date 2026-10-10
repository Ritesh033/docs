import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'

let server, base, token
const call = async (method, path, { body, raw, headers = {}, auth = token } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  })
  const type = res.headers.get('content-type') || ''
  return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) }
}

before(async () => {
  delete process.env.ANTHROPIC_API_KEY
  ;({ server } = createApp())
  await new Promise((r) => server.listen(0, r))
  base = `http://localhost:${server.address().port}`
  const r = await call('POST', '/api/auth/register', { body: { email: 'a@rd.dev', password: 'password123' }, auth: null })
  token = r.data.token
})
after(() => server.close())

test('auth: rejects anonymous, bad login, duplicate email', async () => {
  assert.equal((await call('GET', '/api/me', { auth: null })).status, 401)
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'a@rd.dev', password: 'wrong-pass' }, auth: null })).status, 401)
  assert.equal((await call('POST', '/api/auth/register', { body: { email: 'a@rd.dev', password: 'password123' }, auth: null })).status, 409)
  assert.equal((await call('GET', '/api/me')).data.user.email, 'a@rd.dev')
})

test('api keys authenticate and can be revoked', async () => {
  const { data } = await call('POST', '/api/keys', { body: { name: 'ci' } })
  assert.match(data.secret, /^rdk_/)
  assert.equal((await call('GET', '/api/me', { auth: data.secret })).status, 200)
  await call('DELETE', `/api/keys/${data.key.id}`)
  assert.equal((await call('GET', '/api/me', { auth: data.secret })).status, 401)
})

test('chat: conversation, project instructions, artifacts, usage metering', async () => {
  const p = (await call('POST', '/api/projects', { body: { name: 'P', instructions: 'Be brief' } })).data
  const c = (await call('POST', '/api/conversations', { body: { projectId: p.id } })).data
  const m = await call('POST', `/api/conversations/${c.id}/messages`, { body: { content: 'hello' } })
  assert.equal(m.status, 201)
  assert.match(m.data.assistantMessage.content, /RD Cloude/)
  assert.equal((await call('GET', `/api/conversations/${c.id}`)).data.messages.length, 2)
  const usage = (await call('GET', '/api/billing/usage')).data
  assert.ok(usage.lines.some((l) => l.kind === 'ai.input_tokens' && l.qty > 0))

  const a = (await call('POST', '/api/artifacts', { body: { title: 'x', content: 'v1' } })).data
  const upd = (await call('PUT', `/api/artifacts/${a.id}`, { body: { content: 'v2' } })).data
  assert.equal(upd.versions.length, 1)
})

test('compute lifecycle and invalid transitions', async () => {
  const i = (await call('POST', '/api/compute/instances', { body: { name: 'web', type: 'medium' } })).data
  assert.equal(i.state, 'running')
  assert.equal((await call('POST', `/api/compute/instances/${i.id}/start`)).status, 409)
  assert.equal((await call('POST', `/api/compute/instances/${i.id}/stop`)).data.state, 'stopped')
  assert.equal((await call('POST', `/api/compute/instances/${i.id}/terminate`)).data.state, 'terminated')
  assert.equal((await call('POST', '/api/compute/instances', { body: { name: 'x', type: 'huge' } })).status, 400)
})

test('buckets: upload, download, delete rules', async () => {
  assert.equal((await call('POST', '/api/buckets', { body: { name: 'My_Bucket' } })).status, 400)
  assert.equal((await call('POST', '/api/buckets', { body: { name: 'photos-1' } })).status, 201)
  const up = await call('PUT', '/api/buckets/photos-1/objects/2026/a.txt', { raw: 'hello', headers: { 'content-type': 'text/plain' } })
  assert.equal(up.status, 201)
  assert.equal((await call('GET', '/api/buckets/photos-1/objects/2026/a.txt')).data.toString(), 'hello')
  assert.equal((await call('GET', '/api/buckets/photos-1/objects?prefix=2026/')).data.objects.length, 1)
  assert.equal((await call('DELETE', '/api/buckets/photos-1')).status, 409)
  await call('DELETE', '/api/buckets/photos-1/objects/2026/a.txt')
  assert.equal((await call('DELETE', '/api/buckets/photos-1')).status, 200)
})

test('document db CRUD and query', async () => {
  const d = (await call('POST', '/api/db/todos', { body: { title: 't', done: false } })).data
  assert.equal((await call('POST', '/api/db/todos/query', { body: { where: { done: false } } })).data.documents.length, 1)
  await call('PUT', `/api/db/todos/${d.id}`, { body: { title: 't', done: true } })
  assert.equal((await call('GET', `/api/db/todos/${d.id}`)).data.data.done, true)
  assert.equal((await call('DELETE', `/api/db/todos/${d.id}`)).status, 200)
})

test('drive: versions and public share link', async () => {
  const f1 = await call('PUT', '/api/drive/files?name=n.txt', { raw: 'one', headers: { 'content-type': 'text/plain' } })
  const f2 = await call('PUT', '/api/drive/files?name=n.txt', { raw: 'two!', headers: { 'content-type': 'text/plain' } })
  assert.equal(f1.status, 201)
  assert.equal(f2.data.versionCount, 2)
  const id = f2.data.id
  assert.equal((await call('GET', `/api/drive/files/${id}?version=1`)).data.toString(), 'one')
  const share = (await call('POST', `/api/drive/files/${id}/share`)).data
  assert.equal((await call('GET', share.url, { auth: null })).data.toString(), 'two!')
  await call('DELETE', `/api/drive/shares/${share.token}`)
  assert.equal((await call('GET', share.url, { auth: null })).status, 404)
})

test('tenant isolation', async () => {
  const other = (await call('POST', '/api/auth/register', { body: { email: 'b@rd.dev', password: 'password123' }, auth: null })).data.token
  const a = (await call('POST', '/api/artifacts', { body: { title: 'secret', content: 's' } })).data
  assert.equal((await call('GET', `/api/artifacts/${a.id}`, { auth: other })).status, 404)
  assert.equal((await call('POST', '/api/buckets', { body: { name: 'photos-1' }, auth: other })).status, 201)
})
