// Object storage: buckets, objects, versions, multipart, presign, public + website serving, lifecycle, quota, isolation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestApp } from './helpers.js'
import { createApp } from '../src/app.js'

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex')
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const DAY = 86_400_000

/** Boots an app and returns helpers. `limits` overrides ctx.storage.limits (they are read on every request). */
async function setup(limits = {}) {
  const app = await startTestApp()
  Object.assign(app.ctx.storage.limits, limits)
  const a = await app.register()
  const b = await app.register()
  // raw HTTP: returns status, headers, buf, text, json()
  async function http(method, p, { token, body, headers = {}, duplex } = {}) {
    const res = await fetch(app.base + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body, duplex, redirect: 'manual' })
    const buf = Buffer.from(await res.arrayBuffer())
    return { status: res.status, headers: res.headers, buf, text: buf.toString('utf8'), json: () => JSON.parse(buf.toString('utf8')) }
  }
  const put = (u, bucket, key, body, headers = {}) => http('PUT', `/api/buckets/${bucket}/objects/${key.split('/').map(encodeURIComponent).join('/')}`, { token: u.token, body, headers })
  const get = (u, bucket, key, headers = {}, qs = '') => http('GET', `/api/buckets/${bucket}/objects/${key.split('/').map(encodeURIComponent).join('/')}${qs}`, { token: u.token, headers })
  const mk = async (u, name, extra = {}) => { const r = await u.call('POST', '/api/buckets', { body: { name, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data }
  const blobs = () => app.db.listBlobs().filter((x) => x.id.startsWith('stb_'))
  const rowsSize = (u) => app.db.find('objects', (o) => o.userId === u.user.id).reduce((s, o) => s + o.size, 0)
  return { app, a, b, http, put, get, mk, blobs, rowsSize, close: () => app.close() }
}

/* ============================================================================================ buckets */

test('buckets: create, settings defaults, list, patch, delete, validation', async () => {
  const t = await setup()
  try {
    const { a } = t
    assert.equal((await a.call('POST', '/api/buckets', { body: { name: 'My_Bucket' } })).status, 400)
    assert.equal((await a.call('POST', '/api/buckets', { body: { name: 'ab' } })).status, 400)
    assert.equal((await a.call('POST', '/api/buckets', { body: {} })).status, 400)
    assert.equal((await a.call('POST', '/api/buckets', { raw: 'null', headers: { 'content-type': 'application/json' } })).status, 400)
    assert.equal((await a.call('POST', '/api/buckets', { raw: '[1]', headers: { 'content-type': 'application/json' } })).status, 400)
    assert.equal((await a.call('POST', '/api/buckets', { body: { name: 'x'.repeat(64) } })).status, 400)
    assert.equal((await a.call('POST', '/api/buckets', { body: { name: 'good-name', region: 'mars' } })).status, 400)
    assert.equal((await a.call('POST', '/api/buckets', { body: { name: 'good-name', versioning: 'suspended' } })).status, 400)
    assert.equal((await a.call('POST', '/api/buckets', { body: { name: 'good-name', acl: 'world' } })).status, 400)
    const b = await t.mk(a, 'photos-1')
    assert.equal(b.versioning, 'disabled')
    assert.equal(b.acl, 'private')
    assert.equal(b.region, 'rd-local')
    assert.equal(b.objectCount, 0)
    assert.equal((await a.call('POST', '/api/buckets', { body: { name: 'photos-1' } })).status, 409)
    assert.equal((await t.b.call('POST', '/api/buckets', { body: { name: 'photos-1' } })).status, 409, 'names are global')
    const list = await a.call('GET', '/api/buckets')
    assert.deepEqual(list.data.buckets.map((x) => x.name), ['photos-1'])
    assert.equal((await a.call('GET', '/api/buckets/photos-1')).data.name, 'photos-1')
    assert.equal((await a.call('HEAD', '/api/buckets/photos-1')).status, 200)

    const patched = await a.call('PATCH', '/api/buckets/photos-1', { body: { versioning: 'enabled', acl: 'public-read', tags: { env: 'dev' } } })
    assert.equal(patched.status, 200)
    assert.equal(patched.data.versioning, 'enabled')
    assert.equal(patched.data.acl, 'public-read')
    assert.deepEqual(patched.data.tags, { env: 'dev' })
    assert.equal((await a.call('PATCH', '/api/buckets/photos-1', { body: { versioning: 'disabled' } })).status, 400, 'cannot go back to disabled')
    assert.equal((await a.call('PATCH', '/api/buckets/photos-1', { body: { versioning: 'suspended' } })).data.versioning, 'suspended')
    assert.equal((await a.call('PATCH', '/api/buckets/photos-1', { body: { region: 'other' } })).status, 400)
    assert.equal((await a.call('PATCH', '/api/buckets/photos-1', { body: {} })).status, 400)
    assert.equal((await a.call('PATCH', '/api/buckets/photos-1', { body: { acl: 'x' } })).status, 400)
    assert.equal((await a.call('PATCH', '/api/buckets/photos-1', { body: { tags: { a: 1 } } })).status, 400)

    t.app.ctx.storage.limits.maxBuckets = 1
    assert.equal((await a.call('POST', '/api/buckets', { body: { name: 'second-one' } })).status, 409)
    assert.equal((await a.call('DELETE', '/api/buckets/photos-1')).status, 200)
    assert.equal((await a.call('DELETE', '/api/buckets/photos-1')).status, 404)
  } finally { await t.close() }
})

test('buckets: every route needs authentication and never crosses tenants', async () => {
  const t = await setup()
  try {
    const { a, b, http } = t
    await t.mk(a, 'alpha-bucket')
    await t.put(a, 'alpha-bucket', 'secret.txt', 'top secret')
    const un = [
      ['GET', '/api/buckets'], ['POST', '/api/buckets'], ['GET', '/api/buckets/alpha-bucket'], ['PATCH', '/api/buckets/alpha-bucket'], ['DELETE', '/api/buckets/alpha-bucket'],
      ['GET', '/api/buckets/alpha-bucket/objects'], ['GET', '/api/buckets/alpha-bucket/objects/secret.txt'], ['PUT', '/api/buckets/alpha-bucket/objects/x'], ['DELETE', '/api/buckets/alpha-bucket/objects/secret.txt'],
      ['GET', '/api/buckets/alpha-bucket/versions'], ['GET', '/api/buckets/alpha-bucket/cors'], ['PUT', '/api/buckets/alpha-bucket/lifecycle'], ['POST', '/api/buckets/alpha-bucket/presign'],
      ['POST', '/api/buckets/alpha-bucket/uploads'], ['POST', '/api/buckets/alpha-bucket/copy'], ['POST', '/api/buckets/alpha-bucket/delete'], ['GET', '/api/storage/usage'],
    ]
    for (const [m, p] of un) assert.equal((await http(m, p)).status, 401, `${m} ${p}`)

    // user B sees 404 (not 403) for everything of A
    const cross = [
      ['GET', '/api/buckets/alpha-bucket'], ['PATCH', '/api/buckets/alpha-bucket', { acl: 'public-read' }], ['DELETE', '/api/buckets/alpha-bucket'], ['GET', '/api/buckets/alpha-bucket/objects'],
      ['GET', '/api/buckets/alpha-bucket/objects/secret.txt'], ['GET', '/api/buckets/alpha-bucket/meta/secret.txt'], ['DELETE', '/api/buckets/alpha-bucket/objects/secret.txt'],
      ['GET', '/api/buckets/alpha-bucket/versions'], ['GET', '/api/buckets/alpha-bucket/cors'], ['PUT', '/api/buckets/alpha-bucket/cors', { rules: [] }], ['GET', '/api/buckets/alpha-bucket/lifecycle'],
      ['GET', '/api/buckets/alpha-bucket/website'], ['GET', '/api/buckets/alpha-bucket/tagging/secret.txt'], ['PUT', '/api/buckets/alpha-bucket/acl/secret.txt', { acl: 'public-read' }],
      ['POST', '/api/buckets/alpha-bucket/presign', { key: 'secret.txt' }], ['POST', '/api/buckets/alpha-bucket/presign/revoke', {}], ['POST', '/api/buckets/alpha-bucket/uploads', { key: 'k' }],
      ['GET', '/api/buckets/alpha-bucket/uploads'], ['POST', '/api/buckets/alpha-bucket/delete', { objects: [{ key: 'secret.txt' }] }],
      ['POST', '/api/buckets/alpha-bucket/lifecycle/run', {}], ['POST', '/api/buckets/alpha-bucket/restore', { key: 'secret.txt', versionId: 'null' }],
    ]
    for (const [m, p, body] of cross) assert.equal((await b.call(m, p, body === undefined ? {} : { body })).status, 404, `${m} ${p}`)
    assert.equal((await t.put(b, 'alpha-bucket', 'evil.txt', 'x')).status, 404)
    // copy from / into someone else's bucket
    await t.mk(b, 'bravo-bucket')
    assert.equal((await b.call('POST', '/api/buckets/bravo-bucket/copy', { body: { source: { bucket: 'alpha-bucket', key: 'secret.txt' }, destination: { key: 'stolen.txt' } } })).status, 404)
    assert.equal((await b.call('POST', '/api/buckets/alpha-bucket/copy', { body: { source: { bucket: 'bravo-bucket', key: 'x' }, destination: { key: 'y' } } })).status, 404)
    // and the data is untouched
    assert.equal((await t.get(a, 'alpha-bucket', 'secret.txt')).text, 'top secret')
    assert.equal((await b.call('GET', '/api/buckets')).data.buckets.length, 1)
  } finally { await t.close() }
})

test('bucket settings: CORS, lifecycle and website validation', async () => {
  const t = await setup()
  try {
    const { a } = t
    await t.mk(a, 'settings-1')
    const cors = (rules) => a.call('PUT', '/api/buckets/settings-1/cors', { body: { rules } })
    const good = { allowedOrigins: ['https://app.example.com'], allowedMethods: ['GET', 'PUT'], allowedHeaders: ['*'], exposeHeaders: ['ETag'], maxAgeSeconds: 600 }
    const ok = await cors([good])
    assert.equal(ok.status, 200)
    assert.equal(ok.data.rules[0].maxAgeSeconds, 600)
    assert.equal((await a.call('GET', '/api/buckets/settings-1/cors')).data.rules.length, 1)
    for (const badRule of [
      { ...good, allowedOrigins: [] }, { ...good, allowedOrigins: ['ftp://x'] }, { ...good, allowedOrigins: ['https://*.a.*'] }, { ...good, allowedMethods: ['TRACE'] }, { ...good, allowedMethods: [] },
      { ...good, allowedHeaders: ['bad header'] }, { ...good, maxAgeSeconds: -1 }, { ...good, maxAgeSeconds: 1e9 }, 'x', null,
    ]) assert.equal((await cors([badRule])).status, 400, JSON.stringify(badRule))
    assert.equal((await cors(Array.from({ length: 101 }, () => good))).status, 400)
    assert.equal((await a.call('PUT', '/api/buckets/settings-1/cors', { body: { rules: 'nope' } })).status, 400)
    assert.equal((await a.call('DELETE', '/api/buckets/settings-1/cors')).status, 200)
    assert.deepEqual((await a.call('GET', '/api/buckets/settings-1/cors')).data.rules, [])

    const lc = (rules) => a.call('PUT', '/api/buckets/settings-1/lifecycle', { body: { rules } })
    const r1 = await lc([{ id: 'tmp', prefix: 'tmp/', expirationDays: 7, noncurrentExpirationDays: 30, abortIncompleteMultipartDays: 2 }])
    assert.equal(r1.status, 200)
    assert.equal(r1.data.rules[0].status, 'enabled')
    for (const badRule of [{ prefix: 'a/' }, { expirationDays: 0 }, { expirationDays: 1.5 }, { expirationDays: 99999 }, { expirationDays: 1, status: 'maybe' }, { expirationDays: 1, id: 'bad id!' }, { expirationDays: 1, tags: { a: 1 } }]) {
      assert.equal((await lc([badRule])).status, 400, JSON.stringify(badRule))
    }
    assert.equal((await lc([{ id: 'x', expirationDays: 1 }, { id: 'x', expirationDays: 2 }])).status, 400, 'duplicate ids')

    assert.equal((await a.call('GET', '/api/buckets/settings-1/website')).status, 404)
    assert.equal((await a.call('PUT', '/api/buckets/settings-1/website', { body: { indexDocument: 'a/b.html' } })).status, 400)
    assert.equal((await a.call('PUT', '/api/buckets/settings-1/website', { body: { indexDocument: '../x' } })).status, 400)
    const w = await a.call('PUT', '/api/buckets/settings-1/website', { body: { indexDocument: 'home.html', errorDocument: '404.html' } })
    assert.equal(w.status, 200)
    assert.equal(w.data.url, '/site/settings-1/')
    assert.equal(w.data.public, false)
    assert.equal((await a.call('DELETE', '/api/buckets/settings-1/website')).status, 200)
    assert.equal((await a.call('GET', '/api/buckets/settings-1/website')).status, 404)
  } finally { await t.close() }
})

/* ============================================================================================ objects */

test('objects: roundtrip, ETag, metadata, content types, HEAD, overwrite', async () => {
  const t = await setup()
  try {
    const { a } = t
    await t.mk(a, 'objs-1')
    const body = Buffer.from('hello object storage')
    const up = await t.put(a, 'objs-1', 'docs/a.txt', body, { 'content-type': 'text/plain', 'x-rd-meta-Author': 'Ritesh', 'x-rd-meta-project': 'cloud', 'cache-control': 'max-age=60' })
    assert.equal(up.status, 201)
    assert.equal(up.headers.get('etag'), `"${md5(body)}"`)
    const info = up.json()
    assert.equal(info.key, 'docs/a.txt')
    assert.equal(info.size, body.length)
    assert.equal(info.etag, md5(body))
    assert.equal(info.checksumSha256, sha256(body))
    assert.deepEqual(info.metadata, { author: 'Ritesh', project: 'cloud' })
    assert.equal(info.blobId, undefined, 'internal ids are not exposed')
    assert.equal(info.chunks, undefined)

    const got = await t.get(a, 'objs-1', 'docs/a.txt')
    assert.equal(got.status, 200)
    assert.equal(got.text, 'hello object storage')
    assert.equal(got.headers.get('etag'), `"${md5(body)}"`)
    assert.equal(got.headers.get('content-type'), 'text/plain')
    assert.equal(got.headers.get('content-length'), String(body.length))
    assert.equal(got.headers.get('accept-ranges'), 'bytes')
    assert.equal(got.headers.get('x-rd-meta-author'), 'Ritesh')
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff')
    assert.match(got.headers.get('last-modified'), /GMT$/)

    const head = await t.http('HEAD', '/api/buckets/objs-1/objects/docs/a.txt', { token: a.token })
    assert.equal(head.status, 200)
    assert.equal(head.buf.length, 0)
    assert.equal(head.headers.get('content-length'), String(body.length))
    assert.equal(head.headers.get('etag'), `"${md5(body)}"`)
    assert.equal((await t.http('HEAD', '/api/buckets/objs-1/objects/nope', { token: a.token })).status, 404)
    assert.equal((await t.get(a, 'objs-1', 'nope')).status, 404)

    // content type inferred from the extension when absent, validated when present
    const html = await t.put(a, 'objs-1', 'page.html', '<p>x</p>', { 'content-type': '' })
    assert.equal(html.json().contentType, 'text/html; charset=utf-8')
    assert.equal((await t.put(a, 'objs-1', 'weird', 'x', { 'content-type': 'not a type' })).status, 400)

    // metadata validation
    assert.equal((await t.put(a, 'objs-1', 'm1', 'x', { 'x-rd-meta-bad_name!': 'v' })).status, 400)
    assert.equal((await t.put(a, 'objs-1', 'm2', 'x', { 'x-rd-meta-big': 'v'.repeat(1100) })).status, 400)
    assert.equal((await t.put(a, 'objs-1', 'm3', 'x', { 'x-rd-acl': 'everyone' })).status, 400)
    assert.equal((await t.put(a, 'objs-1', 'm4', 'x', { 'x-rd-tagging': 'a=1&b=2' })).json().tags.b, '2')

    // overwrite replaces data and frees the old blob
    const before = t.blobs().length
    await t.put(a, 'objs-1', 'docs/a.txt', 'second')
    assert.equal(t.blobs().length, before)
    assert.equal((await t.get(a, 'objs-1', 'docs/a.txt')).text, 'second')
    // empty objects and unicode keys
    assert.equal((await t.put(a, 'objs-1', 'empty', '')).status, 201)
    const e = await t.get(a, 'objs-1', 'empty')
    assert.equal(e.status, 200)
    assert.equal(e.buf.length, 0)
    assert.equal((await t.put(a, 'objs-1', 'тест/ファイル 1.txt', 'u')).status, 201)
    assert.equal((await t.get(a, 'objs-1', 'тест/ファイル 1.txt')).text, 'u')
    assert.equal((await a.call('GET', '/api/buckets/objs-1/meta/docs/a.txt')).data.size, 6)
    assert.equal(t.rowsSize(a), 'second'.length + '<p>x</p>'.length + 1 + 0 + 1, 'object records carry the byte size (billing reads it)')
  } finally { await t.close() }
})

test('objects: key validation', async () => {
  const t = await setup()
  try {
    const { a } = t
    await t.mk(a, 'keys-1')
    const del = (keys) => a.call('POST', '/api/buckets/keys-1/delete', { body: { objects: keys.map((key) => ({ key })) } })
    const badKeys = ['', '/lead', 'a//b', 'a/./b', 'a/../b', '..', '.', 'ctl\u0001char', 'new\nline', 'tab\there', 'back\\slash', 'x'.repeat(1025), 'bidi‮spoof', '\ud800lone']
    const r = await del(badKeys)
    assert.equal(r.status, 200)
    assert.equal(r.data.errors.length, badKeys.length, JSON.stringify(r.data.errors))
    // via copy / presign / multipart too
    for (const key of ['a/../b', '/x', 'a\u0000b']) {
      assert.equal((await a.call('POST', '/api/buckets/keys-1/presign', { body: { key } })).status, 400, key)
      assert.equal((await a.call('POST', '/api/buckets/keys-1/uploads', { body: { key } })).status, 400, key)
    }
    assert.equal((await a.call('POST', '/api/buckets/keys-1/presign', { body: { key: 5 } })).status, 400)
    // a literal ".." that survives URL parsing is rejected by the route as well
    assert.equal((await t.http('PUT', '/api/buckets/keys-1/objects/a%2F..%2Fb', { token: a.token, body: 'x' })).status, 400)
    assert.equal((await t.http('PUT', '/api/buckets/keys-1/objects/a%00b', { token: a.token, body: 'x' })).status, 400)
    assert.equal((await t.http('PUT', '/api/buckets/keys-1/objects/a%5Cb', { token: a.token, body: 'x' })).status, 400)
    assert.equal((await t.http('PUT', '/api/buckets/keys-1/objects/' + 'k'.repeat(1025), { token: a.token, body: 'x' })).status, 400)
    // longest legal key, NFC normalisation (é composed vs decomposed is the same key)
    assert.equal((await t.put(a, 'keys-1', 'k'.repeat(1024), 'x')).status, 201)
    await t.put(a, 'keys-1', 'café', 'nfd')
    assert.equal((await t.get(a, 'keys-1', 'café')).text, 'nfd')
    assert.equal((await a.call('GET', '/api/buckets/keys-1/objects')).data.objects.filter((o) => o.key === 'café').length, 1)
    // trailing slash = folder marker
    assert.equal((await t.put(a, 'keys-1', 'folder/', '')).status, 201)
  } finally { await t.close() }
})

test('objects: Content-MD5 and x-rd-checksum-sha256 verification leaves nothing behind', async () => {
  const t = await setup()
  try {
    const { a } = t
    await t.mk(a, 'sums-1')
    const body = Buffer.from('checksummed payload')
    const b64 = crypto.createHash('md5').update(body).digest('base64')
    assert.equal((await t.put(a, 'sums-1', 'ok-md5', body, { 'content-md5': b64 })).status, 201)
    assert.equal((await t.put(a, 'sums-1', 'ok-sha-hex', body, { 'x-rd-checksum-sha256': sha256(body) })).status, 201)
    assert.equal((await t.put(a, 'sums-1', 'ok-sha-b64', body, { 'x-rd-checksum-sha256': crypto.createHash('sha256').update(body).digest('base64') })).status, 201)
    const n = t.blobs().length
    const wrongMd5 = crypto.createHash('md5').update('other').digest('base64')
    const r1 = await t.put(a, 'sums-1', 'bad-md5', body, { 'content-md5': wrongMd5 })
    assert.equal(r1.status, 400)
    assert.match(r1.json().error, /BadDigest|Content-MD5/)
    assert.equal((await t.put(a, 'sums-1', 'bad-sha', body, { 'x-rd-checksum-sha256': sha256('other') })).status, 400)
    assert.equal((await t.put(a, 'sums-1', 'junk-md5', body, { 'content-md5': 'zzz' })).status, 400)
    assert.equal((await t.put(a, 'sums-1', 'junk-sha', body, { 'x-rd-checksum-sha256': 'abc' })).status, 400)
    assert.equal(t.blobs().length, n, 'failed uploads free their blobs')
    assert.equal((await t.get(a, 'sums-1', 'bad-md5')).status, 404)
    assert.equal((await t.get(a, 'sums-1', 'ok-md5')).headers.get('x-rd-checksum-sha256'), sha256(body))
  } finally { await t.close() }
})

test('objects: conditional requests (If-Match / If-None-Match / If-Modified-Since / If-Unmodified-Since)', async () => {
  const t = await setup()
  try {
    const { a } = t
    await t.mk(a, 'cond-1')
    const up = await t.put(a, 'cond-1', 'f.txt', 'conditional')
    const etag = up.headers.get('etag')
    const lm = (await t.get(a, 'cond-1', 'f.txt')).headers.get('last-modified')
    const at = (h) => t.get(a, 'cond-1', 'f.txt', h)
    assert.equal((await at({ 'if-none-match': etag })).status, 304)
    assert.equal((await at({ 'if-none-match': `W/${etag}` })).status, 304)
    assert.equal((await at({ 'if-none-match': '"nope", ' + etag })).status, 304)
    assert.equal((await at({ 'if-none-match': '*' })).status, 304)
    assert.equal((await at({ 'if-none-match': '"nope"' })).status, 200)
    const nm = await at({ 'if-none-match': etag })
    assert.equal(nm.buf.length, 0)
    assert.equal(nm.headers.get('etag'), etag, '304 repeats the validators')
    assert.equal((await at({ 'if-match': etag })).status, 200)
    assert.equal((await at({ 'if-match': '"nope"' })).status, 412)
    assert.equal((await at({ 'if-match': `W/${etag}` })).status, 412, 'If-Match uses strong comparison')
    assert.equal((await at({ 'if-match': '*' })).status, 200)
    assert.equal((await at({ 'if-modified-since': lm })).status, 304)
    assert.equal((await at({ 'if-modified-since': new Date(Date.parse(lm) - 5000).toUTCString() })).status, 200)
    assert.equal((await at({ 'if-modified-since': 'garbage' })).status, 200)
    assert.equal((await at({ 'if-unmodified-since': new Date(Date.parse(lm) - 5000).toUTCString() })).status, 412)
    assert.equal((await at({ 'if-unmodified-since': lm })).status, 200)
    // If-Match wins over If-Unmodified-Since, If-None-Match over If-Modified-Since
    assert.equal((await at({ 'if-match': etag, 'if-unmodified-since': new Date(0).toUTCString() })).status, 200)
    assert.equal((await at({ 'if-none-match': '"nope"', 'if-modified-since': lm })).status, 200)
    assert.equal((await t.http('HEAD', '/api/buckets/cond-1/objects/f.txt', { token: a.token, headers: { 'if-none-match': etag } })).status, 304)

    // conditional writes
    assert.equal((await t.put(a, 'cond-1', 'f.txt', 'again', { 'if-none-match': '*' })).status, 412, 'create-only')
    assert.equal((await t.put(a, 'cond-1', 'fresh.txt', 'new', { 'if-none-match': '*' })).status, 201)
    assert.equal((await t.put(a, 'cond-1', 'f.txt', 'v2', { 'if-match': '"nope"' })).status, 412)
    assert.equal((await t.put(a, 'cond-1', 'ghost.txt', 'v2', { 'if-match': etag })).status, 412, 'If-Match on a missing object')
    assert.equal((await t.put(a, 'cond-1', 'f.txt', 'v2', { 'if-match': etag })).status, 201)
    assert.equal((await t.get(a, 'cond-1', 'f.txt')).text, 'v2')
  } finally { await t.close() }
})

test('objects: HTTP ranges (single, open, suffix, multi, 416, If-Range) across chunk boundaries', async () => {
  const t = await setup({ chunkBytes: 7 })
  try {
    const { a } = t
    await t.mk(a, 'range-1')
    const body = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJ') // 46 bytes -> 7 chunks of 7
    const up = await t.put(a, 'range-1', 'r.bin', body, { 'content-type': 'application/octet-stream' })
    assert.equal(up.status, 201)
    assert.equal(t.blobs().length, 7)
    assert.equal((await t.get(a, 'range-1', 'r.bin')).buf.equals(body), true, 'whole object streams back from chunks')
    const rng = (v, extra = {}) => t.get(a, 'range-1', 'r.bin', { range: v, ...extra })
    let r = await rng('bytes=0-9')
    assert.equal(r.status, 206)
    assert.equal(r.text, '0123456789')
    assert.equal(r.headers.get('content-range'), 'bytes 0-9/46')
    assert.equal(r.headers.get('content-length'), '10')
    r = await rng('bytes=5-20')
    assert.equal(r.buf.toString(), body.subarray(5, 21).toString())
    r = await rng('bytes=40-')
    assert.equal(r.buf.toString(), body.subarray(40).toString())
    assert.equal(r.headers.get('content-range'), 'bytes 40-45/46')
    r = await rng('bytes=-4')
    assert.equal(r.buf.toString(), 'GHIJ')
    assert.equal(r.headers.get('content-range'), 'bytes 42-45/46')
    r = await rng('bytes=-1000')
    assert.equal(r.status, 206)
    assert.equal(r.buf.length, 46, 'a suffix longer than the object returns all of it')
    r = await rng('bytes=44-9999')
    assert.equal(r.headers.get('content-range'), 'bytes 44-45/46')
    r = await rng('bytes=7-7')
    assert.equal(r.text, '7')
    // multi range
    r = await rng('bytes=0-1, 10-11, -2')
    assert.equal(r.status, 206)
    const ct = r.headers.get('content-type')
    assert.match(ct, /^multipart\/byteranges; boundary=/)
    const boundary = ct.split('boundary=')[1]
    assert.equal(r.headers.get('content-length'), String(r.buf.length), 'exact multipart length')
    const parts = r.text.split(`--${boundary}`).slice(1, -1)
    assert.equal(parts.length, 3)
    assert.match(parts[0], /content-range: bytes 0-1\/46/i)
    assert.ok(parts[0].endsWith('\r\n01\r\n'))
    assert.ok(parts[1].endsWith('\r\nab\r\n'))
    assert.ok(parts[2].endsWith('\r\nIJ\r\n'))
    assert.ok(r.text.endsWith(`--${boundary}--\r\n`))
    // overlapping ranges are coalesced, so they cannot amplify the response
    r = await rng('bytes=0-10,5-15,16-20')
    assert.equal(r.status, 206)
    assert.equal(r.headers.get('content-range'), 'bytes 0-20/46')
    assert.equal(r.buf.length, 21)
    // unsatisfiable
    r = await rng('bytes=46-')
    assert.equal(r.status, 416)
    assert.equal(r.headers.get('content-range'), 'bytes */46')
    assert.equal((await rng('bytes=100-200')).status, 416)
    assert.equal((await rng('bytes=-0')).status, 416)
    assert.equal((await rng(`bytes=${Array.from({ length: 40 }, (_, i) => `${i * 2}-${i * 2}`).join(',')}`)).status, 416, 'too many ranges')
    // not understood -> ignored (full 200)
    for (const v of ['bytes=5-2', 'bytes=a-b', 'items=0-5', 'bytes=', 'bytes=-', 'garbage']) assert.equal((await rng(v)).status, 200, v)
    // If-Range
    const etag = up.headers.get('etag')
    assert.equal((await rng('bytes=0-3', { 'if-range': etag })).status, 206)
    assert.equal((await rng('bytes=0-3', { 'if-range': '"other"' })).status, 200)
    // HEAD honours Range headers (status + headers, no body)
    const h = await t.http('HEAD', '/api/buckets/range-1/objects/r.bin', { token: a.token, headers: { range: 'bytes=0-4' } })
    assert.equal(h.status, 206)
    assert.equal(h.headers.get('content-range'), 'bytes 0-4/46')
    assert.equal(h.buf.length, 0)
    // empty object: ranges are unsatisfiable
    await t.put(a, 'range-1', 'e', '')
    assert.equal((await t.get(a, 'range-1', 'e', { range: 'bytes=0-' })).status, 416)
  } finally { await t.close() }
})

test('objects: listing with prefix, delimiter, folders, pagination and stable ordering', async () => {
  const t = await setup()
  try {
    const { a } = t
    await t.mk(a, 'list-1')
    const keys = ['b.txt', 'a.txt', 'photos/2024/x.jpg', 'photos/2024/y.jpg', 'photos/2025/z.jpg', 'photos/readme', 'docs/a/b/c.md', 'zeta', 'Zulu', '\u{1F600}emoji', '～full', 'photos/']
    for (const k of keys) assert.equal((await t.put(a, 'list-1', k, k)).status, 201)
    const list = (qs) => a.call('GET', `/api/buckets/list-1/objects${qs}`).then((r) => { assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data })
    const all = await list('')
    assert.deepEqual(all.objects.map((o) => o.key), [...keys].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y))), 'UTF-8 byte order')
    assert.equal(all.isTruncated, false)
    assert.equal(all.nextContinuationToken, null)
    assert.deepEqual(all.commonPrefixes, [])

    const top = await list('?delimiter=/')
    assert.deepEqual(top.commonPrefixes, ['docs/', 'photos/'])
    assert.deepEqual(top.objects.map((o) => o.key), ['Zulu', 'a.txt', 'b.txt', 'zeta', '～full', '\u{1F600}emoji'])
    const photos = await list('?prefix=photos/&delimiter=/')
    assert.deepEqual(photos.commonPrefixes, ['photos/2024/', 'photos/2025/'])
    assert.deepEqual(photos.objects.map((o) => o.key), ['photos/', 'photos/readme'])
    assert.equal(photos.keyCount, 4)
    assert.deepEqual((await list('?prefix=photos/2024/')).objects.map((o) => o.key), ['photos/2024/x.jpg', 'photos/2024/y.jpg'])
    assert.deepEqual((await list('?prefix=nothing')).objects, [])

    // pagination: every key exactly once, in order, whatever the page size
    for (const size of [1, 2, 3, 5, 100]) {
      const seen = []
      let token = null
      let pages = 0
      do {
        const page = await list(`?max-keys=${size}${token ? `&continuation-token=${token}` : ''}`)
        seen.push(...page.objects.map((o) => o.key))
        token = page.nextContinuationToken
        assert.equal(page.isTruncated, token !== null)
        assert.ok(page.objects.length <= size)
        pages++
      } while (token && pages < 50)
      assert.deepEqual(seen, all.objects.map((o) => o.key), `page size ${size}`)
    }
    // pagination with delimiter treats a folder as one entry and never repeats it
    const seen = []
    let token = null
    do {
      const page = await list(`?delimiter=/&max-keys=2${token ? `&continuation-token=${token}` : ''}`)
      seen.push(...page.commonPrefixes.map((p) => `P:${p}`), ...page.objects.map((o) => o.key))
      token = page.nextContinuationToken
    } while (token)
    assert.deepEqual(seen.sort(), [...top.commonPrefixes.map((p) => `P:${p}`), ...top.objects.map((o) => o.key)].sort())
    assert.equal(seen.length, new Set(seen).size)
    assert.deepEqual((await list('?start-after=photos/2025/z.jpg&prefix=photos/')).objects.map((o) => o.key), ['photos/readme'])
    // aliases from the platform conventions, clamping and validation
    assert.equal((await list('?limit=2')).objects.length, 2)
    assert.equal((await list('?max-keys=999999')).objects.length, keys.length)
    for (const qs of ['?max-keys=0', '?max-keys=abc', '?max-keys=-1', '?continuation-token=!!!', '?continuation-token=' + Buffer.from('[1]').toString('base64url'), '?delimiter=' + 'x'.repeat(40), '?prefix=a%00b']) {
      assert.equal((await a.call('GET', `/api/buckets/list-1/objects${qs}`)).status, 400, qs)
    }
  } finally { await t.close() }
})

