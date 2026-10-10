// Object storage service module (auto-loaded by src/app.js).
import { HttpError, required } from '../http.js'

export function register(r, db, ctx) {
  // ---- Object storage ----
  r.get('/api/buckets', ({ user }) => ({
    buckets: db.find('buckets', (b) => b.userId === user.id).map((b) => {
      const objs = db.find('objects', (o) => o.bucketId === b.id)
      return { ...b, objectCount: objs.length, sizeBytes: objs.reduce((s, o) => s + o.size, 0) }
    }),
  }))
  r.post('/api/buckets', ({ user, body }) => {
    required(body, 'name')
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(body.name)) throw new HttpError(400, 'Bucket name must be 3-63 chars: lowercase letters, digits, hyphens')
    if (db.findOne('buckets', (b) => b.name === body.name)) throw new HttpError(409, 'Bucket name already taken')
    return [201, db.insert('buckets', { userId: user.id, name: body.name })]
  })
  const bucket = (user, name) => {
    const b = db.findOne('buckets', (x) => x.name === name && x.userId === user.id)
    if (!b) throw new HttpError(404, 'Bucket not found')
    return b
  }
  r.delete('/api/buckets/:bucket', ({ user, params }) => {
    const b = bucket(user, params.bucket)
    if (db.findOne('objects', (o) => o.bucketId === b.id)) throw new HttpError(409, 'Bucket is not empty')
    db.remove('buckets', b.id)
    return { ok: true }
  })
  r.get('/api/buckets/:bucket/objects', ({ user, params, query }) => {
    const b = bucket(user, params.bucket)
    const prefix = query.get('prefix') ?? ''
    return { objects: db.find('objects', (o) => o.bucketId === b.id && o.key.startsWith(prefix)).map(({ blobId, ...o }) => o) }
  })
  r.put('/api/buckets/:bucket/objects/*key', ({ user, params, raw, req }) => {
    const b = bucket(user, params.bucket)
    const old = db.findOne('objects', (o) => o.bucketId === b.id && o.key === params.key)
    if (old) { db.deleteBlob(old.blobId); db.remove('objects', old.id) }
    const blobId = db.id('blob')
    db.putBlob(blobId, raw)
    const { blobId: _, ...pub } = db.insert('objects', { userId: user.id, bucketId: b.id, key: params.key, size: raw.length, contentType: req.headers['content-type'] || 'application/octet-stream', blobId })
    return [201, pub]
  }, { raw: true })
  r.get('/api/buckets/:bucket/objects/*key', ({ user, params }) => {
    const b = bucket(user, params.bucket)
    const o = db.findOne('objects', (x) => x.bucketId === b.id && x.key === params.key)
    if (!o) throw new HttpError(404, 'Object not found')
    return { binary: db.getBlob(o.blobId), type: o.contentType }
  })
  r.delete('/api/buckets/:bucket/objects/*key', ({ user, params }) => {
    const b = bucket(user, params.bucket)
    const o = db.findOne('objects', (x) => x.bucketId === b.id && x.key === params.key)
    if (!o) throw new HttpError(404, 'Object not found')
    db.deleteBlob(o.blobId)
    db.remove('objects', o.id)
    return { ok: true }
  })

}
