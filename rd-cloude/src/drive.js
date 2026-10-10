// Drive: versioned files with public share links.
import crypto from 'node:crypto'
import { HttpError, sendBuffer } from './http.js'

export function driveRoutes(r, db) {
  const file = (user, id) => {
    const f = db.get('files', id)
    if (!f || f.userId !== user.id) throw new HttpError(404, 'File not found')
    return f
  }
  const view = (f) => ({ id: f.id, name: f.name, contentType: f.contentType, versionCount: f.versions.length, size: f.versions.at(-1).size, updatedAt: f.updatedAt ?? f.createdAt })

  r.get('/api/drive/files', ({ user }) => ({ files: db.find('files', (f) => f.userId === user.id).map(view) }))

  // Upload raw bytes: PUT /api/drive/files?name=report.pdf. Same name => new version.
  r.put('/api/drive/files', ({ user, query, raw, req }) => {
    const name = query.get('name')
    if (!name) throw new HttpError(400, 'Missing ?name=')
    const blobId = db.id('blob')
    db.putBlob(blobId, raw)
    const ver = { blobId, size: raw.length, at: new Date().toISOString() }
    const existing = db.findOne('files', (f) => f.userId === user.id && f.name === name)
    const type = req.headers['content-type'] || 'application/octet-stream'
    if (existing) return [200, view(db.update('files', existing.id, { versions: [...existing.versions, ver], contentType: type }))]
    return [201, view(db.insert('files', { userId: user.id, name, contentType: type, versions: [ver] }))]
  }, { raw: true })
  r.get('/api/drive/files/:id', ({ user, params, query }) => {
    const f = file(user, params.id)
    const n = query.get('version') ? Number(query.get('version')) : f.versions.length
    const v = f.versions[n - 1]
    if (!v) throw new HttpError(404, 'Version not found')
    return { binary: db.getBlob(v.blobId), type: f.contentType, filename: f.name }
  })
  r.get('/api/drive/files/:id/versions', ({ user, params }) => ({
    versions: file(user, params.id).versions.map((v, i) => ({ version: i + 1, size: v.size, at: v.at })),
  }))
  r.delete('/api/drive/files/:id', ({ user, params }) => {
    const f = file(user, params.id)
    f.versions.forEach((v) => db.deleteBlob(v.blobId))
    db.removeWhere('shares', (s) => s.fileId === f.id)
    db.remove('files', f.id)
    return { ok: true }
  })

  r.post('/api/drive/files/:id/share', ({ user, params }) => {
    const f = file(user, params.id)
    const token = crypto.randomBytes(16).toString('hex')
    db.insert('shares', { fileId: f.id, token })
    return [201, { url: `/s/${token}`, token }]
  })
  r.delete('/api/drive/shares/:token', ({ user, params }) => {
    const s = db.findOne('shares', (x) => x.token === params.token)
    if (!s) throw new HttpError(404, 'Share not found')
    file(user, s.fileId)
    db.remove('shares', s.id)
    return { ok: true }
  })
  // Public download
  r.get('/s/:token', ({ params }) => {
    const s = db.findOne('shares', (x) => x.token === params.token)
    const f = s && db.get('files', s.fileId)
    if (!f) throw new HttpError(404, 'Link not found')
    return { binary: db.getBlob(f.versions.at(-1).blobId), type: f.contentType, filename: f.name }
  }, { public: true })
}
