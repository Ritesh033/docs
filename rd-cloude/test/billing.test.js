import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp } from './helpers.js'
import { record, compactUsage, dayKey, monthKey, summarize } from '../src/billing.js'
import { makePdf } from '../src/modules/invoices.js'

const DAY = 86_400_000
async function withApp(fn) {
  const app = await startTestApp()
  try { await fn(app) } finally { await app.close() }
}

test('usage: record is validated, idempotent and rolls up', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    assert.equal(record(app.db, u.user.id, 'ai.input_tokens', -5), null)
    assert.equal(record(app.db, u.user.id, 'ai.input_tokens', NaN), null)
    assert.equal(record(app.db, u.user.id, 'Bad Kind!', 1), null)
    record(app.db, u.user.id, 'ai.output_tokens', 1000, { key: 'k1' })
    record(app.db, u.user.id, 'ai.output_tokens', 1000, { key: 'k1' }) // duplicate
    record(app.db, u.user.id, 'weird.thing', 7) // unpriced
    const s = (await u.call('GET', '/api/billing/usage')).data
    assert.equal(s.lines.find((l) => l.kind === 'ai.output_tokens').qty, 1000)
    assert.equal(s.lines.find((l) => l.kind === 'weird.thing').unpriced, true)
    assert.ok(Math.abs(s.lines.find((l) => l.kind === 'ai.output_tokens').cost - 0.015) < 1e-9)
    assert.equal((await u.call('GET', '/api/billing/usage?from=bad')).status, 400)
  })
})

test('usage: compaction keeps totals and the daily timeseries identical', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const old = Date.now() - 100 * DAY
    for (let i = 0; i < 5; i++) record(app.db, u.user.id, 'api.requests', 100, { ts: old + i * 1000 })
    record(app.db, u.user.id, 'api.requests', 1)
    const before = summarize(app.db, u.user.id).lines.find((l) => l.kind === 'api.requests').qty
    const r = compactUsage(app.db)
    assert.equal(r.folded, 5)
    assert.equal(summarize(app.db, u.user.id).lines.find((l) => l.kind === 'api.requests').qty, before)
    const ts = (await u.call('GET', `/api/billing/usage/timeseries?kind=api.requests&from=${dayKey(old)}&to=${dayKey(old)}`)).data
    assert.equal(ts.points[0].qty, 500)
    assert.equal((await u.call('GET', '/api/billing/usage/timeseries?granularity=hour&from=2020-01-01&to=2020-03-01')).status, 400)
    assert.equal((await u.call('GET', '/api/billing/usage/timeseries?kind=../x')).status, 400)
  })
})

test('quotas: plan limits are enforced per window and reported', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const q = app.ctx.quotas
    assert.equal(q.check(u.user.id, 'ai.output_tokens', 1).allowed, true)
    record(app.db, u.user.id, 'ai.output_tokens', 50_000)
    const res = q.check(u.user.id, 'ai.output_tokens', 1)
    assert.equal(res.allowed, false)
    assert.equal(res.limit, 50_000)
    assert.ok(res.resetAt)
    assert.equal(q.check(u.user.id, 'something.unknown', 1).allowed, true)
    assert.throws(() => q.enforce(u.user.id, 'ai.output_tokens', 1), (e) => e.status === 429 && Boolean(e.headers['retry-after']))
    const list = (await u.call('GET', '/api/billing/quotas')).data.quotas
    assert.equal(list.find((x) => x.kind === 'ai.output_tokens').percent, 100)
    // gauge quotas
    q.registerGauge('compute.instances', () => 3)
    assert.equal(q.check(u.user.id, 'compute.instances', 1).allowed, false)
  })
})

test('quotas: AI chat is refused with 429 once the daily token limit is used up', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const c = (await u.call('POST', '/api/conversations', { body: {} })).data
    record(app.db, u.user.id, 'ai.output_tokens', 60_000)
    const r = await u.call('POST', `/api/conversations/${c.id}/messages`, { body: { content: 'hello' } })
    assert.equal(r.status, 429)
  })
})

test('plans: trial, payment-method requirement, proration, cancel/resume', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    assert.equal((await u.call('GET', '/api/billing/plan')).data.plan, 'free')
    assert.equal((await u.call('GET', '/api/plans', {})).data.plans.length, 3)
    assert.equal((await u.call('PUT', '/api/billing/plan', { body: { plan: 'enterprise' } })).status, 400)
    assert.equal((await u.call('PUT', '/api/billing/plan', { body: { plan: '__proto__' } })).status, 400)
    const up = (await u.call('PUT', '/api/billing/plan', { body: { plan: 'pro' } })).data
    assert.equal(up.plan, 'pro'); assert.equal(up.inTrial, true)
    assert.equal((await u.call('GET', '/api/billing/quotas')).data.quotas.find((x) => x.kind === 'ai.output_tokens').limit, 1_000_000)
    // trial is used up: going to team without a card needs a payment method
    assert.equal((await u.call('PUT', '/api/billing/plan', { body: { plan: 'free' } })).status, 200)
    // the one-time trial is already used, so another paid plan now needs a card
    assert.equal((await u.call('PUT', '/api/billing/plan', { body: { plan: 'team' } })).status, 402)
  })
})