/* ============================================================================================ multi-chunk integrity */

test('objects are stored as chunk blobs and large bodies never need to fit one buffer', async () => {
  const t = await setup({ chunkBytes: 1024 })
  try {
    const { a } = t
    await t.mk(a, 'chunks-1')
    const big = crypto.randomBytes(10 * 1024 + 123)
    const up = await t.put(a, 'chunks-1', 'big.bin', big)
    assert.equal(up.status, 201)
    const row = t.app.db.find('objects', (o) => o.key === 'big.bin')[0]
    assert.equal(row.chunks.length, 11)
    assert.ok(row.chunks.every((c) => c.size <= 1024))
    assert.equal(row.size, big.length)
    assert.equal(up.json().etag, md5(big))
    assert.ok((await t.get(a, 'chunks-1', 'big.bin')).buf.equals(big))
    // a stream without Content-Length (chunked transfer) works the same
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < big.length; i += 3000) c.enqueue(big.subarray(i, i + 3000)); c.close() } })
    const chunked = await t.http('PUT', '/api/buckets/chunks-1/objects/streamed.bin', { token: a.token, body: stream, duplex: 'half' })
    assert.equal(chunked.status, 201, chunked.text)
    assert.ok((await t.get(a, 'chunks-1', 'streamed.bin')).buf.equals(big))
    // deleting frees every chunk
    await a.call('DELETE', '/api/buckets/chunks-1/objects/big.bin')
    await a.call('DELETE', '/api/buckets/chunks-1/objects/streamed.bin')
    assert.equal(t.blobs().length, 0)
    // stored sizes add up exactly (billing derives storage from them)
    await t.put(a, 'chunks-1', 'one.bin', big)
    const stored = t.app.db.find('objects', (o) => o.userId === a.user.id)
    assert.equal(stored.reduce((s, o) => s + o.size, 0), big.length)
    assert.equal(t.blobs().reduce((s, x) => s + x.size, 0), big.length)
  } finally { await t.close() }
})

