// Tamper-evident per-user audit log. Each entry carries an HMAC-SHA256 over its content and the previous entry's hash
// (a keyed hash chain); a per-user head record (also MACed) detects truncation. See docs/security.md.
// Sources: ctx.audit(userId, action, resource, meta) / ctx.events.emit('audit', {...}) and automatic capture of
// security-relevant requests via onRequestEnd.
import crypto from 'node:crypto'
import { HttpError } from '../http.js'
import { initAuth, deriveKey, safeEqual, clientIp, tx, many, one } from '../auth.js'

const GENESIS = '0'.repeat(64)
const SENSITIVE_PATH = /^\/api\/(auth|keys|account|orgs)(\/|$)|\/(shares?|invites?|members?|publish|permissions?|tokens?|secrets?|password|roles?|transfer)(\/|$)/i
const REDACT = /^(pass|secret|token|code|authorization|cookie|api_?key|hash|totp|otp|private)/i
const SKIP_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
  return v ?? null
}

/** JSON-safe, bounded, secret-free copy of an arbitrary meta value. */
function cleanMeta(v, depth = 0) {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v.length > 200 ? v.slice(0, 200) + '…' : v
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v
  if (depth >= 3) return null
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => cleanMeta(x, depth + 1))
  if (typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).slice(0, 30)) {
      if (SKIP_KEYS.has(k)) continue
      out[k.slice(0, 40)] = REDACT.test(k) ? '[redacted]' : cleanMeta(v[k], depth + 1)
    }
    return out
  }
  return null
}

function normResource(r) {
  if (r === null || r === undefined) return null
  if (typeof r === 'string') return r.slice(0, 200)
  if (typeof r === 'object' && r.type) return `${String(r.type).slice(0, 40)}:${String(r.id ?? '').slice(0, 100)}`
  return String(r).slice(0, 200)
}

