// Plans, subscriptions, quota engine (ctx.quotas), budgets, forecast and usage timeseries.
import { HttpError, required } from '../http.js'
import { PRICES, instanceHours, record, summarize, syncDerived, usageBetween, dailyUsage, costOfKinds, dayKey, monthKey, service, storageBytes, onRecord, priceOf } from '../billing.js'

const GiB = 1024 ** 3
const DAY = 86_400_000
const round = (n, d = 6) => +n.toFixed(d)

/** limit window: day | month (resets) or gauge (current level of a resource). */
export const PLANS = {
  free: {
    name: 'Free', priceMonthly: 0, includedUsage: 5, description: 'For trying things out.',
    limits: {
      'ai.output_tokens': { limit: 50_000, window: 'day', label: 'AI output tokens' },
      'functions.invocations': { limit: 100_000, window: 'month', label: 'Function invocations' },
      'api.requests': { limit: 100_000, window: 'month', label: 'API requests' },
      'storage.bytes': { limit: 2 * GiB, window: 'gauge', label: 'Stored data', unit: 'bytes' },
      'compute.instances': { limit: 3, window: 'gauge', label: 'Compute instances' },
      'sql.databases': { limit: 3, window: 'gauge', label: 'SQL databases' },
    },
  },
  pro: {
    name: 'Pro', priceMonthly: 20, includedUsage: 25, description: 'For individuals building real things.', trialDays: 14,
    limits: {
      'ai.output_tokens': { limit: 1_000_000, window: 'day', label: 'AI output tokens' },
      'functions.invocations': { limit: 5_000_000, window: 'month', label: 'Function invocations' },
      'api.requests': { limit: 5_000_000, window: 'month', label: 'API requests' },
      'storage.bytes': { limit: 100 * GiB, window: 'gauge', label: 'Stored data', unit: 'bytes' },
      'compute.instances': { limit: 25, window: 'gauge', label: 'Compute instances' },
      'sql.databases': { limit: 25, window: 'gauge', label: 'SQL databases' },
    },
  },
  team: {
    name: 'Team', priceMonthly: 60, includedUsage: 100, description: 'For teams: higher limits and shared organizations.', trialDays: 14,
    limits: {
      'ai.output_tokens': { limit: 10_000_000, window: 'day', label: 'AI output tokens' },
      'functions.invocations': { limit: 50_000_000, window: 'month', label: 'Function invocations' },
      'api.requests': { limit: 50_000_000, window: 'month', label: 'API requests' },
      'storage.bytes': { limit: 1024 * GiB, window: 'gauge', label: 'Stored data', unit: 'bytes' },
      'compute.instances': { limit: 200, window: 'gauge', label: 'Compute instances' },
      'sql.databases': { limit: 200, window: 'gauge', label: 'SQL databases' },
    },
  },
}

export const periodOf = (t = Date.now()) => {
  const d = new Date(t)
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  return { key: monthKey(t), start, end, days: (end - start) / DAY, firstDay: dayKey(start), lastDay: dayKey(end - 1) }
}

