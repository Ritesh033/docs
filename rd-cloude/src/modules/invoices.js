// Invoices, credits/coupons, payment methods and payments (simulated "test" provider only), billing events.
// NEVER accepts or stores card numbers: payment methods are provider tokens (tok_visa, tok_declined, ...).
import { HttpError, required } from '../http.js'
import { PRICES, dailyUsage, priceOf, syncDerived, monthKey, dayKey } from '../billing.js'

const round = (n, d = 2) => +n.toFixed(d)
const cents = (n) => Math.round(n * 100)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const DAY = 86_400_000

/** Coupon catalogue (credit in USD, valid for `days` after redemption). Override with RD_COUPONS='{"CODE":{"amount":10,"days":90}}'. */
function coupons() {
  const base = { WELCOME10: { amount: 10, days: 90 }, LAUNCH25: { amount: 25, days: 60 } }
  try { if (process.env.RD_COUPONS) Object.assign(base, JSON.parse(process.env.RD_COUPONS)) } catch { /* ignore a bad override */ }
  return base
}

/* ------------------------------------------------------------------ simulated payment provider */
const TEST_TOKENS = {
  tok_visa: { brand: 'visa', last4: '4242' }, tok_mastercard: { brand: 'mastercard', last4: '4444' }, tok_amex: { brand: 'amex', last4: '0005' },
  tok_declined: { brand: 'visa', last4: '0002', decline: 'card_declined' }, tok_insufficient: { brand: 'visa', last4: '9995', decline: 'insufficient_funds' },
  tok_expired: { brand: 'visa', last4: '0069', decline: 'expired_card' },
}
export const testProvider = {
  name: 'test',
  describe(token) { const t = TEST_TOKENS[token]; return t ? { brand: t.brand, last4: t.last4 } : null },
  charge({ token, amountCents, idempotencyKey }) {
    const t = TEST_TOKENS[token]
    if (!t) return { ok: false, failure: 'invalid_token' }
    if (t.decline) return { ok: false, failure: t.decline }
    return { ok: true, id: `ch_test_${Buffer.from(String(idempotencyKey)).toString('hex').slice(0, 16)}`, amountCents }
  },
}

const luhn = (digits) => {
  let sum = 0, alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (alt) { n *= 2; if (n > 9) n -= 9 }
    sum += n; alt = !alt
  }
  return sum % 10 === 0
}
/** True if any string anywhere in the value looks like a payment card number. */
function containsPan(v, depth = 0) {
  if (depth > 4) return false
  if (typeof v === 'string') {
    const d = v.replace(/[\s-]/g, '')
    return /^\d{13,19}$/.test(d) && luhn(d)
  }
  if (Array.isArray(v)) return v.some((x) => containsPan(x, depth + 1))
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => /^(card|number|pan|cardnumber|cvc|cvv)$/i.test(k) || containsPan(x, depth + 1))
  return false
}

