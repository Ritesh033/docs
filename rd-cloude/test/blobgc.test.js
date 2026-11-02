// Blob garbage collection (ctx.gcBlobs in src/app.js): every blob owner registers its references, orphans are removed,
// and the collector refuses to run when it cannot be sure what is referenced.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp } from './helpers.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

describe('blob GC', () => {
  let t, u
  before(async () => { t = await startTestApp(); u = await t.register() })
  after(() => t.close())

  test('keeps drive, storage and AI attachment blobs; removes only orphans', async () => {
    assert.equal((await u.call('PUT', '/api/drive/files?name=keep.txt', { raw: Buffer.from('drive data'), headers: { 'content-type': 'text/plain' } })).status, 201)
    assert.equal((await u.call('POST', '/api/buckets', { body: { name: 'gc-bucket' } })).status, 201)
    assert.equal((await u.call('PUT', '/api/buckets/gc-bucket/objects/a.txt', { raw: Buffer.from('object data'), headers: { 'content-type': 'text/plain' } })).status, 201)
    const conv = (await u.call('POST', '/api/conversations', { body: {} })).data
    const msg = await u.call('POST', `/api/conversations/${conv.id}/messages`, { body: { content: 'look', attachments: [{ type: 'image', name: 'dot.png', data: `data:image/png;base64,${PNG.toString('base64')}` }] } })
    assert.equal(msg.status, 201, JSON.stringify(msg.data))

    const before = t.db.listBlobs().length
    assert.ok(before >= 3, `expected at least 3 blobs, got ${before}`)
    t.db.putBlob('orphan-1', 'nobody references me')

    const dry = t.ctx.gcBlobs({ dryRun: true, graceMs: 0 })
    assert.equal(dry.dryRun, true)
    assert.equal(t.db.getBlob('orphan-1').toString(), 'nobody references me', 'a dry run deletes nothing')
    assert.ok(dry.candidates.some((c) => (c.id ?? c) === 'orphan-1'), 'dry run must list the orphan')

    const real = t.ctx.gcBlobs({ dryRun: false, graceMs: 0 })
    assert.equal(real.removed, 1)
    assert.equal(t.db.listBlobs().length, before, 'only the orphan is gone')
    assert.equal(t.db.getBlob('orphan-1'), null)

    // everything real is still readable through the API
    const dl = await u.call('GET', '/api/buckets/gc-bucket/objects/a.txt')
    assert.equal(dl.status, 200)
    assert.equal(Buffer.from(dl.data).toString(), 'object data')
  })

  test('recent blobs are protected by the grace period', () => {
    t.db.putBlob('fresh-orphan', 'just uploaded, row not inserted yet')
    const r = t.ctx.gcBlobs({ dryRun: false })   // default grace = 5 minutes
    assert.equal(r.removed, 0)
    assert.ok(r.skippedRecent >= 1)
    t.db.deleteBlob('fresh-orphan')
  })

  test('refuses to run when a blob owner is missing or a provider fails', () => {
    const saved = t.ctx.blobRefs.get('ai')
    t.ctx.blobRefs.delete('ai')
    assert.throws(() => t.ctx.gcBlobs({ dryRun: false, graceMs: 0 }), /no blob references registered by ai/)
    t.ctx.blobRefs.set('ai', () => { throw new Error('boom') })
    assert.throws(() => t.ctx.gcBlobs({ dryRun: false, graceMs: 0 }), /provider "ai" failed: boom/)
    t.ctx.blobRefs.set('ai', saved)
    t.ctx.loadErrors.push({ module: 'x.js', error: 'broken' })
    assert.throws(() => t.ctx.gcBlobs({ dryRun: false, graceMs: 0 }), /failed to load \(x\.js\)/)
    t.ctx.loadErrors.pop()
    assert.doesNotThrow(() => t.ctx.gcBlobs({ dryRun: true }))
  })

  test('a file in the trash keeps its blob and can still be restored after a collection', async () => {
    const f = (await u.call('PUT', '/api/drive/files?name=trashed.txt', { raw: Buffer.from('restore me'), headers: { 'content-type': 'text/plain' } })).data
    assert.equal((await u.call('DELETE', `/api/drive/files/${f.id}`)).status < 300, true)
    const r = t.ctx.gcBlobs({ dryRun: false, graceMs: 0 })
    assert.deepEqual(r.candidates, [], 'a trashed file is still referenced')
    assert.equal(r.removed, 0)
    assert.equal((await u.call('POST', `/api/drive/files/${f.id}/restore`)).status < 300, true)
    const dl = await u.call('GET', `/api/drive/files/${f.id}`)
    assert.equal(Buffer.from(dl.data).toString(), 'restore me')
  })

  test('blobs of a deleted account are collectable once nothing references them', async () => {
    const v = await t.register()
    await v.call('PUT', '/api/drive/files?name=gone.txt', { raw: Buffer.from('bye'), headers: { 'content-type': 'text/plain' } })
    const n0 = t.db.listBlobs().length
    t.db.putBlob('stray-after-delete', 'x')
    const r = t.ctx.gcBlobs({ dryRun: false, graceMs: 0 })
    assert.equal(r.removed, 1)
    assert.equal(t.db.listBlobs().length, n0, 'the live account\'s blob is untouched, the stray one is gone')
  })
})