export function register(r, db, ctx) {
  const by = (col, userId) => (typeof db.findBy === 'function' ? db.findBy(col, 'userId', userId) : db.find(col, (x) => x.userId === userId))
  const notify = (userId, n) => ctx.events.emit('notification', { userId, source: 'billing', ...n })
  const audit = (userId, action, resource, meta) => { try { ctx.audit?.(userId, action, resource, meta) } catch { /* ignore */ } }

  /* ------------------------------------------------------------- subscriptions */
  function subOf(userId) {
    let s = typeof db.findOneBy === 'function' ? db.findOneBy('bill_subs', 'userId', userId) : db.findOne('bill_subs', (x) => x.userId === userId)
    if (!s) s = db.insert('bill_subs', { userId, plan: 'free', since: Date.now(), cancelAtPeriodEnd: false, trialUsed: false })
    if (s.cancelAtPeriodEnd && s.cancelAt && s.cancelAt <= Date.now()) {
      s = db.update('bill_subs', s.id, { plan: 'free', cancelAtPeriodEnd: false, cancelAt: null, trialEndsAt: null })
      notify(userId, { title: 'Your subscription ended', body: 'You are now on the Free plan.', level: 'info', link: '#usage' })
    }
    if (s.trialEndsAt && s.trialEndsAt <= Date.now() && !s.trialEnded) {
      s = db.update('bill_subs', s.id, { trialEnded: true })
      if (s.plan !== 'free') notify(userId, { title: 'Your trial has ended', body: `Your ${PLANS[s.plan].name} plan is now billed monthly.`, level: 'info', link: '#usage' })
    }
    return s
  }
  const planOf = (userId) => PLANS[subOf(userId).plan] ?? PLANS.free
  const inTrial = (s) => !!(s.trialEndsAt && s.trialEndsAt > Date.now())
  const hasPaymentMethod = (userId) => by('bill_pm', userId).length > 0

  const subView = (s) => {
    const p = periodOf()
    return {
      plan: s.plan, name: PLANS[s.plan].name, priceMonthly: PLANS[s.plan].priceMonthly, trialEndsAt: s.trialEndsAt ? new Date(s.trialEndsAt).toISOString() : null,
      inTrial: inTrial(s), cancelAtPeriodEnd: !!s.cancelAtPeriodEnd, periodStart: new Date(p.start).toISOString(), periodEnd: new Date(p.end).toISOString(),
    }
  }

  /** Prorated charge (positive) or credit (negative) for switching plans now. */
  function proration(fromPlan, toPlan, now = Date.now()) {
    const p = periodOf(now)
    const left = (p.end - now) / (p.end - p.start)
    return round((PLANS[toPlan].priceMonthly - PLANS[fromPlan].priceMonthly) * left, 2)
  }

  r.get('/api/plans', () => ({ plans: Object.entries(PLANS).map(([id, p]) => ({ id, ...p, limits: Object.entries(p.limits).map(([kind, l]) => ({ kind, ...l })) })) }), { public: true })
  r.get('/api/billing/plan', ({ user }) => ({ ...subView(subOf(user.id)), paymentMethod: hasPaymentMethod(user.id) }))
  r.put('/api/billing/plan', ({ user, body }) => {
    required(body, 'plan')
    if (typeof body.plan !== 'string' || !Object.hasOwn(PLANS, body.plan)) throw new HttpError(400, `Unknown plan. Use one of: ${Object.keys(PLANS).join(', ')}`)
    const s = subOf(user.id)
    const target = body.plan
    if (target === s.plan && !s.cancelAtPeriodEnd) return { ...subView(s), changed: false }
    const patch = { plan: target, cancelAtPeriodEnd: false, cancelAt: null }
    let charge = 0
    if (target !== 'free' && s.plan !== target) {
      const canTrial = !s.trialUsed && PLANS[target].trialDays
      if (canTrial) {
        Object.assign(patch, { trialUsed: true, trialEndsAt: Date.now() + PLANS[target].trialDays * DAY, trialEnded: false })
      } else {
        if (!inTrial(s) && !hasPaymentMethod(user.id)) throw new HttpError(402, 'Add a payment method before choosing a paid plan')
        if (!inTrial(s)) charge = proration(s.plan, target)
      }
    } else if (target === 'free') {
      Object.assign(patch, { trialEndsAt: null })
      charge = inTrial(s) ? 0 : proration(s.plan, 'free') // negative = credit for the unused part
    }
    const updated = db.update('bill_subs', s.id, patch)
    if (charge !== 0) {
      db.insert('bill_adjustments', { userId: user.id, period: periodOf().key, description: `Plan change ${s.plan} → ${target} (prorated)`, amount: charge })
    }
    db.insert('bill_plan_changes', { userId: user.id, from: s.plan, to: target, proration: charge, ts: Date.now() })
    audit(user.id, 'billing.plan.change', target, { from: s.plan, proration: charge })
    notify(user.id, { title: `Plan changed to ${PLANS[target].name}`, body: updated.trialEndsAt && inTrial(updated) ? `Your ${PLANS[target].trialDays}-day trial has started.` : charge ? `Prorated adjustment: $${charge.toFixed(2)}.` : '', level: 'success', link: '#usage' })
    return { ...subView(updated), changed: true, proration: charge }
  })
  r.post('/api/billing/plan/cancel', ({ user }) => {
    const s = subOf(user.id)
    if (s.plan === 'free') throw new HttpError(409, 'You are on the Free plan')
    const p = periodOf()
    return subView(db.update('bill_subs', s.id, { cancelAtPeriodEnd: true, cancelAt: Math.max(p.end, s.trialEndsAt ?? 0) }))
  })
  r.post('/api/billing/plan/resume', ({ user }) => {
    const s = subOf(user.id)
    if (!s.cancelAtPeriodEnd) throw new HttpError(409, 'The subscription is not scheduled to cancel')
    return subView(db.update('bill_subs', s.id, { cancelAtPeriodEnd: false, cancelAt: null }))
  })

  /* ------------------------------------------------------------- quota engine */
  const gauges = new Map()
  const gaugeValue = (userId, kind) => {
    const g = gauges.get(kind)
    if (g) return Number(g(userId)) || 0
    if (kind === 'storage.bytes') return storageBytes(db, userId)
    if (kind === 'compute.instances') return by('instances', userId).filter((i) => i.state !== 'terminated' && i.state !== 'shutting-down').length
    if (kind === 'sql.databases') return by('sql_databases', userId).length
    return 0
  }
  const resetAt = (window, now = Date.now()) => (window === 'day' ? Date.parse(`${dayKey(now)}T00:00:00Z`) + DAY : window === 'month' ? periodOf(now).end : null)

  function mtdCost(userId, now = Date.now()) {
    const p = periodOf(now)
    let total = 0
    for (const d of dailyUsage(db, userId, p.firstDay, p.lastDay)) total += costOfKinds(d.kinds)
    return total
  }

  function limitFor(userId, kind) {
    const plan = planOf(userId)
    const override = db.findOne('bill_overrides', (o) => o.userId === userId && o.kind === kind)
    const base = plan.limits[kind]
    if (override) return { ...(base ?? { window: 'month', label: kind }), limit: override.limit }
    return base ?? null
  }

  function usedFor(userId, kind, lim, now = Date.now()) {
    if (lim.window === 'gauge') return gaugeValue(userId, kind)
    if (lim.window === 'day') return usageBetween(db, userId, kind, dayKey(now), dayKey(now))
    const p = periodOf(now)
    return usageBetween(db, userId, kind, p.firstDay, p.lastDay)
  }

  /** The engine other modules call. Unknown kinds (no limit on the plan) are always allowed. */
  const quotas = {
    check(userId, kind, qty = 1) {
      if (process.env.RD_QUOTAS_DISABLED === '1') return { allowed: true, limit: null, remaining: null, used: 0, window: null, resetAt: null }
      // hard-stop budgets block everything that costs money
      if (PRICES[kind]) {
        const stop = by('bill_budgets', userId).find((b) => b.hardStop && mtdCost(userId) >= b.amount)
        if (stop) return { allowed: false, reason: 'budget', message: `Budget "${stop.name}" ($${stop.amount}) is exhausted`, limit: stop.amount, used: round(mtdCost(userId), 4), remaining: 0, window: 'month', resetAt: new Date(periodOf().end).toISOString() }
      }
      const lim = limitFor(userId, kind)
      if (!lim) return { allowed: true, limit: null, remaining: null, used: 0, window: null, resetAt: null }
      const used = usedFor(userId, kind, lim)
      const allowed = used + qty <= lim.limit
      const ra = resetAt(lim.window)
      return { allowed, reason: allowed ? undefined : 'plan', message: allowed ? undefined : `${lim.label ?? kind} limit of ${lim.limit} reached on the ${planOf(userId).name} plan`, limit: lim.limit, used, remaining: Math.max(0, lim.limit - used), window: lim.window, resetAt: ra ? new Date(ra).toISOString() : null }
    },
    /** Throwing variant for modules: await/call quotas.enforce(userId, kind, qty) -> HttpError(429|402). */
    enforce(userId, kind, qty = 1) {
      const res = quotas.check(userId, kind, qty)
      if (!res.allowed) {
        const err = new HttpError(res.reason === 'budget' ? 402 : 429, res.message ?? 'Quota exceeded')
        if (res.resetAt) err.headers = { 'retry-after': String(Math.max(1, Math.ceil((Date.parse(res.resetAt) - Date.now()) / 1000))) }
        throw err
      }
      return res
    },
    usage(userId, kind, window = 'month') {
      const now = Date.now()
      if (window === 'day') return usageBetween(db, userId, kind, dayKey(now), dayKey(now))
      const p = periodOf(now)
      return usageBetween(db, userId, kind, p.firstDay, p.lastDay)
    },
    limits(userId) {
      const plan = planOf(userId)
      return Object.keys(plan.limits).map((kind) => {
        const lim = limitFor(userId, kind)
        const used = usedFor(userId, kind, lim)
        const ra = resetAt(lim.window)
        return { kind, label: lim.label ?? kind, unit: lim.unit ?? null, window: lim.window, limit: lim.limit, used, remaining: Math.max(0, lim.limit - used), percent: lim.limit ? round((used / lim.limit) * 100, 1) : 0, resetAt: ra ? new Date(ra).toISOString() : null }
      })
    },
    registerGauge(kind, fn) { if (typeof fn === 'function') gauges.set(kind, fn) },
    plans: PLANS,
  }
  ctx.quotas = quotas

  r.get('/api/billing/quotas', ({ user }) => ({ plan: subOf(user.id).plan, quotas: quotas.limits(user.id) }))

  /* ------------------------------------------------------------- budgets */
  const budgetView = ({ id, name, amount, thresholds, hardStop, notified }) => {
    return { id, name, amount, thresholds, hardStop: !!hardStop, notified: notified?.period === monthKey() ? notified.hit : [] }
  }
  function evaluateBudgets(userId) {
    const budgets = by('bill_budgets', userId)
    if (!budgets.length) return
    const spent = mtdCost(userId)
    const period = monthKey()
    for (const b of budgets) {
      const pct = b.amount > 0 ? (spent / b.amount) * 100 : 0
      const hit = b.notified?.period === period ? b.notified.hit : []
      const fresh = b.thresholds.filter((t) => pct >= t && !hit.includes(t))
      if (!fresh.length) continue
      db.update('bill_budgets', b.id, { notified: { period, hit: [...hit, ...fresh] } })
      const top = Math.max(...fresh)
      notify(userId, {
        title: `Budget "${b.name}" reached ${top}%`, level: top >= 100 ? 'critical' : 'warning', link: '#usage',
        body: `Month-to-date spend is $${spent.toFixed(2)} of your $${b.amount.toFixed(2)} budget.${b.hardStop && top >= 100 ? ' Paid services are now blocked until next month or you raise the budget.' : ''}`,
      })
    }
  }
  let lastEval = new Map()
  onRecord(db, (userId) => {
    const t = Date.now()
    if (t - (lastEval.get(userId) ?? 0) < 5000) return
    lastEval.set(userId, t)
    if (lastEval.size > 5000) lastEval = new Map()
    evaluateBudgets(userId)
  })

  function parseBudget(body, partial = false) {
    const out = {}
    if (!partial || body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) throw new HttpError(400, 'name must be 1-80 characters')
      out.name = body.name.trim()
    }
    if (!partial || body.amount !== undefined) {
      if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount <= 0 || body.amount > 1e7) throw new HttpError(400, 'amount must be a positive number')
      out.amount = round(body.amount, 2)
    }
    if (body.thresholds !== undefined || !partial) {
      const t = body.thresholds ?? [50, 80, 100]
      if (!Array.isArray(t) || !t.length || t.length > 6 || t.some((x) => typeof x !== 'number' || !(x > 0) || x > 1000)) throw new HttpError(400, 'thresholds must be 1-6 percentages between 0 and 1000')
      out.thresholds = [...new Set(t)].sort((a, b) => a - b)
    }
    if (body.hardStop !== undefined) out.hardStop = body.hardStop === true
    return out
  }
  r.get('/api/billing/budgets', ({ user }) => { evaluateBudgets(user.id); return { budgets: by('bill_budgets', user.id).map(budgetView), monthToDate: round(mtdCost(user.id), 4) } })
  r.post('/api/billing/budgets', ({ user, body }) => {
    if (by('bill_budgets', user.id).length >= 20) throw new HttpError(400, 'At most 20 budgets')
    return [201, budgetView(db.insert('bill_budgets', { userId: user.id, hardStop: false, ...parseBudget(body) }))]
  })
  const ownBudget = (user, id) => {
    const b = db.get('bill_budgets', id)
    if (!b || b.userId !== user.id) throw new HttpError(404, 'Budget not found')
    return b
  }
  r.patch('/api/billing/budgets/:id', ({ user, params, body }) => {
    const b = ownBudget(user, params.id)
    const patch = parseBudget(body, true)
    if (patch.amount !== undefined || patch.thresholds !== undefined) patch.notified = null // re-arm alerts when the target changes
    return budgetView(db.update('bill_budgets', b.id, patch))
  })
  r.delete('/api/billing/budgets/:id', ({ user, params }) => { db.remove('bill_budgets', ownBudget(user, params.id).id); return { ok: true } })

  /* ------------------------------------------------------------- forecast & timeseries */
  r.get('/api/billing/forecast', ({ user }) => {
    syncDerived(db, user.id)
    const now = Date.now()
    const p = periodOf(now)
    const elapsed = Math.max(1, Math.ceil((now - p.start) / DAY))
    const mtd = mtdCost(user.id, now)
    const recentFrom = dayKey(now - 6 * DAY)
    let recent = 0
    for (const d of dailyUsage(db, user.id, recentFrom, dayKey(now))) recent += costOfKinds(d.kinds)
    const dailyAvg = recent / 7
    const daysLeft = Math.max(0, (p.end - now) / DAY)
    return { period: p.key, monthToDate: round(mtd, 4), dailyAverage: round(dailyAvg, 4), projected: round(mtd + dailyAvg * daysLeft, 4), daysElapsed: elapsed, daysInMonth: p.days }
  })

  const dayParam = (v, dflt) => {
    if (!v) return dflt
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new HttpError(400, 'Dates must be YYYY-MM-DD')
    return v
  }
  r.get('/api/billing/usage/timeseries', ({ user, query }) => {
    syncDerived(db, user.id)
    const kind = query.get('kind') || '*'
    if (kind !== '*' && !/^[a-z0-9_]+\.(\*|[a-z0-9_.]+)$/.test(kind)) throw new HttpError(400, 'Invalid kind')
    const gran = query.get('granularity') || 'day'
    if (gran !== 'day' && gran !== 'hour') throw new HttpError(400, 'granularity must be day or hour')
    const to = dayParam(query.get('to'), dayKey())
    const from = dayParam(query.get('from'), dayKey(Date.parse(to) - 29 * DAY))
    if (from > to) throw new HttpError(400, 'from must not be after to')
    const match = (k) => kind === '*' || (kind.endsWith('.*') ? k.startsWith(kind.slice(0, -1)) : k === kind)
    if (gran === 'day') {
      if (Date.parse(to) - Date.parse(from) > 400 * DAY) throw new HttpError(400, 'At most 400 days')
      const points = dailyUsage(db, user.id, from, to).map((d) => {
        let qty = 0, cost = 0
        for (const [k, q] of Object.entries(d.kinds)) if (match(k)) { qty += q; cost += priceOf(k, q) }
        return { t: d.day, qty: round(qty, 9), cost: round(cost) }
      })
      return { kind, granularity: gran, from, to, points }
    }
    if (Date.parse(to) - Date.parse(from) > 14 * DAY) throw new HttpError(400, 'Hourly resolution covers at most 14 days')
    const lo = Date.parse(`${from}T00:00:00Z`), hi = Date.parse(`${to}T00:00:00Z`) + DAY
    const buckets = new Map()
    for (const u of by('usage', user.id)) {
      const ts = u.ts ?? Date.parse(u.createdAt)
      if (u.compact || ts < lo || ts >= hi || !match(u.kind)) continue
      const h = new Date(ts).toISOString().slice(0, 13) + ':00:00Z'
      const b = buckets.get(h) ?? { t: h, qty: 0, cost: 0 }
      b.qty += u.qty
      b.cost += priceOf(u.kind, u.qty)
      buckets.set(h, b)
    }
    return { kind, granularity: gran, from, to, points: [...buckets.values()].sort((a, b) => a.t.localeCompare(b.t)).map((b) => ({ t: b.t, qty: round(b.qty, 9), cost: round(b.cost) })) }
  })
  r.get('/api/billing/cost/daily', ({ user, query }) => {
    syncDerived(db, user.id)
    const to = dayParam(query.get('to'), dayKey())
    const from = dayParam(query.get('from'), dayKey(Date.parse(to) - 29 * DAY))
    if (from > to || Date.parse(to) - Date.parse(from) > 400 * DAY) throw new HttpError(400, 'Invalid range')
    return {
      from, to,
      days: dailyUsage(db, user.id, from, to).map((d) => {
        const byService = {}
        for (const [k, q] of Object.entries(d.kinds)) byService[service(k)] = round((byService[service(k)] ?? 0) + priceOf(k, q))
        return { day: d.day, total: round(Object.values(byService).reduce((s, v) => s + v, 0)), byService }
      }),
    }
  })

  /* ------------------------------------------------------------- sweeper */
  function sweep(now = Date.now()) {
    const users = new Set()
    for (const i of db.find('instances', (x) => instanceHours(x, now) - (x.billedHours ?? 0) > 1e-9)) users.add(i.userId)
    for (const b of db.find('bill_budgets', () => true)) users.add(b.userId)
    for (const userId of users) {
      try { syncDerived(db, userId, now); evaluateBudgets(userId); subOf(userId) } catch (e) { console.error('[billing] sweep failed for a user:', e.message) }
    }
    return users.size
  }
  const timer = setInterval(() => sweep(), 60_000)
  timer.unref?.()
  ctx.events.on('shutdown', () => clearInterval(timer))
  ctx.billingSweep = sweep
  ctx.events.on('account.deleted', ({ userId }) => {
    for (const col of ['bill_subs', 'bill_budgets', 'bill_adjustments', 'bill_plan_changes', 'bill_overrides', 'billing_state']) db.removeWhere(col, (x) => x.userId === userId)
  })
  ctx.billingInternals = { subOf, planOf, inTrial, hasPaymentMethod, mtdCost, periodOf }
}
