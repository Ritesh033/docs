// Document database service module (auto-loaded by src/app.js).
import { HttpError } from '../http.js'

export function register(r, db, ctx) {
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
