// Cloud infrastructure services: compute instances, object storage buckets, document database.
import { HttpError, required } from './http.js'
import { INSTANCE_TYPES, instanceHours } from './billing.js'

export function cloudRoutes(r, db) {
  const own = (col, id, user) => {
    const row = db.get(col, id)
    if (!row || row.userId !== user.id) throw new HttpError(404, 'Not found')
    return row
  }

  // ---- Compute (simulated VM lifecycle with real metering) ----
  const view = (i) => ({ ...i, hoursRunning: +instanceHours(i).toFixed(4) })
  r.get('/api/compute/instances', ({ user }) => ({
    instances: db.find('instances', (i) => i.userId === user.id && i.state !== 'terminated').map(view),
  }))
  r.post('/api/compute/instances', ({ user, body }) => {
    required(body, 'name')
    const type = body.type || 'small'
    if (!INSTANCE_TYPES[type]) throw new HttpError(400, `Unknown type. Use one of: ${Object.keys(INSTANCE_TYPES).join(', ')}`)
    const inst = db.insert('instances', {
      userId: user.id, name: body.name, type, ...INSTANCE_TYPES[type], region: body.region || 'rd-east-1',
      state: 'running', runningSince: new Date().toISOString(), accruedMs: 0,
      ip: `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${1 + Math.floor(Math.random() * 253)}`,
    })
    return [201, view(inst)]
  })
  const transition = (action, from, to) =>
    r.post(`/api/compute/instances/:id/${action}`, ({ user, params }) => {
      const i = own('instances', params.id, user)
      if (!from.includes(i.state)) throw new HttpError(409, `Cannot ${action} an instance that is ${i.state}`)
      const patch = { state: to }
      if (to === 'running') patch.runningSince = new Date().toISOString()
      else {
        patch.accruedMs = (i.accruedMs ?? 0) + (i.runningSince ? Date.now() - new Date(i.runningSince).getTime() : 0)
        patch.runningSince = null
      }
      return view(db.update('instances', i.id, patch))
    })
  transition('start', ['stopped'], 'running')
  transition('stop', ['running'], 'stopped')
  transition('terminate', ['running', 'stopped'], 'terminated')

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
  })
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

  // ---- Document database (collections of JSON docs) ----
  r.get('/api/db/:collection', ({ user, params }) => ({
    documents: db.find('docs', (d) => d.userId === user.id && d.collection === params.collection),
  }))
  r.post('/api/db/:collection', ({ user, params, body }) => [201, db.insert('docs', { userId: user.id, collection: params.collection, data: body })])
  r.post('/api/db/:collection/query', ({ user, params, body }) => ({
    documents: db.find('docs', (d) => d.userId === user.id && d.collection === params.collection && Object.entries(body.where ?? {}).every(([k, v]) => d.data[k] === v)),
  }))
  const doc = (user, p) => {
    const d = db.get('docs', p.id)
    if (!d || d.userId !== user.id || d.collection !== p.collection) throw new HttpError(404, 'Document not found')
    return d
  }
  r.get('/api/db/:collection/:id', ({ user, params }) => doc(user, params))
  r.put('/api/db/:collection/:id', ({ user, params, body }) => (doc(user, params), db.update('docs', params.id, { data: body })))
  r.delete('/api/db/:collection/:id', ({ user, params }) => (doc(user, params), db.remove('docs', params.id), { ok: true }))
}