export async function register(r, db, ctx) {
  const st = initAuth(ctx)
  const key = deriveKey(ctx, 'audit')
  const MAX_PER_USER = Math.min(100_000, Math.max(50, Number(process.env.RD_AUDIT_MAX_PER_USER) || 5000))
  const hmac = (s) => crypto.createHmac('sha256', key).update(s).digest('hex')
  const entryMac = (e) => hmac(JSON.stringify([e.seq, e.ts, e.userId, e.action, e.resource ?? null, e.ip ?? null, e.requestId ?? null, canon(e.meta ?? null), e.prev]))
  const stateMac = (s) => hmac(JSON.stringify(['head', s.userId, s.seq, s.hash, s.anchorSeq, s.anchorHash, s.count]))

  const states = new Map() // userId -> live audit_state row
  const stateFor = (userId) => {
    let s = states.get(userId)
    if (!s || !db.get('audit_state', s.id)) {
      s = one(db, 'audit_state', 'userId', userId)
      if (s) states.set(userId, s)
      else states.delete(userId)
    }
    return s
  }

  /** Append one entry to the user's chain. Never throws. */
  function append(ev) {
    try {
      if (!ev || typeof ev.userId !== 'string' || ev.userId.length > 64 || !db.get('users', ev.userId)) return null
      const action = String(ev.action ?? '').replace(/[^A-Za-z0-9_.:*-]/g, '_').slice(0, 64)
      if (!action) return null
      const userId = ev.userId
      let s = stateFor(userId)
      const e = {
        userId, seq: (s?.seq ?? 0) + 1, ts: new Date(st.now()).toISOString(), action, resource: normResource(ev.resource),
        ip: typeof ev.ip === 'string' ? ev.ip.slice(0, 64) : null, requestId: typeof ev.requestId === 'string' ? ev.requestId.slice(0, 64) : null,
        meta: cleanMeta(ev.meta), prev: s?.hash ?? GENESIS,
      }
      if (JSON.stringify(e.meta).length > 2000) e.meta = { truncated: true }
      e.hash = entryMac(e)
      const next = { userId, seq: e.seq, hash: e.hash, anchorSeq: s?.anchorSeq ?? 0, anchorHash: s?.anchorHash ?? GENESIS, count: (s?.count ?? 0) + 1 }
      next.mac = stateMac(next)
      s = tx(db, () => { // entry and chain head move together, even across a crash
        db.insert('audit_log', e)
        return s ? db.update('audit_state', s.id, next) : db.insert('audit_state', next)
      })
      states.set(userId, s)
      if (s.count > MAX_PER_USER) prune(s)
      return e
    } catch (err) {
      console.error('[rd-cloude] audit append failed:', err.message)
      return null
    }
  }

  /** Retention: drop the oldest 10% and move the verification anchor to the last dropped entry. */
  function prune(s) {
    const mine = many(db, 'audit_log', 'userId', s.userId).sort((a, b) => a.seq - b.seq)
    const drop = mine.slice(0, Math.ceil(MAX_PER_USER * 0.1))
    if (!drop.length) return
    const last = drop.at(-1)
    const next = { userId: s.userId, seq: s.seq, hash: s.hash, anchorSeq: last.seq, anchorHash: last.hash, count: s.count - drop.length }
    next.mac = stateMac(next)
    states.set(s.userId, tx(db, () => {
      for (const e of drop) db.remove('audit_log', e.id)
      return db.update('audit_state', s.id, next)
    }))
  }

  function verify(userId) {
    const s = one(db, 'audit_state', 'userId', userId)
    const entries = many(db, 'audit_log', 'userId', userId).sort((a, b) => a.seq - b.seq)
    const fail = (seq, reason) => ({ ok: false, count: entries.length, head: s ? { seq: s.seq, hash: s.hash } : null, error: { seq, reason } })
    if (!s) return entries.length ? fail(entries[0].seq, 'chain head record is missing') : { ok: true, count: 0, head: null, anchoredAt: null }
    if (!safeEqual(stateMac(s), s.mac ?? '')) return fail(s.seq, 'chain head record was modified')
    let prev = s.anchorHash
    let expect = s.anchorSeq + 1
    for (const e of entries) {
      if (e.seq !== expect) return fail(expect, e.seq > expect ? 'an entry is missing' : 'duplicate or out-of-order entry')
      if (e.prev !== prev) return fail(e.seq, 'chain link is broken')
      if (!safeEqual(entryMac(e), e.hash)) return fail(e.seq, 'entry content was modified')
      prev = e.hash
      expect++
    }
    if (expect - 1 !== s.seq || prev !== s.hash) return fail(s.seq, 'entries are missing from the end of the chain')
    return { ok: true, count: entries.length, head: { seq: s.seq, hash: s.hash }, anchoredAt: s.anchorSeq || null }
  }

  /* ------------------------------------------------------------- sources */
  const explicit = new Set() // request ids that already produced an explicit entry (so auto-capture does not double-log)
  ctx.audit = (userId, action, resource, meta, extra) => ctx.events.emit('audit', { userId, action, resource, meta, ...extra })
  ctx.events.on('audit', (ev) => {
    if (ev?.requestId) {
      explicit.add(ev.requestId)
      if (explicit.size > 2000) explicit.delete(explicit.values().next().value)
    }
    append(ev)
  })
  ctx.events.on('account.deleted', ({ userId }) => {
    tx(db, () => {
      for (const e of many(db, 'audit_log', 'userId', userId)) db.remove('audit_log', e.id)
      for (const s of many(db, 'audit_state', 'userId', userId)) db.remove('audit_state', s.id)
    })
    states.delete(userId)
  })

  const recent = new Map() // coalesce repeated denials: key -> ts
  ctx.hooks.onRequestEnd.push((info) => {
    try {
      const { user, req, status, pattern } = info
      if (!user || !pattern || !pattern.startsWith('/api/') || explicit.has(info.requestId)) return
      const method = req.method
      const mutating = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
      let action = null
      if (status === 403) action = 'access.denied'
      else if (mutating && status < 400 && (method === 'DELETE' || SENSITIVE_PATH.test(pattern))) action = `http.${method.toLowerCase()}`
      if (!action) return
      const ip = clientIp(req)
      if (status === 403) {
        const k = `${user.id}|${pattern}|${method}|${ip}`
        const now = Date.now()
        if (now - (recent.get(k) ?? 0) < 60_000) return
        recent.set(k, now)
        if (recent.size > 5000) recent.delete(recent.keys().next().value)
      }
      append({
        userId: user.id, action, resource: pattern, ip, requestId: info.requestId,
        meta: { method, status, via: info.auth?.via, keyId: info.auth?.keyId, params: info.params },
      })
    } catch (e) { console.error('[rd-cloude] audit capture failed:', e.message) }
  })

  /* ------------------------------------------------------------- API */
  const view = ({ id, userId, createdAt, updatedAt, ...e }) => e
  r.get('/api/audit', ({ user, query }) => {
    const limit = Math.min(200, Math.max(1, Number(query.get('limit')) || 50))
    const action = (query.get('action') ?? '').slice(0, 64)
    const resource = (query.get('resource') ?? '').slice(0, 200)
    const parseDate = (name) => {
      const v = query.get(name)
      if (!v) return null
      const t = Date.parse(v)
      if (!Number.isFinite(t)) throw new HttpError(400, `Invalid ${name} date`)
      return t
    }
    const since = parseDate('since')
    const until = parseDate('until')
    let before = Infinity
    if (query.get('cursor')) {
      before = Number.parseInt(Buffer.from(query.get('cursor'), 'base64url').toString('utf8'), 10)
      if (!Number.isInteger(before) || before < 1) throw new HttpError(400, 'Invalid cursor')
    }
    const match = (value, pat) => !pat || (pat.endsWith('*') ? String(value ?? '').startsWith(pat.slice(0, -1)) : value === pat)
    const rows = many(db, 'audit_log', 'userId', user.id).filter((e) => e.seq < before && match(e.action, action) && match(e.resource, resource)
      && (since === null || Date.parse(e.ts) >= since) && (until === null || Date.parse(e.ts) <= until)).sort((a, b) => b.seq - a.seq)
    const page = rows.slice(0, limit)
    return {
      entries: page.map(view),
      nextCursor: rows.length > limit ? Buffer.from(String(page.at(-1).seq)).toString('base64url') : null,
    }
  }, { meta: { summary: 'Your audit log (newest first). Filters: action (suffix * = prefix), resource, since, until, limit, cursor' } })

  r.get('/api/audit/verify', ({ user }) => verify(user.id), { meta: { summary: 'Verify the integrity of your audit log hash chain' } })
}
