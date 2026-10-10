// Tiny JSON-file document store. Everything lives in memory and is flushed to disk (debounced).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const COLLECTIONS = [
  'users', 'sessions', 'apiKeys', 'projects', 'conversations', 'messages', 'artifacts',
  'instances', 'buckets', 'objects', 'files', 'shares', 'docs', 'usage',
]

export function createDb(dataDir) {
  const file = dataDir ? path.join(dataDir, 'db.json') : null
  const blobDir = dataDir ? path.join(dataDir, 'blobs') : null
  const memBlobs = new Map()
  let data = Object.fromEntries(COLLECTIONS.map((c) => [c, []]))
  if (file) {
    fs.mkdirSync(blobDir, { recursive: true })
    if (fs.existsSync(file)) data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  }

  let timer = null
  function flush() {
    if (!file) return
    clearTimeout(timer)
    timer = null
    fs.writeFileSync(file + '.tmp', JSON.stringify(data))
    fs.renameSync(file + '.tmp', file)
  }
  function save() {
    if (!file || timer) return
    timer = setTimeout(flush, 100)
    timer.unref?.()
  }

  const id = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`

  return {
    id,
    flush,
    insert(col, doc) {
      const row = { id: doc.id ?? id(col.slice(0, 3)), createdAt: new Date().toISOString(), ...doc }
      ;(data[col] ??= []).push(row)
      save()
      return row
    },
    get: (col, rid) => (data[col] ??= []).find((r) => r.id === rid) ?? null,
    find: (col, pred = () => true) => (data[col] ??= []).filter(pred),
    findOne: (col, pred) => (data[col] ??= []).find(pred) ?? null,
    update(col, rid, patch) {
      const row = (data[col] ??= []).find((r) => r.id === rid)
      if (!row) return null
      Object.assign(row, patch, { updatedAt: new Date().toISOString() })
      save()
      return row
    },
    remove(col, rid) {
      const i = (data[col] ??= []).findIndex((r) => r.id === rid)
      if (i < 0) return false
      data[col].splice(i, 1)
      save()
      return true
    },
    removeWhere(col, pred) {
      const before = (data[col] ??= []).length
      data[col] = data[col].filter((r) => !pred(r))
      save()
      return before - data[col].length
    },
    putBlob(bid, buf) {
      if (blobDir) fs.writeFileSync(path.join(blobDir, bid), buf)
      else memBlobs.set(bid, buf)
    },
    getBlob(bid) {
      if (blobDir) {
        const p = path.join(blobDir, bid)
        return fs.existsSync(p) ? fs.readFileSync(p) : null
      }
      return memBlobs.get(bid) ?? null
    },
    deleteBlob(bid) {
      if (blobDir) fs.rmSync(path.join(blobDir, bid), { force: true })
      else memBlobs.delete(bid)
    },
  }
}