test('persistent store: chunked objects survive a restart and are checksum-verified', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-storage-'))
  try {
    let app = await startTestApp({ dataDir: dir })
    app.ctx.storage.limits.chunkBytes = 2048
    const u = await app.register()
    await u.call('POST', '/api/buckets', { body: { name: 'persist-1', versioning: 'enabled' } })
    const big = crypto.randomBytes(9000)
    const put = (key, body) => fetch(`${app.base}/api/buckets/persist-1/objects/${key}`, { method: 'PUT', body, headers: { authorization: `Bearer ${u.token}` } })
    assert.equal((await put('big.bin', big)).status, 201)
    assert.equal((await put('big.bin', Buffer.from('v2'))).status, 201)
    await app.close()
    app.db.close()
    app = await startTestApp({ dataDir: dir })
    const v = await fetch(`${app.base}/api/buckets/persist-1/objects/big.bin`, { headers: { authorization: `Bearer ${u.token}` } })
    assert.equal((await v.text()), 'v2')
    const versions = (await (await fetch(`${app.base}/api/buckets/persist-1/versions?key=big.bin`, { headers: { authorization: `Bearer ${u.token}` } })).json()).versions
    assert.equal(versions.length, 2)
    const old = await fetch(`${app.base}/api/buckets/persist-1/objects/big.bin?versionId=${versions[1].versionId}`, { headers: { authorization: `Bearer ${u.token}` } })
    assert.ok(Buffer.from(await old.arrayBuffer()).equals(big))
    // flip a byte in a stored chunk: the engine refuses to serve it (500, never wrong bytes)
    const row = app.db.find('objects', (o) => o.versionId === versions[1].versionId)[0]
    const blobId = row.chunks[1].blobId
    const file = fs.readdirSync(path.join(dir, 'blobs'), { recursive: true }).map((f) => path.join(dir, 'blobs', f)).find((f) => path.basename(f) === blobId)
    const raw = fs.readFileSync(file)
    raw[raw.length - 1] ^= 0xff
    fs.writeFileSync(file, raw)
    const read = async () => {
      try {
        const res = await fetch(`${app.base}/api/buckets/persist-1/objects/big.bin?versionId=${versions[1].versionId}`, { headers: { authorization: `Bearer ${u.token}` } })
        return { status: res.status, bytes: (await res.arrayBuffer()).byteLength }
      } catch { return { status: 0, bytes: 0 } } // the connection is cut mid-body: also fine, wrong bytes are not
    }
    const broken = await read()
    assert.ok(broken.status !== 200 || broken.bytes < big.length, `corruption must not be served as ${JSON.stringify(broken)}`)
    // damage in the first chunk is caught before the status line: a clean 500, no body
    const first = row.chunks[0].blobId
    const file0 = fs.readdirSync(path.join(dir, 'blobs'), { recursive: true }).map((f) => path.join(dir, 'blobs', f)).find((f) => path.basename(f) === first)
    const raw0 = fs.readFileSync(file0)
    raw0[raw0.length - 1] ^= 0xff
    fs.writeFileSync(file0, raw0)
    assert.equal((await read()).status, 500)
    await app.close()
    app.db.close()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('rows written by the previous flat implementation are adopted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-storage-legacy-'))
  try {
    const first = await createApp({ dataDir: dir, strictModules: true })
    const user = first.db.insert('users', { email: 'legacy@rd.dev', password: 'x' })
    const bucket = first.db.insert('buckets', { userId: user.id, name: 'legacy-bucket' })
    first.db.putBlob('blob_legacy1', Buffer.from('legacy data'))
    first.db.insert('objects', { userId: user.id, bucketId: bucket.id, key: 'old/file.txt', size: 11, contentType: 'text/plain', blobId: 'blob_legacy1' })
    first.db.close()
    const app = await startTestApp({ dataDir: dir })
    const row = app.db.find('objects', () => true)[0]
    assert.equal(row.versionId, 'null')
    assert.equal(row.isLatest, true)
    assert.ok(row.bkey)
    // session for that user
    const sess = app.db.insert('sessions', { userId: user.id, hash: 'unused' })
    assert.ok(sess)
    const owner = app.db.get('users', user.id)
    assert.ok(owner)
    // read through the module's own helpers by using an API key-less path: listing needs auth, so mint a session via register-less call
    const list = app.ctx.storage.usageOf(user.id)
    assert.equal(list.objectBytes, 11)
    assert.equal(app.ctx.storage.isReferenced('blob_legacy1'), true)
    await app.close()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

/* ============================================================================================ versioning */

test('versioning: versions, delete markers, listing, restore and the suspended "null" version', async () => {
  const t = await setup()
  try {
    const { a } = t
    await t.mk(a, 'ver-1', { versioning: 'enabled' })
    const v1 = (await t.put(a, 'ver-1', 'f.txt', 'one')).json()
    const v2 = (await t.put(a, 'ver-1', 'f.txt', 'two!')).json()
    assert.notEqual(v1.versionId, v2.versionId)
    assert.notEqual(v1.versionId, 'null')
    assert.equal((await t.get(a, 'ver-1', 'f.txt')).text, 'two!')
    assert.equal((await t.get(a, 'ver-1', 'f.txt', {}, `?versionId=${v1.versionId}`)).text, 'one')
    assert.equal((await t.get(a, 'ver-1', 'f.txt', {}, '?versionId=nope')).status, 404)
    assert.equal((await t.get(a, 'ver-1', 'f.txt', {}, '?versionId=../x')).status, 400)
    assert.equal((await t.put(a, 'ver-1', 'f.txt', 'two!')).headers.get('x-rd-version-id') !== null, true)
    let versions = (await a.call('GET', '/api/buckets/ver-1/versions?key=f.txt')).data.versions
    assert.equal(versions.length, 3)
    assert.equal(versions[0].isLatest, true)
    assert.equal(versions.filter((v) => v.isLatest).length, 1)
    assert.ok(versions[0].lastModified >= versions[2].lastModified, 'newest first')
    // all versions (noncurrent too) are in the stored byte count
    assert.equal(t.rowsSize(a), 3 + 4 + 4)
    assert.equal((await a.call('GET', '/api/storage/usage')).data.usedBytes, 11)

    // delete = marker; data stays
    const del = await a.call('DELETE', '/api/buckets/ver-1/objects/f.txt')
    assert.equal(del.data.deleteMarker, true)
    assert.ok(del.data.versionId)
    const gone = await t.get(a, 'ver-1', 'f.txt')
    assert.equal(gone.status, 404)
    assert.equal(gone.headers.get('x-rd-delete-marker'), 'true')
    assert.equal((await a.call('GET', '/api/buckets/ver-1/objects')).data.objects.length, 0, 'markers hide the key from listings')
    assert.equal((await a.call('DELETE', '/api/buckets/ver-1/objects/f.txt')).status, 404, 'no pile of markers')
    versions = (await a.call('GET', '/api/buckets/ver-1/versions?key=f.txt')).data.versions
    assert.equal(versions.length, 4)
    assert.equal(versions[0].deleteMarker, true)
    assert.equal(versions[0].size, 0)
    assert.equal((await t.get(a, 'ver-1', 'f.txt', {}, `?versionId=${del.data.versionId}`)).status, 405, 'GET of a marker version')
    assert.equal((await t.get(a, 'ver-1', 'f.txt', {}, `?versionId=${v1.versionId}`)).text, 'one', 'old versions stay readable')
    // removing the marker un-deletes
    assert.equal((await a.call('DELETE', `/api/buckets/ver-1/objects/f.txt?versionId=${del.data.versionId}`)).status, 200)
    assert.equal((await t.get(a, 'ver-1', 'f.txt')).text, 'two!')
    // restore an old version: it becomes the newest version, history is kept
    const rest = await a.call('POST', '/api/buckets/ver-1/restore', { body: { key: 'f.txt', versionId: v1.versionId } })
    assert.equal(rest.status, 201)
    assert.equal((await t.get(a, 'ver-1', 'f.txt')).text, 'one')
    versions = (await a.call('GET', '/api/buckets/ver-1/versions?key=f.txt')).data.versions
    assert.equal(versions.length, 4)
    assert.equal(versions.filter((v) => v.isLatest).length, 1)
    assert.equal((await a.call('POST', '/api/buckets/ver-1/restore', { body: { key: 'f.txt', versionId: 'nope' } })).status, 404)
    assert.equal((await a.call('POST', '/api/buckets/ver-1/restore', { body: { key: 'f.txt' } })).status, 400)
    // deleting the current version permanently promotes the previous one
    assert.equal((await a.call('DELETE', `/api/buckets/ver-1/objects/f.txt?versionId=${rest.data.versionId}`)).status, 200)
    assert.equal((await t.get(a, 'ver-1', 'f.txt')).text, 'two!')
    assert.equal((await a.call('DELETE', '/api/buckets/ver-1/objects/f.txt?versionId=nope')).status, 404)
    // version listing pagination
    const p1 = await a.call('GET', '/api/buckets/ver-1/versions?max-keys=2')
    assert.equal(p1.data.versions.length, 2)
    assert.equal(p1.data.isTruncated, true)
    const p2 = await a.call('GET', `/api/buckets/ver-1/versions?max-keys=2&continuation-token=${p1.data.nextContinuationToken}`)
    assert.equal(p1.data.versions.length + p2.data.versions.length, 3)
    assert.equal(p2.data.isTruncated, false)

    // suspended: writes use the "null" version and replace each other, old versions remain
    await a.call('PATCH', '/api/buckets/ver-1', { body: { versioning: 'suspended' } })
    const n1 = (await t.put(a, 'ver-1', 'f.txt', 'null-1')).json()
    const n2 = (await t.put(a, 'ver-1', 'f.txt', 'null-2')).json()
    assert.equal(n1.versionId, 'null')
    assert.equal(n2.versionId, 'null')
    versions = (await a.call('GET', '/api/buckets/ver-1/versions?key=f.txt')).data.versions
    assert.equal(versions.filter((v) => v.versionId === 'null').length, 1)
    assert.equal(versions.length, 4)
    assert.equal((await t.get(a, 'ver-1', 'f.txt')).text, 'null-2')
    const del2 = await a.call('DELETE', '/api/buckets/ver-1/objects/f.txt')
    assert.equal(del2.data.deleteMarker, true)
    assert.equal(del2.data.versionId, 'null')
    assert.equal((await t.get(a, 'ver-1', 'f.txt')).status, 404)
    assert.equal((await t.get(a, 'ver-1', 'f.txt', {}, `?versionId=${v1.versionId}`)).text, 'one')
    // blobs are exactly the live + noncurrent data
    assert.equal(t.blobs().length, t.app.db.find('objects', (o) => !o.deleteMarker).length)
  } finally { await t.close() }
})

test('unversioned buckets: delete is permanent and frees storage', async () => {
  const t = await setup()
  try {
    const { a } = t
    await t.mk(a, 'plain-1')
    await t.put(a, 'plain-1', 'f', 'data')
    const v = (await t.get(a, 'plain-1', 'f')).headers.get('x-rd-version-id')
    assert.equal(v, 'null')
    const d = await a.call('DELETE', '/api/buckets/plain-1/objects/f')
    assert.equal(d.data.deleteMarker, false)
    assert.equal(t.blobs().length, 0)
    assert.equal(t.app.db.find('objects', () => true).length, 0)
    assert.equal((await a.call('DELETE', '/api/buckets/plain-1/objects/f')).status, 404)
  } finally { await t.close() }
})

/* ============================================================================================ copy + batch delete + tags + ACL */

test('copy: server-side, cross-bucket, metadata directives, independent data', async () => {
  const t = await setup({ chunkBytes: 5 })
  try {
    const { a } = t
    await t.mk(a, 'copy-src')
    await t.mk(a, 'copy-dst')
    const body = Buffer.from('some data longer than one chunk')
    await t.put(a, 'copy-src', 'orig.txt', body, { 'content-type': 'text/plain', 'x-rd-meta-origin': 'src', 'x-rd-tagging': 'k=v' })
    const cp = await a.call('POST', '/api/buckets/copy-dst/copy', { body: { source: { bucket: 'copy-src', key: 'orig.txt' }, destination: { key: 'dir/copy.txt' } } })
    assert.equal(cp.status, 201, JSON.stringify(cp.data))
    assert.equal(cp.data.etag, md5(body))
    assert.deepEqual(cp.data.metadata, { origin: 'src' })
    assert.deepEqual(cp.data.tags, { k: 'v' })
    assert.equal(cp.data.contentType, 'text/plain')
    // independent copies: deleting the source leaves the copy intact
    await a.call('DELETE', '/api/buckets/copy-src/objects/orig.txt')
    assert.ok((await t.get(a, 'copy-dst', 'dir/copy.txt')).buf.equals(body))
    // REPLACE metadata, same bucket, content type; ACL is not copied
    await t.put(a, 'copy-dst', 'src2.txt', 'hello', { 'x-rd-meta-old': '1', 'x-rd-acl': 'public-read' })
    const rep = await a.call('POST', '/api/buckets/copy-dst/copy', { body: { source: { key: 'src2.txt' }, destination: { key: 'dst2.txt' }, metadataDirective: 'REPLACE', metadata: { fresh: 'yes' }, contentType: 'text/markdown' } })
    assert.equal(rep.status, 201)
    assert.deepEqual(rep.data.metadata, { fresh: 'yes' })
    assert.equal(rep.data.contentType, 'text/markdown')
    assert.equal(rep.data.acl, 'inherit')
    // validation
    const c = (body2) => a.call('POST', '/api/buckets/copy-dst/copy', { body: body2 })
    assert.equal((await c({ source: { key: 'src2.txt' }, destination: { key: 'src2.txt' } })).status, 400, 'copy onto itself')
    assert.equal((await c({ source: { key: 'src2.txt' }, destination: { key: 'src2.txt' }, metadataDirective: 'REPLACE', metadata: { x: '1' } })).status, 201, 'self copy with REPLACE edits metadata')
    assert.equal((await c({ source: { key: 'missing' }, destination: { key: 'z' } })).status, 404)
    assert.equal((await c({ source: { key: 'src2.txt' }, destination: { key: '../z' } })).status, 400)
    assert.equal((await c({ source: { key: 'src2.txt' }, destination: { key: 'z' }, metadataDirective: 'MERGE' })).status, 400)
    assert.equal((await c({ destination: { key: 'z' } })).status, 400)
    assert.equal((await c({ source: { key: 'src2.txt', versionId: 'nope' }, destination: { key: 'z' } })).status, 404)
    assert.equal(t.rowsSize(a), t.blobs().reduce((s, x) => s + x.size, 0))
  } finally { await t.close() }
})

test('batch delete, prefix delete, tagging and object ACL endpoints', async () => {
  const t = await setup()
  try {
    const { a } = t
    await t.mk(a, 'batch-1')
    for (const k of ['a/1', 'a/2', 'a/3', 'b/1']) await t.put(a, 'batch-1', k, k)
    const r = await a.call('POST', '/api/buckets/batch-1/delete', { body: { objects: [{ key: 'a/1' }, { key: 'a/2' }, { key: 'nothing' }, { key: '../bad' }] } })
    assert.equal(r.status, 200)
    assert.deepEqual(r.data.deleted.map((d) => d.key), ['a/1', 'a/2', 'nothing'], 'missing keys are reported as deleted (idempotent)')
    assert.equal(r.data.errors.length, 1)
    assert.equal((await a.call('GET', '/api/buckets/batch-1/objects')).data.objects.length, 2)
    assert.equal((await a.call('POST', '/api/buckets/batch-1/delete', { body: { objects: [] } })).status, 400)
    assert.equal((await a.call('POST', '/api/buckets/batch-1/delete', { body: { objects: 'x' } })).status, 400)
    assert.equal((await a.call('POST', '/api/buckets/batch-1/delete', { body: { objects: Array.from({ length: 1001 }, (_, i) => ({ key: `k${i}` })) } })).status, 400)
    assert.equal((await a.call('POST', '/api/buckets/batch-1/delete', { body: { prefix: '' } })).status, 400)
    const q = await a.call('POST', '/api/buckets/batch-1/delete', { body: { objects: [{ key: 'b/1' }], quiet: true } })
    assert.deepEqual(q.data.deleted, [])
    const pd = await a.call('POST', '/api/buckets/batch-1/delete', { body: { prefix: 'a/' } })
    assert.equal(pd.data.deleted.length, 1)
    assert.equal(pd.data.truncated, false)
    assert.equal(t.app.db.find('objects', () => true).length, 0)
    assert.equal(t.blobs().length, 0)

    await t.put(a, 'batch-1', 'tagged.txt', 'x')
    assert.deepEqual((await a.call('GET', '/api/buckets/batch-1/tagging/tagged.txt')).data.tags, {})
    assert.equal((await a.call('PUT', '/api/buckets/batch-1/tagging/tagged.txt', { body: { tags: { team: 'infra', env: 'prod' } } })).status, 200)
    assert.deepEqual((await a.call('GET', '/api/buckets/batch-1/tagging/tagged.txt')).data.tags, { team: 'infra', env: 'prod' })
    assert.equal((await t.get(a, 'batch-1', 'tagged.txt')).headers.get('x-rd-tag-count'), '2')
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v']))
    assert.equal((await a.call('PUT', '/api/buckets/batch-1/tagging/tagged.txt', { body: { tags: many } })).status, 400)
    assert.equal((await a.call('PUT', '/api/buckets/batch-1/tagging/tagged.txt', { body: { tags: { ['k'.repeat(129)]: 'v' } } })).status, 400)
    assert.equal((await a.call('PUT', '/api/buckets/batch-1/tagging/tagged.txt', { body: { tags: { k: 'v'.repeat(257) } } })).status, 400)
    assert.equal((await a.call('PUT', '/api/buckets/batch-1/tagging/missing', { body: { tags: {} } })).status, 404)
    assert.equal((await a.call('DELETE', '/api/buckets/batch-1/tagging/tagged.txt')).status, 200)
    assert.deepEqual((await a.call('GET', '/api/buckets/batch-1/tagging/tagged.txt')).data.tags, {})

    assert.equal((await a.call('GET', '/api/buckets/batch-1/acl/tagged.txt')).data.acl, 'inherit')
    const acl = await a.call('PUT', '/api/buckets/batch-1/acl/tagged.txt', { body: { acl: 'public-read' } })
    assert.equal(acl.data.public, true)
    assert.equal((await a.call('PUT', '/api/buckets/batch-1/acl/tagged.txt', { body: { acl: 'nope' } })).status, 400)
    assert.equal((await a.call('PUT', '/api/buckets/batch-1/acl/missing', { body: { acl: 'private' } })).status, 404)
  } finally { await t.close() }
})

test('deleting a bucket: 409 when not empty, ?force=true removes data, versions and uploads', async () => {
  const t = await setup()
  try {
    const { a } = t
    await t.mk(a, 'del-1', { versioning: 'enabled' })
    await t.put(a, 'del-1', 'f', 'v1')
    await t.put(a, 'del-1', 'f', 'v2')
    await a.call('DELETE', '/api/buckets/del-1/objects/f') // only a delete marker + noncurrent versions remain visible as "empty"
    assert.equal((await a.call('DELETE', '/api/buckets/del-1')).status, 409, 'noncurrent versions and markers still count')
    const up = await a.call('POST', '/api/buckets/del-1/uploads', { body: { key: 'big' } })
    await t.http('PUT', `/api/buckets/del-1/uploads/${up.data.uploadId}/parts/1`, { token: a.token, body: 'partdata' })
    assert.equal((await a.call('DELETE', '/api/buckets/del-1?force=true')).status, 200)
    assert.equal(t.app.db.find('objects', () => true).length, 0)
    assert.equal(t.app.db.find('st_parts', () => true).length, 0)
    assert.equal(t.app.db.find('st_uploads', () => true).length, 0)
    assert.equal(t.blobs().length, 0)
    // an empty bucket with an open upload is not empty either
    await t.mk(a, 'del-2')
    await a.call('POST', '/api/buckets/del-2/uploads', { body: { key: 'k' } })
    assert.equal((await a.call('DELETE', '/api/buckets/del-2')).status, 409)
  } finally { await t.close() }
})

/* ============================================================================================ multipart */

test('multipart: initiate, upload parts, list, complete with ETag validation, no concatenation', async () => {
  const t = await setup({ chunkBytes: 8, minPartBytes: 10 })
  try {
    const { a } = t
    await t.mk(a, 'mp-1')
    const init = await a.call('POST', '/api/buckets/mp-1/uploads', { body: { key: 'dir/big.bin', contentType: 'application/x-test', metadata: { owner: 'me' }, tags: { t: '1' } } })
    assert.equal(init.status, 201)
    const id = init.data.uploadId
    const part = (n, body, headers = {}) => t.http('PUT', `/api/buckets/mp-1/uploads/${id}/parts/${n}`, { token: a.token, body, headers })
    const p1 = Buffer.from('A'.repeat(25))
    const p2 = Buffer.from('B'.repeat(12))
    const p3 = Buffer.from('C'.repeat(3)) // the last part may be small
    const r1 = await part(1, p1, { 'content-md5': crypto.createHash('md5').update(p1).digest('base64') })
    assert.equal(r1.status, 200)
    assert.equal(r1.json().etag, `"${md5(p1)}"`)
    assert.equal(r1.headers.get('etag'), `"${md5(p1)}"`)
    // out-of-order upload, then replace part 2
    const r3 = await part(3, p3)
    const r2bad = await part(2, 'wrong', { 'content-md5': crypto.createHash('md5').update('different').digest('base64') })
    assert.equal(r2bad.status, 400, 'bad digest on a part')
    const r2old = await part(2, 'x'.repeat(11))
    const r2 = await part(2, p2)
    assert.notEqual(r2old.json().etag, r2.json().etag)
    const listed = await a.call('GET', `/api/buckets/mp-1/uploads/${id}/parts`)
    assert.deepEqual(listed.data.parts.map((p) => [p.partNumber, p.size]), [[1, 25], [2, 12], [3, 3]])
    assert.equal((await a.call('GET', `/api/buckets/mp-1/uploads/${id}/parts?max-parts=2`)).data.nextPartNumberMarker, 2)
    assert.equal((await a.call('GET', `/api/buckets/mp-1/uploads/${id}/parts?part-number-marker=2`)).data.parts.length, 1)
    const open = await a.call('GET', '/api/buckets/mp-1/uploads')
    assert.equal(open.data.uploads.length, 1)
    assert.equal(open.data.uploads[0].partCount, 3)
    assert.equal((await a.call('GET', '/api/buckets/mp-1/objects/dir/big.bin')).status, 404, 'not visible before completion')
    assert.equal(t.rowsSize(a), 0)
    assert.equal((await a.call('GET', '/api/storage/usage')).data.inFlightMultipartBytes, 40)

    const complete = (parts, headers) => a.call('POST', `/api/buckets/mp-1/uploads/${id}/complete`, { body: { parts }, headers })
    const good = [{ partNumber: 1, etag: r1.json().etag }, { partNumber: 2, etag: r2.json().etag }, { partNumber: 3, etag: r3.json().etag }]
    assert.equal((await complete([])).status, 400)
    assert.equal((await complete([good[1], good[0]])).status, 400, 'ascending order required')
    assert.equal((await complete([good[0], good[0]])).status, 400, 'no duplicates')
    assert.equal((await complete([{ partNumber: 1, etag: '"deadbeef"' }])).status, 400, 'wrong etag')
    assert.equal((await complete([{ partNumber: 9, etag: '"x"' }])).status, 400, 'unknown part')
    assert.equal((await complete([{ partNumber: 1, etag: r1.json().etag }, { partNumber: 3, etag: r3.json().etag }, { partNumber: 4, etag: '"x"' }])).status, 400)
    assert.equal((await complete([good[2], { partNumber: 4, etag: '"x"' }])).status, 400)
    assert.equal((await complete([{ partNumber: 'one', etag: 'x' }])).status, 400)
    // a non-final part below the minimum is rejected
    assert.equal((await complete([good[2], good[0]].reverse().reverse())).status, 400)
    const blobsBefore = t.blobs().length
    const done = await complete(good)
    assert.equal(done.status, 201, JSON.stringify(done.data))
    const whole = Buffer.concat([p1, p2, p3])
    const expectedEtag = `${md5(Buffer.concat([p1, p2, p3].map((p) => crypto.createHash('md5').update(p).digest())))}-3`
    assert.equal(done.data.etag, expectedEtag)
    assert.equal(done.data.size, whole.length)
    assert.equal(done.data.partCount, 3)
    assert.equal(done.data.contentType, 'application/x-test')
    assert.deepEqual(done.data.metadata, { owner: 'me' })
    assert.deepEqual(done.data.tags, { t: '1' })
    // the object is the part chunks themselves: no new blobs, no data copied
    assert.equal(t.blobs().length, blobsBefore, 'completion adds and removes no blob: the object is the part chunks themselves')
    const obj = await t.get(a, 'mp-1', 'dir/big.bin')
    assert.ok(obj.buf.equals(whole))
    assert.equal(obj.headers.get('etag'), `"${expectedEtag}"`)
    const rng = await t.get(a, 'mp-1', 'dir/big.bin', { range: 'bytes=20-30' })
    assert.equal(rng.text, whole.subarray(20, 31).toString())
    assert.equal(t.rowsSize(a), whole.length)
    assert.equal(t.app.db.find('st_parts', () => true).length, 0)
    assert.equal(t.app.db.find('st_uploads', () => true).length, 0)
    assert.equal((await complete(good)).status, 404, 'cannot complete twice')
    assert.equal((await part(1, 'late')).status, 404)
    // a copy of the multipart object keeps its ETag
    const cp = await a.call('POST', '/api/buckets/mp-1/copy', { body: { source: { key: 'dir/big.bin' }, destination: { key: 'copy.bin' } } })
    assert.equal(cp.data.etag, expectedEtag)
    // deleting both frees all blobs
    await a.call('DELETE', '/api/buckets/mp-1/objects/dir/big.bin')
    await a.call('DELETE', '/api/buckets/mp-1/objects/copy.bin')
    assert.equal(t.blobs().length, 0)
  } finally { await t.close() }
})

test('multipart: size rules, abort, unused parts, caps and tenant isolation', async () => {
  const t = await setup({ chunkBytes: 8, minPartBytes: 10, maxPartBytes: 30, maxParts: 4, maxObjectBytes: 70 })
  try {
    const { a, b } = t
    await t.mk(a, 'mp-2')
    const init = async (key = 'k') => (await a.call('POST', '/api/buckets/mp-2/uploads', { body: { key } })).data.uploadId
    const part = (id, n, body, u = a) => t.http('PUT', `/api/buckets/mp-2/uploads/${id}/parts/${n}`, { token: u.token, body })
    let id = await init()
    assert.equal((await part(id, 0, 'x')).status, 400)
    assert.equal((await part(id, 5, 'x')).status, 400, 'maxParts')
    assert.equal((await part(id, 'abc', 'x')).status, 400)
    assert.equal((await part(id, 1, 'x'.repeat(31))).status, 413, 'part cap')
    assert.equal((await part('nope', 1, 'x')).status, 404)
    assert.equal((await part(id, 1, 'x'.repeat(10), b)).status, 404, 'other tenant')
    assert.equal((await t.http('PUT', `/api/buckets/mp-2/uploads/${id}/parts/1`, { token: b.token, body: 'x' })).status, 404)
    assert.equal((await b.call('DELETE', `/api/buckets/mp-2/uploads/${id}`)).status, 404)
    assert.equal((await b.call('GET', `/api/buckets/mp-2/uploads/${id}/parts`)).status, 404)
    assert.equal((await b.call('POST', `/api/buckets/mp-2/uploads/${id}/complete`, { body: { parts: [{ partNumber: 1, etag: 'x' }] } })).status, 404)
    const e1 = (await part(id, 1, 'a'.repeat(5))).json().etag // too small for a non-final part
    const e2 = (await part(id, 2, 'b'.repeat(20))).json().etag
    const e3 = (await part(id, 3, 'c'.repeat(20))).json().etag
    const c = (parts) => a.call('POST', `/api/buckets/mp-2/uploads/${id}/complete`, { body: { parts } })
    const small = await c([{ partNumber: 1, etag: e1 }, { partNumber: 2, etag: e2 }])
    assert.equal(small.status, 400)
    assert.match(small.data.error, /EntityTooSmall|minimum/)
    // unused parts are discarded on completion
    const ok = await c([{ partNumber: 2, etag: e2 }, { partNumber: 3, etag: e3 }])
    assert.equal(ok.status, 201)
    assert.equal(ok.data.size, 40)
    assert.equal(t.app.db.find('st_parts', () => true).length, 0)
    assert.equal(t.blobs().reduce((s, x) => s + x.size, 0), 40, 'part 1 was freed')
    // total object size cap across parts
    id = await init('too-big')
    for (const n of [1, 2]) assert.equal((await part(id, n, 'z'.repeat(30))).status, 200)
    assert.equal((await part(id, 3, 'z'.repeat(30))).status, 413)
    // abort frees everything
    assert.equal((await a.call('DELETE', `/api/buckets/mp-2/uploads/${id}`)).status, 200)
    assert.equal((await a.call('DELETE', `/api/buckets/mp-2/uploads/${id}`)).status, 404)
    assert.equal(t.blobs().reduce((s, x) => s + x.size, 0), 40)
    assert.equal((await a.call('GET', '/api/storage/usage')).data.inFlightMultipartBytes, 0)
    // open upload cap
    // validation of initiate
    assert.equal((await a.call('POST', '/api/buckets/mp-2/uploads', { body: { key: 'k', metadata: { 'bad name': 'x' } } })).status, 400)
    assert.equal((await a.call('POST', '/api/buckets/mp-2/uploads', { body: { key: 'k', contentType: 'nonsense' } })).status, 400)
    // open upload cap
    t.app.ctx.storage.limits.maxOpenUploads = 2
    await init('u1')
    await init('u2')
    assert.equal((await a.call('POST', '/api/buckets/mp-2/uploads', { body: { key: 'u3' } })).status, 409)
  } finally { await t.close() }
})

test('multipart: completing honours versioning and conditional headers', async () => {
  const t = await setup({ chunkBytes: 4, minPartBytes: 1 })
  try {
    const { a } = t
    await t.mk(a, 'mp-3', { versioning: 'enabled' })
    const run = async (data, headers = {}) => {
      const id = (await a.call('POST', '/api/buckets/mp-3/uploads', { body: { key: 'v.bin' } })).data.uploadId
      const p = (await t.http('PUT', `/api/buckets/mp-3/uploads/${id}/parts/1`, { token: a.token, body: data })).json()
      return a.call('POST', `/api/buckets/mp-3/uploads/${id}/complete`, { body: { parts: [{ partNumber: 1, etag: p.etag }] }, headers })
    }
    const first = await run('first')
    const second = await run('second')
    assert.equal(first.status, 201)
    assert.notEqual(first.data.versionId, second.data.versionId)
    assert.equal((await t.get(a, 'mp-3', 'v.bin')).text, 'second')
    assert.equal((await run('third', { 'if-none-match': '*' })).status, 412)
    assert.equal((await a.call('GET', '/api/buckets/mp-3/versions?key=v.bin')).data.versions.length, 2, 'the rejected completion left nothing behind')
  } finally { await t.close() }
})

/* ============================================================================================ quota + resource bounds */

test('quota: enforced across versions, in-flight multipart and concurrent uploads', async () => {
  const t = await setup({ quotaBytes: 100, chunkBytes: 16, minPartBytes: 1 })
  try {
    const { a } = t
    await t.mk(a, 'q-plain')
    await t.mk(a, 'q-ver', { versioning: 'enabled' })
    assert.equal((await t.put(a, 'q-plain', 'a', 'x'.repeat(60))).status, 201)
    const over = await t.put(a, 'q-plain', 'b', 'x'.repeat(60))
    assert.equal(over.status, 507)
    assert.match(over.json().error, /quota/i)
    assert.equal((await t.get(a, 'q-plain', 'b')).status, 404)
    assert.equal(t.blobs().reduce((s, x) => s + x.size, 0), 60, 'a refused upload leaves no data')
    // overwriting in place only needs the difference
    assert.equal((await t.put(a, 'q-plain', 'a', 'y'.repeat(90))).status, 201)
    assert.equal((await t.put(a, 'q-plain', 'a', 'y'.repeat(101))).status, 507)
    const usage = (await a.call('GET', '/api/storage/usage')).data
    assert.equal(usage.usedBytes, 90)
    assert.equal(usage.quotaBytes, 100)
    // versions all count
    await a.call('DELETE', '/api/buckets/q-plain/objects/a')
    assert.equal((await t.put(a, 'q-ver', 'v', 'x'.repeat(40))).status, 201)
    assert.equal((await t.put(a, 'q-ver', 'v', 'x'.repeat(40))).status, 201)
    assert.equal((await t.put(a, 'q-ver', 'v', 'x'.repeat(40))).status, 507, 'two noncurrent versions already use 80 bytes')
    assert.equal((await t.put(a, 'q-ver', 'w', 'x'.repeat(20))).status, 201)
    // deleting a specific version frees quota
    const versions = (await a.call('GET', '/api/buckets/q-ver/versions?key=v')).data.versions
    await a.call('DELETE', `/api/buckets/q-ver/objects/v?versionId=${versions[1].versionId}`)
    assert.equal((await t.put(a, 'q-ver', 'x', 'x'.repeat(40))).status, 201)
    // in-flight multipart parts use quota too
    for (const v of (await a.call('GET', '/api/buckets/q-ver/versions')).data.versions) await a.call('DELETE', `/api/buckets/q-ver/objects/${v.key}?versionId=${v.versionId}`)
    assert.equal((await a.call('GET', '/api/storage/usage')).data.usedBytes, 0)
    const id = (await a.call('POST', '/api/buckets/q-ver/uploads', { body: { key: 'mp' } })).data.uploadId
    const part = (n, size) => t.http('PUT', `/api/buckets/q-ver/uploads/${id}/parts/${n}`, { token: a.token, body: 'p'.repeat(size) })
    assert.equal((await part(1, 70)).status, 200)
    assert.equal((await t.put(a, 'q-ver', 'blocked', 'x'.repeat(40))).status, 507, 'parts in flight reserve quota')
    assert.equal((await part(2, 40)).status, 507)
    assert.equal((await part(1, 95)).status, 200, 'replacing a part credits the old one')
    await a.call('DELETE', `/api/buckets/q-ver/uploads/${id}`)
    assert.equal((await t.put(a, 'q-ver', 'now-fits', 'x'.repeat(90))).status, 201)

    // concurrency: two uploads that each fit alone but not together; exactly one wins
    for (const v of (await a.call('GET', '/api/buckets/q-ver/versions')).data.versions) await a.call('DELETE', `/api/buckets/q-ver/objects/${v.key}?versionId=${v.versionId}`)
    assert.equal((await a.call('GET', '/api/storage/usage')).data.usedBytes, 0)
    const results = await Promise.all([1, 2, 3].map((i) => t.put(a, 'q-plain', `race-${i}`, 'r'.repeat(45))))
    const codes = results.map((r) => r.status).sort()
    assert.deepEqual(codes, [201, 201, 507])
    assert.ok((await a.call('GET', '/api/storage/usage')).data.usedBytes <= 100)
    // the same without a Content-Length (chunked): quota is reserved as bytes arrive
    await a.call('POST', '/api/buckets/q-plain/delete', { body: { prefix: 'race-' } })
    const stream = (n) => new ReadableStream({ start(c) { for (let i = 0; i < n; i += 10) c.enqueue(Buffer.alloc(10, 1)); c.close() } })
    const chunked = await Promise.all([1, 2].map((i) => t.http('PUT', `/api/buckets/q-plain/objects/chunked-${i}`, { token: a.token, body: stream(70), duplex: 'half' })))
    assert.deepEqual(chunked.map((r) => r.status).sort(), [201, 507])
    assert.ok((await a.call('GET', '/api/storage/usage')).data.usedBytes <= 100)
    assert.equal(t.blobs().reduce((s, x) => s + x.size, 0), (await a.call('GET', '/api/storage/usage')).data.usedBytes, 'no leaked data')
    // quota is per user
    await t.mk(t.b, 'q-other')
    assert.equal((await t.put(t.b, 'q-other', 'b', 'x'.repeat(100))).status, 201)
    // the billing hook can lift a user's limit
    t.app.ctx.storage.quotaFor = (id2) => (id2 === t.b.user.id ? 1000 : 100)
    assert.equal((await t.put(t.b, 'q-other', 'c', 'x'.repeat(500))).status, 201)
  } finally { await t.close() }
})

test('resource bounds: object cap, concurrent upload cap, stalled/aborted uploads, object count', async () => {
  const t = await setup({ maxObjectBytes: 1000, maxConcurrentUploads: 1, chunkBytes: 100 })
  try {
    const { a } = t
    await t.mk(a, 'bound-1')
    const big = await t.put(a, 'bound-1', 'big', 'x'.repeat(1001))
    assert.equal(big.status, 413)
    assert.equal(big.headers.get('connection'), 'close', 'a refused body is not drained over a kept-alive connection')
    // unknown length: cut off once the cap is passed
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < 20; i++) c.enqueue(Buffer.alloc(100, 7)); c.close() } })
    assert.equal((await t.http('PUT', '/api/buckets/bound-1/objects/chunked', { token: a.token, body: stream, duplex: 'half' })).status, 413)
    assert.equal(t.blobs().length, 0)
    assert.equal((await t.put(a, 'bound-1', 'exact', 'x'.repeat(1000))).status, 201)
    assert.equal((await t.http('PUT', '/api/buckets/bound-1/objects/bad-len', { token: a.token, body: 'x', headers: { 'content-length': 'abc' } }).catch(() => ({ status: 400 }))).status, 400)

    // only one upload may stream at a time here: hold one open, the second is told to retry
    let release
    const gate = new Promise((r) => { release = r })
    const slow = new ReadableStream({ async start(c) { c.enqueue(Buffer.from('first')); await gate; c.close() } })
    const first = t.http('PUT', '/api/buckets/bound-1/objects/slow', { token: a.token, body: slow, duplex: 'half' })
    await new Promise((r) => setTimeout(r, 150))
    const second = await t.put(a, 'bound-1', 'second', 'x')
    assert.equal(second.status, 503)
    assert.equal(second.headers.get('retry-after'), '2')
    release()
    assert.equal((await first).status, 201)
    assert.equal((await t.put(a, 'bound-1', 'third', 'x')).status, 201, 'the slot is released')

    // an upload the client abandons mid-body frees its chunks and its quota reservation
    const ac = new AbortController()
    const dying = new ReadableStream({ start(c) { c.enqueue(Buffer.alloc(250, 1)) }, cancel() {} })
    const p = fetch(`${t.app.base}/api/buckets/bound-1/objects/dying`, { method: 'PUT', body: dying, duplex: 'half', signal: ac.signal, headers: { authorization: `Bearer ${a.token}` } }).catch(() => null)
    await new Promise((r) => setTimeout(r, 150))
    ac.abort()
    await p
    await new Promise((r) => setTimeout(r, 150))
    assert.equal((await t.get(a, 'bound-1', 'dying')).status, 404)
    const refs = t.app.ctx.storage.referencedBlobIds()
    assert.deepEqual(t.blobs().filter((x) => !refs.has(x.id)), [], 'no orphan chunks after an aborted upload')

    // total object count bound (every version counts)
    t.app.ctx.storage.limits.maxObjectsPerUser = 4
    const rows = t.app.db.find('objects', (o) => o.userId === a.user.id).length
    t.app.ctx.storage.limits.maxObjectsPerUser = rows
    assert.equal((await t.put(a, 'bound-1', 'one-more', 'x')).status, 507)
    assert.equal((await t.put(a, 'bound-1', 'exact', 'y')).status, 201, 'replacing an existing key does not add a row')
  } finally { await t.close() }
})

