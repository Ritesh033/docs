import crypto from 'node:crypto'
import { HttpError, required } from './http.js'

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':')
  const a = Buffer.from(hash, 'hex')
  const b = crypto.scryptSync(pw, salt, 64)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, createdAt: u.createdAt })

export function authenticate(db, req) {
  const h = req.headers.authorization ?? ''
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : null
  if (!token) return null
  if (token.startsWith('rdk_')) {
    const key = db.findOne('apiKeys', (k) => k.hash === sha(token) && !k.revoked)
    if (!key) return null
    db.update('apiKeys', key.id, { lastUsedAt: new Date().toISOString() })
    return { user: db.get('users', key.userId), via: 'apiKey', keyId: key.id }
  }
  const s = db.findOne('sessions', (x) => x.hash === sha(token) && new Date(x.expiresAt) > new Date())
  return s ? { user: db.get('users', s.userId), via: 'session' } : null
}

function startSession(db, user) {
  const token = crypto.randomBytes(32).toString('hex')
  db.insert('sessions', { hash: sha(token), userId: user.id, expiresAt: new Date(Date.now() + 7 * 864e5).toISOString() })
  return token
}

export function authRoutes(r, db) {
  r.post('/api/auth/register', ({ body }) => {
    required(body, 'email', 'password')
    const email = String(body.email).toLowerCase().trim()
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Invalid email')
    if (String(body.password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters')
    if (db.findOne('users', (u) => u.email === email)) throw new HttpError(409, 'Email already registered')
    const user = db.insert('users', { email, name: body.name || email.split('@')[0], password: hashPassword(String(body.password)) })
    return [201, { user: publicUser(user), token: startSession(db, user) }]
  }, { public: true })

  r.post('/api/auth/login', ({ body }) => {
    required(body, 'email', 'password')
    const user = db.findOne('users', (u) => u.email === String(body.email).toLowerCase().trim())
    if (!user || !verifyPassword(String(body.password), user.password)) throw new HttpError(401, 'Invalid credentials')
    return { user: publicUser(user), token: startSession(db, user) }
  }, { public: true })

  r.post('/api/auth/logout', ({ req }) => {
    const token = (req.headers.authorization ?? '').slice(7).trim()
    db.removeWhere('sessions', (s) => s.hash === sha(token))
    return { ok: true }
  })

  r.get('/api/me', ({ user }) => ({ user: publicUser(user) }))

  // API keys
  r.get('/api/keys', ({ user }) => ({
    keys: db.find('apiKeys', (k) => k.userId === user.id).map(({ hash, ...k }) => k),
  }))
  r.post('/api/keys', ({ user, body }) => {
    const token = 'rdk_' + crypto.randomBytes(24).toString('hex')
    const key = db.insert('apiKeys', { userId: user.id, name: body.name || 'default', hash: sha(token), prefix: token.slice(0, 10), revoked: false })
    const { hash, ...pub } = key
    return [201, { key: pub, secret: token }] // secret is shown once
  })
  r.delete('/api/keys/:id', ({ user, params }) => {
    const k = db.get('apiKeys', params.id)
    if (!k || k.userId !== user.id) throw new HttpError(404, 'Key not found')
    db.update('apiKeys', k.id, { revoked: true })
    return { ok: true }
  })
}