test('plans: second paid plan after the trial needs a card and is prorated', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    await u.call('PUT', '/api/billing/plan', { body: { plan: 'pro' } }) // starts trial
    const sub = app.db.findOne('bill_subs', (s) => s.userId === u.user.id)
    app.db.update('bill_subs', sub.id, { trialEndsAt: Date.now() - 1000, trialEnded: true }) // trial over
    assert.equal((await u.call('PUT', '/api/billing/plan', { body: { plan: 'team' } })).status, 402)
    assert.equal((await u.call('POST', '/api/billing/payment-methods', { body: { token: 'tok_visa' } })).status, 201)
    const r = (await u.call('PUT', '/api/billing/plan', { body: { plan: 'team' } })).data
    assert.equal(r.plan, 'team')
    assert.ok(r.proration > 0 && r.proration <= 40)
    assert.equal(app.db.find('bill_adjustments', (a) => a.userId === u.user.id).length, 1)
    assert.equal((await u.call('POST', '/api/billing/plan/cancel')).data.cancelAtPeriodEnd, true)
    assert.equal((await u.call('POST', '/api/billing/plan/resume')).data.cancelAtPeriodEnd, false)
    assert.equal((await u.call('POST', '/api/billing/plan/resume')).status, 409)
  })
})

test('budgets: validation, threshold notifications once, hard stop, isolation', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const v = await app.register()
    assert.equal((await u.call('POST', '/api/billing/budgets', { body: { name: 'x', amount: -1 } })).status, 400)
    assert.equal((await u.call('POST', '/api/billing/budgets', { body: { name: 'x', amount: 1, thresholds: [] } })).status, 400)
    const b = (await u.call('POST', '/api/billing/budgets', { body: { name: 'Main', amount: 0.15, hardStop: true } })).data
    assert.deepEqual(b.thresholds, [50, 80, 100])
    record(app.db, u.user.id, 'ai.output_tokens', 6000) // $0.09 => 60%
    let notes = (await u.call('GET', '/api/notifications')).data
    assert.equal(notes.notifications.length, 1)
    assert.match(notes.notifications[0].title, /50%/)
    record(app.db, u.user.id, 'ai.output_tokens', 6000, { ts: Date.now() }) // $0.18 => 120%
    app.ctx.billingSweep()
    await u.call('GET', '/api/billing/budgets') // evaluates
    notes = (await u.call('GET', '/api/notifications')).data
    assert.equal(notes.notifications.filter((n) => /100%/.test(n.title)).length, 1, 'each threshold fires once')
    assert.equal(app.ctx.quotas.check(u.user.id, 'ai.output_tokens', 1).reason, 'budget')
    assert.equal(app.ctx.quotas.check(u.user.id, 'something.free', 1).allowed, true)
    assert.equal((await v.call('PATCH', `/api/billing/budgets/${b.id}`, { body: { amount: 5 } })).status, 404)
    assert.equal((await v.call('GET', '/api/billing/budgets')).data.budgets.length, 0)
    const patched = (await u.call('PATCH', `/api/billing/budgets/${b.id}`, { body: { amount: 100 } })).data
    assert.deepEqual(patched.notified, [])
    assert.equal(app.ctx.quotas.check(u.user.id, 'ai.output_tokens', 1).allowed, true)
  })
})

test('forecast projects month-end cost from recent usage', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    for (let i = 0; i < 3; i++) record(app.db, u.user.id, 'ai.output_tokens', 100_000, { ts: Date.now() - i * 1000 })
    const f = (await u.call('GET', '/api/billing/forecast')).data
    assert.ok(Math.abs(f.monthToDate - 4.5) < 1e-6)
    assert.ok(f.projected >= f.monthToDate)
  })
})