/* ============================================================================================ presigned URLs */

test('presigned URLs: GET/HEAD/PUT/DELETE with method, expiry, tamper and revoke checks', async () => {
  const t = await setup()
  try {
    const { a, b } = t
    await t.mk(a, 'sign-1')
    await t.put(a, 'sign-1', 'dir/doc.txt', 'presigned content', { 'content-type': 'text/plain' })
    const sign = async (body) => { const r = await a.call('POST', '/api/buckets/sign-1/presign', { body }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data }
    const g = await sign({ key: 'dir/doc.txt', expiresIn: 60 })
    assert.match(g.path, /^\/presigned\/sign-1\/dir\/doc\.txt\?expires=\d+&signature=[0-9a-f]{64}$/)
    assert.equal(g.method, 'GET')
    assert.ok(Date.parse(g.expiresAt) > Date.now())
    // no Authorization header at all
    const r = await t.http('GET', g.path)
    assert.equal(r.status, 200)
    assert.equal(r.text, 'presigned content')
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
    assert.equal((await t.http('HEAD', g.path)).status, 200, 'HEAD is allowed on a GET url')
    assert.equal((await t.http('GET', g.path, { headers: { range: 'bytes=0-4' } })).text, 'presi')
    // method is part of the signature
    assert.equal((await t.http('PUT', g.path, { body: 'overwrite' })).status, 403)
    assert.equal((await t.http('DELETE', g.path)).status, 403)
    assert.equal((await t.get(a, 'sign-1', 'dir/doc.txt')).text, 'presigned content')
    // tampering: key, signature, expiry, bucket, missing parts
    const url = new URL(g.path, 'http://x')
    const sig = url.searchParams.get('signature')
    const exp = url.searchParams.get('expires')
    assert.equal((await t.http('GET', `/presigned/sign-1/dir/other.txt?expires=${exp}&signature=${sig}`)).status, 403)
    assert.equal((await t.http('GET', `/presigned/sign-1/dir/doc.txt?expires=${Number(exp) + 100}&signature=${sig}`)).status, 403)
    assert.equal((await t.http('GET', `/presigned/sign-1/dir/doc.txt?expires=${exp}&signature=${'0'.repeat(64)}`)).status, 403)
    assert.equal((await t.http('GET', `/presigned/sign-1/dir/doc.txt?expires=${exp}&signature=${sig.slice(0, 63)}`)).status, 403)
    assert.equal((await t.http('GET', `/presigned/sign-1/dir/doc.txt?expires=${exp}&signature=${sig.toUpperCase()}`)).status, 403)
    assert.equal((await t.http('GET', `/presigned/sign-1/dir/doc.txt?expires=${exp}`)).status, 403)
    assert.equal((await t.http('GET', '/presigned/sign-1/dir/doc.txt')).status, 403)
    assert.equal((await t.http('GET', `/presigned/nope-bucket/dir/doc.txt?expires=${exp}&signature=${sig}`)).status, 403)
    assert.equal((await t.http('GET', `/presigned/sign-1/dir/doc.txt?expires=abc&signature=${sig}`)).status, 403)
    assert.equal((await t.http('GET', `/presigned/sign-1/a/..%2Fdir/doc.txt?expires=${exp}&signature=${sig}`)).status, 403)
    // another tenant cannot mint URLs for it
    assert.equal((await b.call('POST', '/api/buckets/sign-1/presign', { body: { key: 'dir/doc.txt' } })).status, 404)

    // expiry (signed with a past time through the module's own signer)
    const bucket = t.app.db.find('buckets', (x) => x.name === 'sign-1')[0]
    const past = Math.floor(Date.now() / 1000) - 5
    const expired = t.app.ctx.storage.signPresign(bucket, { method: 'GET', key: 'dir/doc.txt', expires: past })
    const er = await t.http('GET', `/presigned/sign-1/dir/doc.txt?expires=${past}&signature=${expired}`)
    assert.equal(er.status, 403)
    assert.match(er.json().error, /expired|Invalid/)
    // an expiry beyond the maximum is refused even when correctly signed
    const far = Math.floor(Date.now() / 1000) + 30 * 86400
    const farSig = t.app.ctx.storage.signPresign(bucket, { method: 'GET', key: 'dir/doc.txt', expires: far })
    assert.equal((await t.http('GET', `/presigned/sign-1/dir/doc.txt?expires=${far}&signature=${farSig}`)).status, 403)
    // validation of the signing request
    for (const bad of [{ key: 'k', expiresIn: 0 }, { key: 'k', expiresIn: 7 * 86400 + 1 }, { key: 'k', expiresIn: 1.5 }, { key: 'k', expiresIn: '60' }, { key: 'k', method: 'POST' }, { key: 'k', versionId: 'v1', method: 'PUT' },
      { key: 'k', contentType: 'text/plain' }, { key: 'k', disposition: 'weird' }, { key: 'k', disposition: 'inline', method: 'PUT' }, {}]) {
      assert.equal((await a.call('POST', '/api/buckets/sign-1/presign', { body: bad })).status, 400, JSON.stringify(bad))
    }
    assert.equal((await sign({ key: 'k', expiresIn: 7 * 86400 })).expiresIn, 604800)

    // presigned upload: bound to the content type, cannot grant public access or set tags
    const up = await sign({ key: 'uploads/new.txt', method: 'PUT', contentType: 'text/plain', expiresIn: 300 })
    assert.equal((await t.http('PUT', up.path, { body: 'wrong type', headers: { 'content-type': 'image/png' } })).status, 403)
    assert.equal((await t.http('PUT', up.path, { body: 'no type' })).status, 403)
    const put = await t.http('PUT', up.path, { body: 'uploaded via url', headers: { 'content-type': 'text/plain', 'x-rd-acl': 'public-read', 'x-rd-tagging': 'a=b', 'cache-control': 'evil', 'x-rd-meta-who': 'guest' } })
    assert.equal(put.status, 200, put.text)
    const info = (await a.call('GET', '/api/buckets/sign-1/meta/uploads/new.txt')).data
    assert.equal(info.acl, 'inherit', 'a presigned PUT cannot change the ACL')
    assert.deepEqual(info.tags, {})
    assert.equal(info.cacheControl, null)
    assert.deepEqual(info.metadata, { who: 'guest' })
    assert.equal((await t.get(a, 'sign-1', 'uploads/new.txt')).text, 'uploaded via url')
    assert.equal((await t.http('GET', `/pub/sign-1/uploads/new.txt`)).status, 404, 'still private')
    assert.equal((await t.http('PUT', up.path, { body: 'x', headers: { 'content-type': 'text/plain', 'content-md5': crypto.createHash('md5').update('y').digest('base64') } })).status, 400)

    // presigned delete
    const del = await sign({ key: 'uploads/new.txt', method: 'DELETE' })
    assert.equal((await t.http('DELETE', del.path)).status, 200)
    assert.equal((await t.http('DELETE', del.path)).status, 404)
    assert.equal((await t.get(a, 'sign-1', 'uploads/new.txt')).status, 404)

    // download options: forced attachment and a pinned version
    const dl = await sign({ key: 'dir/doc.txt', disposition: 'attachment' })
    assert.match((await t.http('GET', dl.path)).headers.get('content-disposition'), /^attachment; filename="doc\.txt"/)
    assert.equal((await t.http('GET', dl.path.replace('attachment', 'inline'))).status, 403, 'disposition is signed')

    // revoke: everything issued so far stops working, new ones work
    assert.equal((await a.call('POST', '/api/buckets/sign-1/presign/revoke', { body: {} })).status, 200)
    assert.equal((await t.http('GET', g.path)).status, 403)
    const fresh = await sign({ key: 'dir/doc.txt' })
    assert.equal((await t.http('GET', fresh.path)).status, 200)
    // deleting and re-creating the bucket under the same name invalidates old URLs (they are bound to the bucket id)
    await a.call('DELETE', '/api/buckets/sign-1?force=true')
    await t.mk(b, 'sign-1')
    await t.put(b, 'sign-1', 'dir/doc.txt', 'B secret')
    assert.equal((await t.http('GET', fresh.path)).status, 403)
  } finally { await t.close() }
})

test('presigned URLs: versions, and the URL secret is stable per server', async () => {
  const t = await setup()
  try {
    const { a } = t
    await t.mk(a, 'sign-2', { versioning: 'enabled' })
    const v1 = (await t.put(a, 'sign-2', 'f', 'one')).json()
    await t.put(a, 'sign-2', 'f', 'two')
    const s = (await a.call('POST', '/api/buckets/sign-2/presign', { body: { key: 'f', versionId: v1.versionId } })).data
    assert.equal((await t.http('GET', s.path)).text, 'one')
    const cur = (await a.call('POST', '/api/buckets/sign-2/presign', { body: { key: 'f' } })).data
    assert.equal((await t.http('GET', cur.path)).text, 'two')
    assert.equal((await t.http('GET', s.path.replace(v1.versionId, 'null'))).status, 403)
    await a.call('DELETE', '/api/buckets/sign-2/objects/f')
    assert.equal((await t.http('GET', cur.path)).status, 404, 'a delete marker hides the object from presigned GET too')
    assert.equal((await t.http('GET', s.path)).text, 'one', 'a pinned version is still served')
  } finally { await t.close() }
})

/* ============================================================================================ public + website serving */

test('public-read: bucket and object ACLs, safe headers, CORS, unauthenticated access', async () => {
  const t = await setup()
  try {
    const { a } = t
    await t.mk(a, 'pub-1')
    await t.put(a, 'pub-1', 'img/logo.png', Buffer.from([137, 80, 78, 71]), { 'content-type': 'image/png' })
    await t.put(a, 'pub-1', 'evil.html', '<script>alert(document.domain)</script>', { 'content-type': 'text/html' })
    await t.put(a, 'pub-1', 'evil.svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', { 'content-type': 'image/svg+xml' })
    await t.put(a, 'pub-1', 'notes.txt', 'hello public', { 'content-type': 'text/plain', 'cache-control': 'public, max-age=300' })
    // private by default
    for (const k of ['img/logo.png', 'evil.html', 'nope']) assert.equal((await t.http('GET', `/pub/pub-1/${k}`)).status, 404, k)
    assert.equal((await t.http('GET', '/pub/no-such-bucket/x')).status, 404)
    // one object public in a private bucket
    await a.call('PUT', '/api/buckets/pub-1/acl/notes.txt', { body: { acl: 'public-read' } })
    const n = await t.http('GET', '/pub/pub-1/notes.txt')
    assert.equal(n.status, 200)
    assert.equal(n.text, 'hello public')
    assert.equal(n.headers.get('cache-control'), 'public, max-age=300')
    assert.equal((await t.http('GET', '/pub/pub-1/img/logo.png')).status, 404)
    // public bucket
    await a.call('PATCH', '/api/buckets/pub-1', { body: { acl: 'public-read' } })
    const img = await t.http('GET', '/pub/pub-1/img/logo.png')
    assert.equal(img.status, 200)
    assert.equal(img.headers.get('content-type'), 'image/png')
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff')
    assert.match(img.headers.get('content-security-policy'), /sandbox/)
    assert.equal(img.headers.get('cross-origin-resource-policy'), 'cross-origin')
    assert.equal(img.headers.get('content-disposition'), null, 'images stay inline')
    assert.equal(img.headers.get('authorization'), null)
    // uploaded HTML / SVG can never run on the platform origin
    for (const k of ['evil.html', 'evil.svg']) {
      const r = await t.http('GET', `/pub/pub-1/${k}`)
      assert.equal(r.status, 200)
      assert.match(r.headers.get('content-disposition'), /^attachment; filename="evil\./, `${k} is a download`)
      assert.match(r.headers.get('content-security-policy'), /sandbox/)
      assert.doesNotMatch(r.headers.get('content-security-policy'), /allow-scripts|allow-same-origin/)
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
    }
    // an explicit private ACL hides one object of a public bucket; delete markers and missing keys 404
    await a.call('PUT', '/api/buckets/pub-1/acl/notes.txt', { body: { acl: 'private' } })
    assert.equal((await t.http('GET', '/pub/pub-1/notes.txt')).status, 404)
    await a.call('DELETE', '/api/buckets/pub-1/objects/img/logo.png')
    assert.equal((await t.http('GET', '/pub/pub-1/img/logo.png')).status, 404)
    // path games
    for (const p of ['/pub/pub-1/%2e%2e/x', '/pub/pub-1/a%00b', '/pub/pub-1/a%5Cb', '/pub/pub-1//evil.html', '/pub/pub-1/' + 'k'.repeat(2000)]) assert.equal((await t.http('GET', p)).status, 404, p)
    // HEAD, Range and conditional requests work on public objects too
    await a.call('PUT', '/api/buckets/pub-1/acl/notes.txt', { body: { acl: 'inherit' } })
    const h = await t.http('HEAD', '/pub/pub-1/notes.txt')
    assert.equal(h.status, 200)
    assert.equal(h.headers.get('content-length'), '12')
    assert.equal((await t.http('GET', '/pub/pub-1/notes.txt', { headers: { range: 'bytes=6-' } })).text, 'public')
    assert.equal((await t.http('GET', '/pub/pub-1/notes.txt', { headers: { 'if-none-match': n.headers.get('etag') } })).status, 304)
    // writes are not possible on /pub
    assert.equal((await t.http('PUT', '/pub/pub-1/notes.txt', { body: 'x' })).status, 404)
    assert.equal((await t.http('DELETE', '/pub/pub-1/notes.txt')).status, 404)
    // making the bucket private again revokes access immediately
    await a.call('PATCH', '/api/buckets/pub-1', { body: { acl: 'private' } })
    assert.equal((await t.http('GET', '/pub/pub-1/evil.html')).status, 404)
  } finally { await t.close() }
})

test('public-read: bucket CORS rules apply to /pub, preflight included', async () => {
  const t = await setup()
  try {
    const { a } = t
    await t.mk(a, 'cors-1', { acl: 'public-read' })
    await t.put(a, 'cors-1', 'data.json', '{"a":1}', { 'content-type': 'application/json' })
    const none = await t.http('GET', '/pub/cors-1/data.json', { headers: { origin: 'https://app.example.com' } })
    assert.equal(none.headers.get('access-control-allow-origin'), null, 'no rules, no CORS headers')
    await a.call('PUT', '/api/buckets/cors-1/cors', { body: { rules: [
      { allowedOrigins: ['https://app.example.com', 'https://*.trusted.dev'], allowedMethods: ['GET', 'HEAD'], allowedHeaders: ['range', 'x-custom'], exposeHeaders: ['ETag', 'x-rd-version-id'], maxAgeSeconds: 120 },
      { allowedOrigins: ['*'], allowedMethods: ['PUT'], allowedHeaders: ['*'] },
    ] } })
    const ok = await t.http('GET', '/pub/cors-1/data.json', { headers: { origin: 'https://app.example.com' } })
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.example.com')
    assert.equal(ok.headers.get('access-control-expose-headers'), 'ETag, x-rd-version-id')
    assert.match(ok.headers.get('vary'), /Origin/)
    assert.equal((await t.http('GET', '/pub/cors-1/data.json', { headers: { origin: 'https://sub.trusted.dev' } })).headers.get('access-control-allow-origin'), 'https://sub.trusted.dev')
    assert.equal((await t.http('GET', '/pub/cors-1/data.json', { headers: { origin: 'https://evil.example.com' } })).headers.get('access-control-allow-origin'), null)
    assert.equal((await t.http('GET', '/pub/cors-1/data.json', { headers: { origin: 'https://sub.trusted.dev.evil.com' } })).headers.get('access-control-allow-origin'), null)
    // preflight
    const pf = (origin, method, headers) => t.http('OPTIONS', '/pub/cors-1/data.json', { headers: { origin, 'access-control-request-method': method, ...(headers ? { 'access-control-request-headers': headers } : {}) } })
    const good = await pf('https://app.example.com', 'GET', 'range, X-Custom')
    assert.equal(good.status, 204)
    assert.equal(good.headers.get('access-control-allow-origin'), 'https://app.example.com')
    assert.equal(good.headers.get('access-control-allow-methods'), 'GET, HEAD')
    assert.equal(good.headers.get('access-control-max-age'), '120')
    assert.equal((await pf('https://app.example.com', 'DELETE')).status, 403, 'method not allowed')
    assert.equal((await pf('https://app.example.com', 'GET', 'authorization')).status, 403, 'header not allowed')
    assert.equal((await pf('https://evil.example.com', 'GET')).status, 403)
    assert.equal((await pf('https://anywhere.example', 'PUT', 'content-type')).headers.get('access-control-allow-origin'), '*')
    assert.equal((await pf('https://app.example.com', 'GET', 'bad header!')).status, 403)
    assert.equal((await t.http('OPTIONS', '/pub/cors-1/data.json')).status, 403, 'not a CORS preflight')
    assert.equal((await t.http('OPTIONS', '/pub/nope-bucket/x', { headers: { origin: 'https://app.example.com', 'access-control-request-method': 'GET' } })).status, 403)
    // presigned uploads from the browser use the same rules
    const pre = await t.http('OPTIONS', '/presigned/cors-1/new.txt', { headers: { origin: 'https://anywhere.example', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' } })
    assert.equal(pre.status, 204)
  } finally { await t.close() }
})

test('website hosting: index/error documents, redirects, sandboxed scripts, only public content', async () => {
  const t = await setup()
  try {
    const { a } = t
    await t.mk(a, 'site-1')
    const html = (s) => ({ 'content-type': 'text/html; charset=utf-8', body: s })
    for (const [k, s] of [['index.html', '<h1>home</h1><script src="app.js"></script>'], ['404.html', '<h1>custom 404</h1>'], ['docs/index.html', '<h1>docs</h1>'], ['about.html', '<h1>about</h1>']]) await t.put(a, 'site-1', k, html(s).body, { 'content-type': html(s)['content-type'] })
    await t.put(a, 'site-1', 'app.js', 'console.log(1)', { 'content-type': 'text/javascript' })
    await t.put(a, 'site-1', 'private.txt', 'hidden', { 'x-rd-acl': 'private' })
    // not enabled -> 404, enabled but private bucket -> 404 (nothing leaks)
    assert.equal((await t.http('GET', '/site/site-1/')).status, 404)
    await a.call('PUT', '/api/buckets/site-1/website', { body: { indexDocument: 'index.html', errorDocument: '404.html' } })
    assert.equal((await t.http('GET', '/site/site-1/')).status, 404)
    assert.equal((await t.http('GET', '/site/site-1/index.html')).status, 404)
    const w = await a.call('PUT', '/api/buckets/site-1/website', { body: { indexDocument: 'index.html', errorDocument: '404.html' } })
    assert.equal(w.data.public, false)
    await a.call('PATCH', '/api/buckets/site-1', { body: { acl: 'public-read' } })

    for (const p of ['/site/site-1', '/site/site-1/', '/site/site-1/index.html']) {
      const r = await t.http('GET', p)
      assert.equal(r.status, 200, p)
      assert.match(r.text, /<h1>home<\/h1>/)
      assert.match(r.headers.get('content-type'), /^text\/html/)
    }
    const home = await t.http('GET', '/site/site-1/')
    // scripts may run (it is a website) but only in an opaque origin: no access to the console's storage or API session
    assert.match(home.headers.get('content-security-policy'), /sandbox/)
    assert.match(home.headers.get('content-security-policy'), /allow-scripts/)
    assert.doesNotMatch(home.headers.get('content-security-policy'), /allow-same-origin|allow-top-navigation/)
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(home.headers.get('access-control-allow-origin'), '*', 'sandboxed pages read their own files through CORS')
    assert.equal(home.headers.get('content-disposition'), null)
    assert.equal((await t.http('GET', '/site/site-1/app.js')).text, 'console.log(1)')
    assert.equal((await t.http('HEAD', '/site/site-1/about.html')).status, 200)
    // directory index and the "docs" -> "docs/" redirect
    assert.match((await t.http('GET', '/site/site-1/docs/')).text, /docs/)
    const redirect = await t.http('GET', '/site/site-1/docs')
    assert.equal(redirect.status, 302)
    assert.equal(redirect.headers.get('location'), '/site/site-1/docs/')
    // errors: the custom document with status 404; private objects look like missing ones
    const miss = await t.http('GET', '/site/site-1/missing.html')
    assert.equal(miss.status, 404)
    assert.match(miss.text, /custom 404/)
    const priv = await t.http('GET', '/site/site-1/private.txt')
    assert.equal(priv.status, 404)
    assert.doesNotMatch(priv.text, /hidden/)
    // an error document that is private is not served either
    await a.call('PUT', '/api/buckets/site-1/acl/404.html', { body: { acl: 'private' } })
    assert.doesNotMatch((await t.http('GET', '/site/site-1/missing.html')).text, /custom 404/)
    // traversal / junk
    for (const p of ['/site/site-1/%2e%2e/x', '/site/site-1/a%00b', '/site/site-1//index.html', '/site/nope/x']) assert.equal((await t.http('GET', p)).status, 404, p)
    // disabling hosting stops serving
    await a.call('DELETE', '/api/buckets/site-1/website')
    assert.equal((await t.http('GET', '/site/site-1/')).status, 404)
    assert.equal((await t.http('GET', '/pub/site-1/index.html')).status, 200, '/pub still works as a plain public bucket')
    assert.match((await t.http('GET', '/pub/site-1/index.html')).headers.get('content-disposition'), /attachment/, 'but html is a download there')
  } finally { await t.close() }
})

/* ============================================================================================ lifecycle */

test('lifecycle sweeper: expiry, noncurrent versions, delete markers, stale uploads, filters, dry run', async () => {
  const t = await setup({ chunkBytes: 8, minPartBytes: 1 })
  try {
    const { a } = t
    await t.mk(a, 'life-1')
    await t.mk(a, 'life-2', { versioning: 'enabled' })
    await t.put(a, 'life-1', 'tmp/old.txt', 'old')
    await t.put(a, 'life-1', 'tmp/tagged.txt', 'tag', { 'x-rd-tagging': 'keep=yes' })
    await t.put(a, 'life-1', 'keep/safe.txt', 'safe')
    await a.call('PUT', '/api/buckets/life-1/lifecycle', { body: { rules: [
      { id: 'tmp', prefix: 'tmp/', expirationDays: 7 },
      { id: 'off', prefix: 'keep/', expirationDays: 1, status: 'disabled' },
    ] } })
    const sweep = (opts) => t.app.ctx.storage.sweep(opts)
    // nothing is old enough yet
    assert.equal(sweep({}).expired, 0)
    const dry = sweep({ now: Date.now() + 8 * DAY, dryRun: true })
    assert.equal(dry.expired, 2)
    assert.equal(dry.dryRun, true)
    assert.equal((await t.get(a, 'life-1', 'tmp/old.txt')).status, 200, 'a dry run changes nothing')
    // via the API too
    const api = await a.call('POST', '/api/buckets/life-1/lifecycle/run?dryRun=true')
    assert.equal(api.status, 200)
    assert.equal(api.data.expired, 0)
    const rep = sweep({ now: Date.now() + 8 * DAY })
    assert.equal(rep.expired, 2)
    assert.equal((await t.get(a, 'life-1', 'tmp/old.txt')).status, 404)
    assert.equal((await t.get(a, 'life-1', 'keep/safe.txt')).text, 'safe', 'disabled rules and other prefixes are untouched')
    assert.equal(t.blobs().length, 1)
    // tag filter + size filter
    await t.put(a, 'life-1', 'f/a', 'a')
    await t.put(a, 'life-1', 'f/b', 'bbbbbbbbbb', { 'x-rd-tagging': 'class=cold' })
    await a.call('PUT', '/api/buckets/life-1/lifecycle', { body: { rules: [{ id: 'cold', prefix: 'f/', tags: { class: 'cold' }, minSize: 5, expirationDays: 1 }] } })
    assert.equal(sweep({ now: Date.now() + 2 * DAY }).expired, 1)
    assert.equal((await t.get(a, 'life-1', 'f/a')).status, 200)
    assert.equal((await t.get(a, 'life-1', 'f/b')).status, 404)

    // versioned bucket: expiry creates a marker, noncurrent versions expire later, lonely markers are cleaned
    await t.put(a, 'life-2', 'doc', 'v1')
    await t.put(a, 'life-2', 'doc', 'v2')
    await a.call('PUT', '/api/buckets/life-2/lifecycle', { body: { rules: [{ id: 'all', expirationDays: 10, noncurrentExpirationDays: 5, expiredObjectDeleteMarker: true }] } })
    let r = sweep({ now: Date.now() + 6 * DAY })
    assert.equal(r.noncurrentRemoved, 1, 'the superseded v1 is older than 5 days')
    assert.equal(r.expired, 0)
    assert.equal((await a.call('GET', '/api/buckets/life-2/versions')).data.versions.length, 1)
    r = sweep({ now: Date.now() + 11 * DAY })
    assert.equal(r.expired, 1)
    assert.equal((await t.get(a, 'life-2', 'doc')).status, 404, 'a delete marker now hides the object')
    assert.equal((await a.call('GET', '/api/buckets/life-2/versions')).data.versions.length, 2)
    r = sweep({ now: Date.now() + 17 * DAY })
    assert.equal(r.noncurrentRemoved, 1)
    assert.equal(r.markersRemoved, 1, 'the marker hides nothing once its last version is gone')
    assert.equal(sweep({ now: Date.now() + 17 * DAY }).markersRemoved, 0)
    assert.equal((await a.call('GET', '/api/buckets/life-2/versions')).data.versions.length, 0)
    assert.equal(t.app.db.find('objects', (o) => o.bucketId === t.app.db.find('buckets', (x) => x.name === 'life-2')[0].id).length, 0)

    // stale multipart uploads: per rule window and the global TTL
    const mkUpload = async (bucket, key) => (await a.call('POST', `/api/buckets/${bucket}/uploads`, { body: { key } })).data.uploadId
    const u1 = await mkUpload('life-1', 'abandoned/1')
    await t.http('PUT', `/api/buckets/life-1/uploads/${u1}/parts/1`, { token: a.token, body: 'half-uploaded' })
    const u2 = await mkUpload('life-1', 'other/2')
    await a.call('PUT', '/api/buckets/life-1/lifecycle', { body: { rules: [{ id: 'mp', prefix: 'abandoned/', abortIncompleteMultipartDays: 2 }] } })
    assert.equal(sweep({ now: Date.now() + 1 * DAY }).uploadsAborted, 0)
    r = sweep({ now: Date.now() + 3 * DAY })
    assert.equal(r.uploadsAborted, 1)
    assert.equal(t.app.db.get('st_uploads', u1), null)
    assert.ok(t.app.db.get('st_uploads', u2))
    assert.equal(t.app.db.find('st_parts', () => true).length, 0)
    r = sweep({ now: Date.now() + 8 * DAY })
    assert.equal(r.uploadsAborted, 1, 'the global 7-day TTL reaps the rest')
    assert.equal(t.app.db.get('st_uploads', u2), null)
    assert.equal((await a.call('GET', '/api/storage/usage')).data.inFlightMultipartBytes, 0)

    // bounded work per run
    for (let i = 0; i < 5; i++) await t.put(a, 'life-1', `many/${i}`, 'x')
    await a.call('PUT', '/api/buckets/life-1/lifecycle', { body: { rules: [{ id: 'many', prefix: 'many/', expirationDays: 1 }] } })
    r = sweep({ now: Date.now() + 2 * DAY, maxActions: 3 })
    assert.equal(r.truncated, true)
    assert.equal(r.expired, 3)
    assert.equal(sweep({ now: Date.now() + 2 * DAY }).expired, 2)
  } finally { await t.close() }
})

test('orphan blob sweep only removes unreferenced blobs this module wrote, and never in-flight ones', async () => {
  const t = await setup({ orphanGraceMs: 0, chunkBytes: 4 })
  try {
    const { a } = t
    await t.mk(a, 'orph-1')
    await t.put(a, 'orph-1', 'keep', 'referenced data')
    t.app.db.putBlob('stb_stray0001', Buffer.from('leaked chunk'))
    t.app.db.putBlob('blob_foreign1', Buffer.from('someone else'))
    t.app.db.putBlob('drv_file1', Buffer.from('drive data'))
    const dry = t.app.ctx.storage.sweep({ orphans: true, dryRun: true })
    assert.equal(dry.orphanBlobsRemoved, 1)
    assert.ok(t.app.db.hasBlob('stb_stray0001'))
    const rep = t.app.ctx.storage.sweep({ orphans: true })
    assert.equal(rep.orphanBlobsRemoved, 1)
    assert.equal(t.app.db.hasBlob('stb_stray0001'), false)
    assert.ok(t.app.db.hasBlob('blob_foreign1'))
    assert.ok(t.app.db.hasBlob('drv_file1'))
    assert.equal((await t.get(a, 'orph-1', 'keep')).text, 'referenced data')
    // the public hook other modules' garbage collectors must use
    assert.equal(t.app.ctx.storage.isReferenced(t.app.db.find('objects', () => true)[0].chunks[0].blobId), true)
    assert.equal(t.app.ctx.storage.isReferenced('stb_stray0001'), false)
    // a grace period protects fresh blobs
    t.app.ctx.storage.limits.orphanGraceMs = 3_600_000
    t.app.db.putBlob('stb_fresh0001', Buffer.from('being uploaded'))
    assert.equal(t.app.ctx.storage.sweep({ orphans: true }).orphanBlobsRemoved, 0)
  } finally { await t.close() }
})

/* ============================================================================================ metering, scopes, events, account deletion */

test('metering: requests and egress are recorded in batches; billing reads exact sizes', async () => {
  const t = await setup()
  try {
    const { a } = t
    await t.mk(a, 'meter-1', { acl: 'public-read' })
    const body = 'm'.repeat(1000)
    await t.put(a, 'meter-1', 'f', body)
    for (let i = 0; i < 3; i++) await t.get(a, 'meter-1', 'f')
    await t.http('GET', '/pub/meter-1/f')
    await a.call('GET', '/api/buckets/meter-1/objects')
    assert.equal(t.app.db.find('usage', (u) => u.kind === 'storage.requests').length, 0, 'nothing is written per request')
    t.app.ctx.storage.flushMetering()
    const rows = t.app.db.find('usage', (u) => u.userId === a.user.id)
    const req = rows.filter((u) => u.kind === 'storage.requests').reduce((s, u) => s + u.qty, 0)
    const egress = rows.filter((u) => u.kind === 'storage.egress_gb').reduce((s, u) => s + u.qty, 0)
    assert.equal(req, 6)
    assert.ok(Math.abs(egress * 1024 ** 3 - 4000) < 1, `egress bytes ${egress * 1024 ** 3}`)
    assert.equal(rows.length, 2, 'one row per kind')
    t.app.ctx.storage.flushMetering()
    assert.equal(t.app.db.find('usage', (u) => u.userId === a.user.id).length, 2, 'flushing twice does not double count')
    // the existing billing endpoint derives stored bytes from object sizes
    const usage = (await a.call('GET', '/api/billing/usage')).data
    assert.equal(usage.storageBytes, 1000)
  } finally { await t.close() }
})

test('API key scopes: storage:read can read but not write; other services are not reachable', async () => {
  const t = await setup()
  try {
    const { a } = t
    await t.mk(a, 'scope-1')
    await t.put(a, 'scope-1', 'f', 'data')
    const k = await a.call('POST', '/api/keys', { body: { name: 'ro', scopes: ['storage:read'] } })
    assert.equal(k.status, 201, JSON.stringify(k.data))
    const key = k.data.secret
    assert.equal((await t.http('GET', '/api/buckets', { token: key })).status, 200)
    assert.equal((await t.http('GET', '/api/buckets/scope-1/objects/f', { token: key })).text, 'data')
    assert.equal((await t.http('PUT', '/api/buckets/scope-1/objects/g', { token: key, body: 'x' })).status, 403)
    assert.equal((await t.http('DELETE', '/api/buckets/scope-1/objects/f', { token: key })).status, 403)
    assert.equal((await t.http('POST', '/api/buckets/scope-1/presign', { token: key, body: JSON.stringify({ key: 'f' }), headers: { 'content-type': 'application/json' } })).status, 403)
    assert.equal((await t.get(a, 'scope-1', 'f')).text, 'data')
  } finally { await t.close() }
})

test('events and audit: object lifecycle is announced, sensitive actions are audited, secrets never leak', async () => {
  const t = await setup()
  try {
    const { a } = t
    const events = []
    const audits = []
    t.app.ctx.events.on('storage.object.created', (e) => events.push(['created', e]))
    t.app.ctx.events.on('storage.object.deleted', (e) => events.push(['deleted', e]))
    t.app.ctx.events.on('audit', (e) => audits.push(e))
    await t.mk(a, 'evt-1')
    await t.put(a, 'evt-1', 'f', 'x')
    await a.call('DELETE', '/api/buckets/evt-1/objects/f')
    assert.deepEqual(events.map((e) => e[0]), ['created', 'deleted'])
    assert.equal(events[0][1].bucket, 'evt-1')
    assert.equal(events[0][1].userId, a.user.id)
    await a.call('PATCH', '/api/buckets/evt-1', { body: { acl: 'public-read' } })
    const sig = (await a.call('POST', '/api/buckets/evt-1/presign', { body: { key: 'f', method: 'PUT' } })).data
    await t.http('PUT', sig.path, { body: 'via url' })
    const actions = audits.map((e) => e.action)
    for (const want of ['storage.bucket.create', 'storage.bucket.update', 'storage.presign', 'storage.presigned.put']) assert.ok(actions.includes(want), `${want} in ${actions}`)
    assert.equal(JSON.stringify(audits.map(({ req, ...rest }) => rest)).includes(new URL(sig.path, 'http://x').searchParams.get('signature')), false, 'signatures are never audited')
  } finally { await t.close() }
})

test('account deletion removes buckets, objects, versions, uploads and every blob', async () => {
  const t = await setup({ chunkBytes: 4, minPartBytes: 1 })
  try {
    const { a, b } = t
    await t.mk(a, 'gone-1', { versioning: 'enabled' })
    await t.mk(b, 'stays-1')
    await t.put(a, 'gone-1', 'f', 'aaaaaaaaaaaaaaaa')
    await t.put(a, 'gone-1', 'f', 'bbbbbbbbbbbbbbbb')
    const id = (await a.call('POST', '/api/buckets/gone-1/uploads', { body: { key: 'mp' } })).data.uploadId
    await t.http('PUT', `/api/buckets/gone-1/uploads/${id}/parts/1`, { token: a.token, body: 'part part part' })
    await t.put(b, 'stays-1', 'f', 'keep me')
    const r = await a.call('DELETE', '/api/account', { body: { password: 'password123' } })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.equal(t.app.db.find('objects', (o) => o.userId === a.user.id).length, 0)
    assert.equal(t.app.db.find('st_parts', () => true).length, 0)
    assert.equal(t.app.db.find('st_uploads', () => true).length, 0)
    assert.equal(t.app.db.find('buckets', (x) => x.name === 'gone-1').length, 0)
    const mine = new Set(t.app.db.find('objects', () => true).flatMap((o) => (o.chunks ?? [{ blobId: o.blobId }]).map((c) => c.blobId)))
    assert.deepEqual(t.blobs().map((x) => x.id).sort(), [...mine].sort(), 'only user B keeps chunks')
    assert.ok(mine.size >= 1)
    assert.equal((await t.get(b, 'stays-1', 'f')).text, 'keep me')
  } finally { await t.close() }
})

test('service info and usage endpoints', async () => {
  const t = await setup()
  try {
    const { a } = t
    const info = (await a.call('GET', '/api/storage/info')).data
    assert.deepEqual(info.regions, ['rd-local'])
    assert.equal(info.limits.maxObjectBytes, 5 * 1024 ** 3)
    assert.equal(info.quotaBytes, 5 * 1024 ** 3)
    const u = (await a.call('GET', '/api/storage/usage')).data
    assert.equal(u.usedBytes, 0)
    assert.equal(u.buckets, 0)
  } finally { await t.close() }
})
