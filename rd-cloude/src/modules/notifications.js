// Per-user notification inbox. Other modules emit ctx.events 'notification' {userId,title,body,level,link,source}
// (or call ctx.notify(userId, {...})). Bounded per user; strictly tenant-isolated.
import { HttpError } from '../http.js'

const MAX_PER_USER = 500
const LEVELS = new Set(['info', 'success', 'warning', 'critical'])
const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')

export function register(r, db, ctx) {
  const byUser = (userId) => (typeof db.findBy === 'function' ? db.findBy('notifications', 'userId', userId) : db.find('notifications', (n) => n.userId === userId))

  function notify(userId, n = {}) {
    if (!userId || !db.get('users', userId)) return null
    const title = clip(n.title, 200)
    if (!title) return null
    const level = LEVELS.has(n.level) ? n.level : 'info'
    const link = typeof n.link === 'string' && /^(#|\/)[\w\-./#?=&%]*$/.test(n.link) ? n.link.slice(0, 300) : null // in-app links only
    const row = db.insert('notifications', { userId, title, body: clip(n.body, 2000), level, link, source: clip(n.source, 40) || 'system', read: false, ts: Date.now() })
    const all = byUser(userId)
    if (all.length > MAX_PER_USER) {
      for (const old of all.slice().sort((a, b) => a.ts - b.ts).slice(0, all.length - MAX_PER_USER)) db.remove('notifications', old.id)
    }
    return row
  }
  ctx.notify = notify
  ctx.events.on('notification', (ev) => { try { if (ev && typeof ev === 'object') notify(ev.userId, ev) } catch (e) { console.error('[notifications]', e.message) } })
  ctx.events.on('account.deleted', ({ userId }) => { db.removeWhere('notifications', (n) => n.userId === userId) })

  const view = ({ id, title, body, level, link, source, read, ts }) => ({ id, title, body, level, link, source, read, createdAt: new Date(ts).toISOString() })

  r.get('/api/notifications', ({ user, query }) => {
    const limit = Math.min(100, Math.max(1, Number(query.get('limit')) || 30))
    const unreadOnly = query.get('unread') === '1'
    const before = query.get('cursor') ? Number(query.get('cursor')) : Infinity
    if (!(before > 0)) throw new HttpError(400, 'Invalid cursor')
    const all = byUser(user.id)
    const list = all.filter((n) => n.ts < before && (!unreadOnly || !n.read)).sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1))
    const page = list.slice(0, limit)
    return { notifications: page.map(view), unread: all.filter((n) => !n.read).length, nextCursor: list.length > limit ? String(page.at(-1).ts) : null }
  })

  r.post('/api/notifications/read', ({ user, body }) => {
    const mine = byUser(user.id)
    let n = 0
    if (body.all === true) {
      for (const x of mine) if (!x.read) { db.update('notifications', x.id, { read: true }); n++ }
    } else if (Array.isArray(body.ids)) {
      const ids = new Set(body.ids.filter((i) => typeof i === 'string').slice(0, 500))
      for (const x of mine) if (ids.has(x.id) && !x.read) { db.update('notifications', x.id, { read: true }); n++ }
    } else throw new HttpError(400, 'Provide { ids: [...] } or { all: true }')
    return { updated: n }
  })

  r.delete('/api/notifications/:id', ({ user, params }) => {
    const n = db.get('notifications', params.id)
    if (!n || n.userId !== user.id) throw new HttpError(404, 'Notification not found')
    db.remove('notifications', n.id)
    return { ok: true }
  })
}