/* ------------------------------------------------------------------ minimal PDF 1.4 */
const pdfEsc = (s) => String(s).replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1')
export function makePdf(lines) {
  const perPage = 52
  const pages = []
  for (let i = 0; i < lines.length || i === 0; i += perPage) pages.push(lines.slice(i, i + perPage))
  const objs = []
  const add = (body) => { objs.push(body); return objs.length }
  const catalog = add('') // placeholder 1
  const pagesObj = add('') // placeholder 2
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>')
  const kids = []
  for (const pg of pages) {
    let text = 'BT /F1 10 Tf 40 800 Td 13 TL\n'
    for (const l of pg) text += `(${pdfEsc(l)}) '\n`
    text += 'ET'
    const content = add(`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`)
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`))
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`
  let out = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

export function register(r, db, ctx) {
  const by = (col, userId) => (typeof db.findBy === 'function' ? db.findBy(col, 'userId', userId) : db.find(col, (x) => x.userId === userId))
  const providers = (ctx.paymentProviders ??= { test: testProvider })
  const notify = (userId, n) => ctx.events.emit('notification', { userId, source: 'billing', link: '#usage', ...n })
  const logEvent = (userId, type, ref, data) => db.insert('bill_events', { userId, type, ref, data: data ?? null, ts: Date.now() })
  const internals = () => ctx.billingInternals

  /* ------------------------------------------------------------- settings */
  const settingsOf = (userId) => db.findOne('bill_settings', (s) => s.userId === userId) ?? { taxRate: 0, companyName: '', address: '', autoPay: true }
  r.get('/api/billing/settings', ({ user }) => { const { taxRate, companyName, address, autoPay } = settingsOf(user.id); return { taxRate, companyName, address, autoPay } })
  r.put('/api/billing/settings', ({ user, body }) => {
    const cur = settingsOf(user.id)
    const next = { ...cur }
    if (body.taxRate !== undefined) {
      if (typeof body.taxRate !== 'number' || !(body.taxRate >= 0 && body.taxRate <= 0.5)) throw new HttpError(400, 'taxRate must be a fraction between 0 and 0.5')
      next.taxRate = body.taxRate
    }
    for (const f of ['companyName', 'address']) if (body[f] !== undefined) {
      if (typeof body[f] !== 'string' || body[f].length > 300) throw new HttpError(400, `${f} must be a string of at most 300 characters`)
      next[f] = body[f]
    }
    if (body.autoPay !== undefined) next.autoPay = body.autoPay === true
    const row = db.findOne('bill_settings', (s) => s.userId === user.id)
    const saved = row ? db.update('bill_settings', row.id, next) : db.insert('bill_settings', { userId: user.id, ...next })
    return { taxRate: saved.taxRate, companyName: saved.companyName, address: saved.address, autoPay: saved.autoPay }
  })

  /* ------------------------------------------------------------- credits */
  const liveCredits = (userId, now = Date.now()) => by('bill_credits', userId).filter((c) => c.remaining > 0.000001 && (!c.expiresAt || c.expiresAt > now)).sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity))
  const creditBalance = (userId) => round(liveCredits(userId).reduce((s, c) => s + c.remaining, 0), 2)
  const creditView = (c) => ({ id: c.id, amount: c.amount, remaining: round(c.remaining), reason: c.reason, expiresAt: c.expiresAt ? new Date(c.expiresAt).toISOString() : null, createdAt: c.createdAt })
  r.get('/api/billing/credits', ({ user }) => ({ balance: creditBalance(user.id), credits: by('bill_credits', user.id).map(creditView) }))
  r.post('/api/billing/credits/redeem', ({ user, body }) => {
    required(body, 'code')
    const code = String(body.code).trim().toUpperCase().slice(0, 40)
    const c = coupons()[code]
    if (!c || !(c.amount > 0)) throw new HttpError(404, 'Unknown coupon code')
    if (by('bill_redemptions', user.id).some((x) => x.code === code)) throw new HttpError(409, 'You already redeemed this coupon')
    db.insert('bill_redemptions', { userId: user.id, code })
    const row = db.insert('bill_credits', { userId: user.id, amount: c.amount, remaining: c.amount, reason: `Coupon ${code}`, expiresAt: Date.now() + (c.days ?? 90) * DAY })
    logEvent(user.id, 'credit.redeemed', row.id, { code, amount: c.amount })
    notify(user.id, { title: `$${c.amount} credit added`, body: `Coupon ${code} was applied.`, level: 'success' })
    return [201, creditView(row)]
  })
  function consumeCredits(userId, amount) {
    let left = amount, used = 0
    for (const c of liveCredits(userId)) {
      if (left <= 0) break
      const take = Math.min(c.remaining, left)
      db.update('bill_credits', c.id, { remaining: round(c.remaining - take, 6) })
      left -= take; used += take
    }
    return round(used)
  }

  /* ------------------------------------------------------------- payment methods */
  const pmView = (m) => ({ id: m.id, provider: m.provider, brand: m.brand, last4: m.last4, isDefault: !!m.isDefault, createdAt: m.createdAt })
  r.get('/api/billing/payment-methods', ({ user }) => ({ paymentMethods: by('bill_pm', user.id).map(pmView), testTokens: Object.keys(TEST_TOKENS) }))
  r.post('/api/billing/payment-methods', ({ user, body }) => {
    if (containsPan(body)) throw new HttpError(400, 'Never send card numbers. Use a payment token from the provider (test tokens: ' + Object.keys(TEST_TOKENS).join(', ') + ')')
    required(body, 'token')
    if (typeof body.token !== 'string' || !/^tok_[a-z_]{3,24}$/.test(body.token)) throw new HttpError(400, 'Invalid payment token')
    const desc = testProvider.describe(body.token)
    if (!desc) throw new HttpError(400, 'Unknown payment token')
    const existing = by('bill_pm', user.id)
    if (existing.length >= 5) throw new HttpError(400, 'At most 5 payment methods')
    const row = db.insert('bill_pm', { userId: user.id, provider: 'test', token: body.token, ...desc, isDefault: existing.length === 0 })
    logEvent(user.id, 'payment_method.added', row.id, { brand: desc.brand, last4: desc.last4 })
    return [201, pmView(row)]
  })
  r.post('/api/billing/payment-methods/:id/default', ({ user, params }) => {
    const m = db.get('bill_pm', params.id)
    if (!m || m.userId !== user.id) throw new HttpError(404, 'Payment method not found')
    for (const x of by('bill_pm', user.id)) if (x.isDefault !== (x.id === m.id)) db.update('bill_pm', x.id, { isDefault: x.id === m.id })
    return pmView(db.get('bill_pm', m.id))
  })
  r.delete('/api/billing/payment-methods/:id', ({ user, params }) => {
    const m = db.get('bill_pm', params.id)
    if (!m || m.userId !== user.id) throw new HttpError(404, 'Payment method not found')
    db.remove('bill_pm', m.id)
    const rest = by('bill_pm', user.id)
    if (m.isDefault && rest[0]) db.update('bill_pm', rest[0].id, { isDefault: true })
    return { ok: true }
  })

  /* ------------------------------------------------------------- invoice building */
  function buildInvoice(userId, periodKey) {
    syncDerived(db, userId)
    const p = internals().periodOf(Date.parse(`${periodKey}-15T00:00:00Z`))
    const s = internals().subOf(userId)
    const plan = internals().planOf(userId)
    const lines = []
    const trialActive = s.trialEndsAt && s.trialEndsAt > p.end - 1
    lines.push({ type: 'subscription', description: `${plan.name} plan (${periodKey})${trialActive ? ' - trial' : ''}`, quantity: 1, amount: trialActive ? 0 : plan.priceMonthly })
    const totals = new Map()
    for (const d of dailyUsage(db, userId, p.firstDay, p.lastDay)) for (const [k, q] of Object.entries(d.kinds)) totals.set(k, (totals.get(k) ?? 0) + q)
    let usage = 0
    for (const [kind, qty] of [...totals].sort(([a], [b]) => a.localeCompare(b))) {
      if (!PRICES[kind]) continue // unpriced kinds are metered but not billed
      const amount = priceOf(kind, qty)
      if (amount <= 0) continue
      usage += amount
      lines.push({ type: 'usage', kind, description: `${kind} (${PRICES[kind].unit})`, quantity: round(qty, 6), amount: round(amount, 4) })
    }
    const included = Math.min(plan.includedUsage ?? 0, usage)
    if (included > 0) lines.push({ type: 'allowance', description: `Included usage credit (${plan.name})`, quantity: 1, amount: -round(included, 4) })
    for (const a of db.find('bill_adjustments', (x) => x.userId === userId && x.period === periodKey)) lines.push({ type: 'adjustment', description: a.description, quantity: 1, amount: a.amount })
    const subtotal = round(lines.reduce((sum, l) => sum + l.amount, 0))
    const taxRate = settingsOf(userId).taxRate ?? 0
    const tax = Math.max(0, round(Math.max(0, subtotal) * taxRate))
    return { period: periodKey, periodStart: new Date(p.start).toISOString(), periodEnd: new Date(p.end - 1).toISOString(), lines, subtotal, taxRate, tax, totalBeforeCredits: round(Math.max(0, subtotal) + tax) }
  }

  const invView = (i) => ({
    id: i.id, number: i.number, period: i.period, status: i.status, currency: 'USD', lines: i.lines, subtotal: i.subtotal, taxRate: i.taxRate, tax: i.tax,
    creditsApplied: i.creditsApplied, total: i.total, amountDue: i.status === 'paid' || i.status === 'void' ? 0 : i.total, createdAt: i.createdAt, paidAt: i.paidAt ?? null,
    periodStart: i.periodStart, periodEnd: i.periodEnd, payments: db.find('bill_payments', (p) => p.invoiceId === i.id).map((p) => ({ id: p.id, ok: p.ok, failure: p.failure ?? null, amount: p.amount, ts: new Date(p.ts).toISOString() })),
  })
  const ownInvoice = (user, id) => {
    const i = db.get('bill_invoices', id)
    if (!i || i.userId !== user.id) throw new HttpError(404, 'Invoice not found')
    return i
  }

  function createInvoice(userId, periodKey) {
    const existing = db.findOne('bill_invoices', (i) => i.userId === userId && i.period === periodKey && i.status !== 'void')
    if (existing) return existing
    const b = buildInvoice(userId, periodKey)
    const creditsApplied = consumeCredits(userId, b.totalBeforeCredits)
    const total = round(b.totalBeforeCredits - creditsApplied)
    const n = by('bill_invoices', userId).length + 1
    const inv = db.insert('bill_invoices', {
      userId, number: `RD-${periodKey.replace('-', '')}-${String(n).padStart(3, '0')}`, ...b, creditsApplied, total,
      status: total <= 0 ? 'paid' : 'open', paidAt: total <= 0 ? new Date().toISOString() : null,
    })
    logEvent(userId, 'invoice.created', inv.id, { period: periodKey, total })
    notify(userId, { title: `Invoice ${inv.number} is ready`, body: total > 0 ? `Amount due: $${total.toFixed(2)}.` : 'Nothing is due.', level: 'info' })
    if (inv.status === 'open' && settingsOf(userId).autoPay !== false) { try { pay(userId, inv, null, true) } catch { /* auto-pay failure already notified */ } }
    return db.get('bill_invoices', inv.id)
  }

  function pay(userId, inv, pmId, auto = false) {
    if (inv.status === 'paid') throw new HttpError(409, 'Invoice is already paid')
    if (inv.status === 'void') throw new HttpError(409, 'Invoice is void')
    const methods = by('bill_pm', userId)
    const pm = pmId ? methods.find((m) => m.id === pmId) : methods.find((m) => m.isDefault) ?? methods[0]
    if (!pm) throw new HttpError(402, 'Add a payment method first')
    const provider = providers[pm.provider]
    if (!provider) throw new HttpError(500, 'Payment provider unavailable')
    const attempt = by('bill_payments', userId).filter((p) => p.invoiceId === inv.id).length
    const res = provider.charge({ token: pm.token, amountCents: cents(inv.total), idempotencyKey: `${inv.id}:${attempt}` })
    db.insert('bill_payments', { userId, invoiceId: inv.id, pmId: pm.id, amount: inv.total, ok: !!res.ok, failure: res.ok ? null : res.failure, providerRef: res.id ?? null, ts: Date.now() })
    if (!res.ok) {
      logEvent(userId, 'payment.failed', inv.id, { failure: res.failure })
      notify(userId, { title: `Payment failed for ${inv.number}`, body: `Reason: ${String(res.failure).replace(/_/g, ' ')}.`, level: 'warning' })
      if (auto) return null
      throw new HttpError(402, `Payment failed: ${String(res.failure).replace(/_/g, ' ')}`)
    }
    const updated = db.update('bill_invoices', inv.id, { status: 'paid', paidAt: new Date().toISOString() })
    logEvent(userId, 'payment.succeeded', inv.id, { amount: inv.total })
    notify(userId, { title: `Payment received for ${inv.number}`, body: `$${inv.total.toFixed(2)} paid.`, level: 'success' })
    return updated
  }

  /* ------------------------------------------------------------- invoice API */
  r.get('/api/billing/invoices', ({ user }) => ({ invoices: by('bill_invoices', user.id).sort((a, b) => b.period.localeCompare(a.period)).map(invView) }))
  r.get('/api/billing/invoices/preview', ({ user, query }) => {
    const period = query.get('period') || monthKey()
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new HttpError(400, 'period must be YYYY-MM')
    const b = buildInvoice(user.id, period)
    return { status: 'draft', currency: 'USD', ...b, creditBalance: creditBalance(user.id) }
  })
  r.post('/api/billing/invoices/generate', ({ user, body }) => {
    required(body, 'period')
    if (typeof body.period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.period)) throw new HttpError(400, 'period must be YYYY-MM')
    if (body.period >= monthKey()) throw new HttpError(409, 'Only closed (past) billing periods can be invoiced')
    return [201, invView(createInvoice(user.id, body.period))]
  })
  r.get('/api/billing/invoices/:id', ({ user, params }) => invView(ownInvoice(user, params.id)))
  r.post('/api/billing/invoices/:id/pay', ({ user, params, body }) => invView(pay(user.id, ownInvoice(user, params.id), typeof body.paymentMethodId === 'string' ? body.paymentMethodId : null)))
  r.post('/api/billing/invoices/:id/void', ({ user, params }) => {
    const i = ownInvoice(user, params.id)
    if (i.status !== 'open') throw new HttpError(409, 'Only open invoices can be voided')
    logEvent(user.id, 'invoice.voided', i.id)
    return invView(db.update('bill_invoices', i.id, { status: 'void' }))
  })

  const textLines = (i) => {
    const s = settingsOf(i.userId)
    const money = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`
    const out = [`RD CLOUDE INVOICE ${i.number}`, `Status: ${i.status.toUpperCase()}   Period: ${i.period}`, `Billed to: ${db.get('users', i.userId)?.email ?? ''}${s.companyName ? ' / ' + s.companyName : ''}`, '', 'Description'.padEnd(50) + 'Amount'.padStart(12), '-'.repeat(62)]
    for (const l of i.lines) out.push(String(l.description).slice(0, 48).padEnd(50) + money(l.amount).padStart(12))
    out.push('-'.repeat(62), 'Subtotal'.padEnd(50) + money(i.subtotal).padStart(12), `Tax (${(i.taxRate * 100).toFixed(1)}%)`.padEnd(50) + money(i.tax).padStart(12), 'Credits applied'.padEnd(50) + money(-i.creditsApplied).padStart(12), 'TOTAL'.padEnd(50) + money(i.total).padStart(12))
    return out
  }
  r.get('/api/billing/invoices/:id/pdf', ({ user, params }) => {
    const i = ownInvoice(user, params.id)
    return { binary: makePdf(textLines(i)), type: 'application/pdf', filename: `${i.number}.pdf` }
  })
  r.get('/api/billing/invoices/:id/html', ({ user, params }) => {
    const i = ownInvoice(user, params.id)
    const s = settingsOf(user.id)
    const row = (l) => `<tr><td>${esc(l.description)}</td><td class="n">${l.quantity}</td><td class="n">${l.amount < 0 ? '-' : ''}$${Math.abs(l.amount).toFixed(2)}</td></tr>`
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>${esc(i.number)}</title><style>body{font:14px system-ui,sans-serif;max-width:720px;margin:32px auto;color:#111}table{width:100%;border-collapse:collapse}td,th{padding:6px;border-bottom:1px solid #ddd;text-align:left}.n{text-align:right}h1{margin:0}.muted{color:#666}</style>
<h1>Invoice ${esc(i.number)}</h1><p class="muted">Period ${esc(i.period)} · ${esc(i.status)} · billed to ${esc(db.get('users', user.id)?.email)}${s.companyName ? ' · ' + esc(s.companyName) : ''}</p>
<table><tr><th>Description</th><th class="n">Qty</th><th class="n">Amount</th></tr>${i.lines.map(row).join('')}</table>
<p class="n">Subtotal $${i.subtotal.toFixed(2)}<br>Tax $${i.tax.toFixed(2)}<br>Credits -$${i.creditsApplied.toFixed(2)}<br><strong>Total $${i.total.toFixed(2)}</strong></p></html>`
    return { text: html, type: 'text/html; charset=utf-8', headers: { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'content-disposition': `inline; filename="${i.number}.html"` } }
  })

  r.get('/api/billing/events', ({ user, query }) => {
    const limit = Math.min(200, Math.max(1, Number(query.get('limit')) || 50))
    return { events: by('bill_events', user.id).sort((a, b) => b.ts - a.ts).slice(0, limit).map((e) => ({ id: e.id, type: e.type, ref: e.ref, data: e.data, at: new Date(e.ts).toISOString() })) }
  })

  /* ------------------------------------------------------------- monthly close */
  /** Create invoices for every closed period since a user's first usage (max 12 months back). */
  function closeSweep(now = Date.now()) {
    const current = monthKey(now)
    let created = 0
    const users = new Set([...db.find('usage', () => true).map((u) => u.userId), ...db.find('bill_subs', (s) => s.plan !== 'free').map((s) => s.userId)])
    for (const userId of users) {
      if (!db.get('users', userId)) continue
      const first = by('usage', userId).reduce((m, u) => Math.min(m, u.ts ?? Date.parse(u.createdAt)), now)
      let t = Math.max(Date.UTC(new Date(first).getUTCFullYear(), new Date(first).getUTCMonth(), 1), now - 365 * DAY)
      for (let guard = 0; guard < 13; guard++) {
        const key = monthKey(t)
        if (key >= current) break
        if (!db.findOne('bill_invoices', (i) => i.userId === userId && i.period === key)) { try { createInvoice(userId, key); created++ } catch (e) { console.error('[billing] invoice failed:', e.message) } }
        const d = new Date(t); t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
      }
    }
    return created
  }
  ctx.invoiceSweep = closeSweep
  const timer = setInterval(() => closeSweep(), 6 * 3600_000)
  timer.unref?.()
  ctx.events.on('shutdown', () => clearInterval(timer))
  ctx.events.on('account.deleted', ({ userId }) => {
    for (const col of ['bill_invoices', 'bill_pm', 'bill_payments', 'bill_credits', 'bill_redemptions', 'bill_events', 'bill_settings']) db.removeWhere(col, (x) => x.userId === userId)
  })
  ctx.events.on('account.export', ({ userId, add }) => {
    for (const col of ['bill_invoices', 'bill_credits', 'bill_events']) add?.(col, db.find(col, (x) => x.userId === userId))
  })
  void dayKey
}