test('credits: coupons redeem once, expire and are consumed oldest-expiry first', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    assert.equal((await u.call('POST', '/api/billing/credits/redeem', { body: { code: 'nope' } })).status, 404)
    assert.equal((await u.call('POST', '/api/billing/credits/redeem', { body: { code: 'welcome10' } })).status, 201)
    assert.equal((await u.call('POST', '/api/billing/credits/redeem', { body: { code: 'WELCOME10' } })).status, 409)
    assert.equal((await u.call('POST', '/api/billing/credits/redeem', { body: { code: 'LAUNCH25' } })).status, 201)
    assert.equal((await u.call('GET', '/api/billing/credits')).data.balance, 35)
    const w = app.db.findOne('bill_credits', (c) => c.userId === u.user.id && c.amount === 25)
    app.db.update('bill_credits', w.id, { expiresAt: Date.now() - 1 })
    assert.equal((await u.call('GET', '/api/billing/credits')).data.balance, 10)
    const events = (await u.call('GET', '/api/billing/events')).data.events
    assert.ok(events.some((e) => e.type === 'credit.redeemed'))
  })
})

test('payments: card numbers are rejected, tokens charge, declines fail cleanly', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    for (const body of [{ token: '4242424242424242' }, { token: 'tok_visa', card: '1' }, { number: '4242 4242 4242 4242' }, { token: 'tok_visa', extra: { deep: '5555555555554444' } }]) {
      assert.equal((await u.call('POST', '/api/billing/payment-methods', { body })).status, 400, JSON.stringify(body))
    }
    assert.equal((await u.call('POST', '/api/billing/payment-methods', { body: { token: 'tok_nonsense' } })).status, 400)
    const pm = (await u.call('POST', '/api/billing/payment-methods', { body: { token: 'tok_visa' } })).data
    assert.equal(pm.last4, '4242'); assert.equal(pm.isDefault, true)
    assert.equal(JSON.stringify(app.db.get('bill_pm', pm.id)).includes('4242424242424242'), false)
    const bad = (await u.call('POST', '/api/billing/payment-methods', { body: { token: 'tok_declined' } })).data
    assert.equal((await u.call('POST', `/api/billing/payment-methods/${bad.id}/default`)).data.isDefault, true)
    assert.equal((await u.call('GET', '/api/billing/payment-methods')).data.paymentMethods.filter((m) => m.isDefault).length, 1)
    assert.equal((await u.call('DELETE', `/api/billing/payment-methods/${bad.id}`)).status, 200)
    assert.equal((await u.call('GET', '/api/billing/payment-methods')).data.paymentMethods[0].isDefault, true)
  })
})

test('invoices: closed periods are invoiced once, with allowance, tax, credits, PDF and HTML', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const other = await app.register()
    const last = new Date(); last.setUTCMonth(last.getUTCMonth() - 1, 10)
    const period = monthKey(last.getTime())
    record(app.db, u.user.id, 'ai.output_tokens', 1_000_000, { ts: last.getTime() }) // $15
    await u.call('PUT', '/api/billing/settings', { body: { taxRate: 0.1, companyName: '<b>ACME</b>' } })
    assert.equal((await u.call('PUT', '/api/billing/settings', { body: { taxRate: 5 } })).status, 400)
    await u.call('POST', '/api/billing/credits/redeem', { body: { code: 'WELCOME10' } })
    assert.equal((await u.call('POST', '/api/billing/invoices/generate', { body: { period: monthKey() } })).status, 409)
    assert.equal((await u.call('POST', '/api/billing/invoices/generate', { body: { period: 'bad' } })).status, 400)
    const inv = (await u.call('POST', '/api/billing/invoices/generate', { body: { period } })).data
    // $15 usage - $5 included allowance = $10; tax 10% = $1; 10 credits applied => total $1
    assert.equal(inv.subtotal, 10)
    assert.equal(inv.tax, 1)
    assert.equal(inv.creditsApplied, 10)
    assert.equal(inv.total, 1)
    assert.equal(inv.status, 'open')
    const again = (await u.call('POST', '/api/billing/invoices/generate', { body: { period } })).data
    assert.equal(again.id, inv.id, 'one invoice per period')
    assert.equal((await other.call('GET', `/api/billing/invoices/${inv.id}`)).status, 404)
    assert.equal((await other.call('GET', `/api/billing/invoices/${inv.id}/pdf`)).status, 404)
    assert.equal((await u.call('POST', `/api/billing/invoices/${inv.id}/pay`, { body: {} })).status, 402, 'needs a payment method')
    await u.call('POST', '/api/billing/payment-methods', { body: { token: 'tok_insufficient' } })
    const fail = await u.call('POST', `/api/billing/invoices/${inv.id}/pay`, { body: {} })
    assert.equal(fail.status, 402); assert.match(fail.data.error, /insufficient funds/)
    const good = (await u.call('POST', '/api/billing/payment-methods', { body: { token: 'tok_visa' } })).data
    const paid = (await u.call('POST', `/api/billing/invoices/${inv.id}/pay`, { body: { paymentMethodId: good.id } })).data
    assert.equal(paid.status, 'paid')
    assert.equal((await u.call('POST', `/api/billing/invoices/${inv.id}/pay`, { body: {} })).status, 409)
    const pdf = await u.call('GET', `/api/billing/invoices/${inv.id}/pdf`)
    assert.equal(pdf.status, 200)
    const text = pdf.data.toString('latin1')
    assert.ok(text.startsWith('%PDF-1.4') && text.trimEnd().endsWith('%%EOF'))
    const startxref = Number(/startxref\n(\d+)/.exec(text)[1])
    assert.ok(text.slice(startxref).startsWith('xref'))
    const html = await u.call('GET', `/api/billing/invoices/${inv.id}/html`)
    assert.ok(!html.data.includes('<b>ACME</b>') && html.data.includes('&lt;b&gt;ACME'))
    assert.match(html.headers.get('content-security-policy'), /sandbox/)
    assert.ok((await u.call('GET', '/api/notifications?unread=1')).data.unread >= 1)
  })
})

test('invoices: preview works for the current month; sweep closes past months for users with usage', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const last = new Date(); last.setUTCMonth(last.getUTCMonth() - 2, 5)
    record(app.db, u.user.id, 'storage.egress_gb', 100, { ts: last.getTime() })
    const pv = (await u.call('GET', '/api/billing/invoices/preview')).data
    assert.equal(pv.status, 'draft')
    assert.equal(pv.lines[0].type, 'subscription')
    assert.equal(app.ctx.invoiceSweep(), 2) // the two closed months between first usage and now
    assert.equal(app.ctx.invoiceSweep(), 0, 'idempotent')
    assert.equal((await u.call('GET', '/api/billing/invoices')).data.invoices.length, 2)
  })
})

test('compute hours and storage are metered into usage rows lazily', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const inst = app.db.insert('instances', { userId: u.user.id, name: 'x', type: 'small', state: 'stopped', accruedMs: 2 * 3600_000, runningSince: null })
    let s = (await u.call('GET', '/api/billing/usage')).data
    assert.ok(Math.abs(s.lines.find((l) => l.kind === 'compute.small').qty - 2) < 1e-9)
    s = (await u.call('GET', '/api/billing/usage')).data
    assert.ok(Math.abs(s.lines.find((l) => l.kind === 'compute.small').qty - 2) < 1e-9, 'second read does not double count')
    app.db.update('instances', inst.id, { accruedMs: 3 * 3600_000 })
    s = (await u.call('GET', '/api/billing/usage')).data
    assert.ok(Math.abs(s.lines.find((l) => l.kind === 'compute.small').qty - 3) < 1e-9)
  })
})

test('pdf writer produces a structurally valid multi-page document', () => {
  const pdf = makePdf(Array.from({ length: 120 }, (_, i) => `line ${i} (with) \\ specials é`)).toString('latin1')
  assert.equal((pdf.match(/\/Type \/Page /g) ?? []).length, 3)
  const offsets = [...pdf.matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]))
  offsets.forEach((o, i) => assert.ok(pdf.slice(o).startsWith(`${i + 1} 0 obj`), `object ${i + 1} offset`))
})

test('billing endpoints require auth; notifications are isolated and bounded', async () => {
  await withApp(async (app) => {
    for (const p of ['/api/billing/plan', '/api/billing/quotas', '/api/billing/invoices', '/api/notifications', '/api/billing/budgets']) {
      assert.equal((await app.call('GET', p)).status, 401, p)
    }
    const a = await app.register(), b = await app.register()
    for (let i = 0; i < 510; i++) app.ctx.notify(a.user.id, { title: `n${i}` })
    assert.equal(app.db.find('notifications', (n) => n.userId === a.user.id).length, 500)
    assert.equal((await b.call('GET', '/api/notifications')).data.notifications.length, 0)
    const n = (await a.call('GET', '/api/notifications?limit=5')).data
    assert.equal(n.notifications.length, 5); assert.ok(n.nextCursor)
    assert.equal((await b.call('DELETE', `/api/notifications/${n.notifications[0].id}`)).status, 404)
    assert.equal((await a.call('POST', '/api/notifications/read', { body: {} })).status, 400)
    assert.equal((await a.call('POST', '/api/notifications/read', { body: { all: true } })).data.updated, 500)
    assert.equal(app.ctx.notify(a.user.id, { title: '', body: 'x' }), null)
    assert.equal(app.ctx.notify(a.user.id, { title: 't', link: 'javascript:alert(1)' }).link, null, 'only in-app links')
  })
})
