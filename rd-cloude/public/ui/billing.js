import { stackedBars, donut, legend } from '/charts.js'

// el.append() does not flatten arrays; put() does (and skips null/false) so views can use ternaries and .map() freely.
const put = (el, ...kids) => el.append(...kids.flat(Infinity).filter((x) => x != null && x !== false))
const usd = (n, d = 2) => `$${Number(n ?? 0).toFixed(d)}`
const TABS = [['overview', 'Overview'], ['quotas', 'Quotas'], ['budgets', 'Budgets'], ['plans', 'Plans'], ['invoices', 'Invoices'], ['payments', 'Payments & credits'], ['inbox', 'Notifications']]

async function overview(el, lib) {
  const { h, api } = lib
  const [usage, forecast, daily, plan] = await Promise.all([api('GET', '/api/billing/usage'), api('GET', '/api/billing/forecast'), api('GET', '/api/billing/cost/daily'), api('GET', '/api/billing/plan')])
  const services = [...new Set(daily.days.flatMap((d) => Object.keys(d.byService)))]
  const byService = new Map()
  for (const l of usage.lines) byService.set(l.kind.split('.')[0], (byService.get(l.kind.split('.')[0]) ?? 0) + l.cost)
  put(el, 
    h('div', { class: 'bl-grid' },
      h('div', { class: 'bl-stat' }, h('b', {}, usd(forecast.monthToDate, 4)), h('span', {}, 'Month to date')),
      h('div', { class: 'bl-stat' }, h('b', {}, usd(forecast.projected, 2)), h('span', {}, `Projected for ${forecast.period}`)),
      h('div', { class: 'bl-stat' }, h('b', {}, plan.name + (plan.inTrial ? ' (trial)' : '')), h('span', {}, `${usd(plan.priceMonthly)} / month${plan.cancelAtPeriodEnd ? ' · cancels at period end' : ''}`)),
      h('div', { class: 'bl-stat' }, h('b', {}, usd(usage.total, 4)), h('span', {}, 'All-time usage cost')),
    ),
    h('h3', {}, 'Daily cost by service (last 30 days)'),
    daily.days.length ? [stackedBars(daily.days.map((d) => ({ label: d.day.slice(5), parts: d.byService })), { title: 'Daily cost by service', format: (v) => usd(v, v < 1 ? 3 : 2) }), legend(h, services)] : h('p', { class: 'muted' }, 'No usage yet. Costs appear here as you use the platform.'),
    h('h3', {}, 'Cost by service'),
    h('div', { class: 'bl-form' }, donut([...byService].map(([label, value]) => ({ label, value })), { title: 'All-time cost by service', center: usd(usage.total, usage.total < 1 ? 4 : 2) }), legend(h, [...byService.keys()])),
    h('h3', {}, 'Usage details'),
    h('table', { class: 'bl-table' }, h('thead', {}, h('tr', {}, ['Metric', 'Quantity', 'Rate', 'Cost'].map((x, i) => h('th', { class: i ? 'n' : '' }, x)))),
      h('tbody', {}, usage.lines.map((l) => h('tr', {}, h('td', {}, l.kind), h('td', { class: 'n' }, Number(l.qty.toPrecision(6)).toString()), h('td', { class: 'n' }, l.unpriced ? 'unpriced' : `${usd(l.price, 4)} ${l.unit}`), h('td', { class: 'n' }, usd(l.cost, 4)))))),
  )
}

async function quotas(el, lib) {
  const { h, api, fmtBytes } = lib
  const { plan, quotas: qs } = await api('GET', '/api/billing/quotas')
  put(el, h('p', { class: 'muted' }, `Limits of your ${plan} plan. Daily and monthly limits reset automatically.`))
  for (const q of qs) {
    const fmtv = (v) => (q.unit === 'bytes' ? fmtBytes(v) : v.toLocaleString())
    const bar = h('div', { class: `bl-bar ${q.percent >= 100 ? 'crit' : q.percent >= 80 ? 'warn' : ''}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.min(100, q.percent), 'aria-label': q.label }, h('i', {}))
    bar.firstChild.style.setProperty('--w', `${Math.min(100, q.percent)}%`)
    put(el, h('div', { class: 'bl-row' }, h('div', {}, h('b', {}, q.label), h('div', { class: 'muted' }, q.window === 'gauge' ? 'current' : `per ${q.window}`)), bar, h('span', {}, `${fmtv(q.used)} / ${fmtv(q.limit)}`)))
  }
}

async function budgets(el, lib) {
  const { h, api, act, rerender, confirmDialog } = lib
  const { budgets: list, monthToDate } = await api('GET', '/api/billing/budgets')
  const name = h('input', { placeholder: 'Budget name', 'aria-label': 'Budget name', maxlength: 80 })
  const amount = h('input', { type: 'number', min: '0.01', step: '0.01', placeholder: 'Monthly amount (USD)', 'aria-label': 'Monthly amount' })
  const hard = h('input', { type: 'checkbox', id: 'bl-hard' })
  put(el, h('p', { class: 'muted' }, `Month-to-date spend: ${usd(monthToDate, 4)}. You are notified at each threshold.`),
    h('div', { class: 'bl-form' }, name, amount, h('label', {}, hard, ' Block paid services at 100%'),
      h('button', { onclick: act(async () => { await api('POST', '/api/billing/budgets', { name: name.value, amount: Number(amount.value), hardStop: hard.checked }); rerender() }) }, 'Add budget')),
    ...list.map((b) => {
      const pct = b.amount ? Math.min(150, (monthToDate / b.amount) * 100) : 0
      const bar = h('div', { class: `bl-bar ${pct >= 100 ? 'crit' : pct >= 80 ? 'warn' : ''}`, role: 'progressbar', 'aria-valuenow': Math.round(Math.min(100, pct)), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': b.name }, h('i', {}))
      bar.firstChild.style.setProperty('--w', `${Math.min(100, pct)}%`)
      return h('div', { class: 'bl-row' }, h('div', {}, h('b', {}, b.name), h('div', { class: 'muted' }, `${usd(b.amount)} · alerts at ${b.thresholds.join('/')}%${b.hardStop ? ' · hard stop' : ''}`)), bar,
        h('button', { class: 'sec', onclick: act(async () => { if (await confirmDialog(`Delete budget "${b.name}"?`, 'Delete')) { await api('DELETE', `/api/billing/budgets/${b.id}`); rerender() } }) }, 'Delete'))
    }))
}

async function plans(el, lib) {
  const { h, api, act, rerender, toast, confirmDialog } = lib
  const [{ plans: all }, cur] = await Promise.all([api('GET', '/api/plans'), api('GET', '/api/billing/plan')])
  put(el, h('p', { class: 'muted' }, cur.inTrial ? `Your trial ends ${new Date(cur.trialEndsAt).toLocaleDateString()}.` : cur.paymentMethod ? 'A payment method is on file.' : 'Add a payment method (Payments tab) before choosing a paid plan after your trial.'),
    h('div', { class: 'bl-plans' }, all.map((p) => h('div', { class: `bl-plan ${p.id === cur.plan ? 'current' : ''}` },
      h('h3', {}, p.name), h('div', { class: 'price' }, `${usd(p.priceMonthly, 0)}`, h('span', { class: 'muted' }, ' /mo')), h('p', { class: 'muted' }, p.description),
      h('ul', {}, h('li', {}, `${usd(p.includedUsage, 0)} usage included`), p.limits.map((l) => h('li', {}, `${l.label}: ${l.unit === 'bytes' ? `${(l.limit / 1024 ** 3).toFixed(0)} GB` : l.limit.toLocaleString()}${l.window === 'gauge' ? '' : ` / ${l.window}`}`))),
      p.id === cur.plan ? h('b', {}, 'Current plan') : h('button', { onclick: act(async () => {
        const r = await api('PUT', '/api/billing/plan', { plan: p.id })
        toast(r.inTrial ? 'Trial started' : `Switched to ${p.name}${r.proration ? ` (prorated ${usd(r.proration)})` : ''}`, 'info')
        rerender()
      }) }, p.trialDays && !cur.inTrial ? `Start ${p.trialDays}-day trial` : p.priceMonthly > 0 ? 'Switch' : 'Downgrade')))),
    cur.plan !== 'free' ? h('div', { class: 'bl-form' }, cur.cancelAtPeriodEnd
      ? h('button', { class: 'sec', onclick: act(async () => { await api('POST', '/api/billing/plan/resume'); rerender() }) }, 'Keep my plan')
      : h('button', { class: 'sec', onclick: act(async () => { if (await confirmDialog('Cancel at the end of this billing period?', 'Cancel plan')) { await api('POST', '/api/billing/plan/cancel'); rerender() } }) }, 'Cancel at period end')) : null)
}

async function invoices(el, lib) {
  const { h, api, act, download, rerender, toast } = lib
  const [{ invoices: list }, preview] = await Promise.all([api('GET', '/api/billing/invoices'), api('GET', '/api/billing/invoices/preview')])
  put(el, h('h3', {}, `Upcoming: ${preview.period}`), h('p', { class: 'muted' }, `Estimated ${usd(preview.totalBeforeCredits)} (${preview.lines.length} lines, tax ${(preview.taxRate * 100).toFixed(1)}%). Final invoices are created after the month closes.`),
    h('h3', {}, 'Invoices'),
    list.length ? h('table', { class: 'bl-table' }, h('thead', {}, h('tr', {}, ['Number', 'Period', 'Status', 'Total', ''].map((x, i) => h('th', { class: i === 3 ? 'n' : '' }, x)))),
      h('tbody', {}, list.map((i) => h('tr', {}, h('td', {}, i.number), h('td', {}, i.period), h('td', {}, i.status), h('td', { class: 'n' }, usd(i.total)),
        h('td', {}, i.status === 'open' ? h('button', { onclick: act(async () => { await api('POST', `/api/billing/invoices/${i.id}/pay`, {}); toast('Payment received', 'info'); rerender() }) }, 'Pay') : null, ' ',
          h('button', { class: 'sec', onclick: act(async () => download(await api('GET', `/api/billing/invoices/${i.id}/pdf`), `${i.number}.pdf`)) }, 'PDF'), ' ',
          h('button', { class: 'sec', onclick: act(async () => download(await api('GET', `/api/billing/invoices/${i.id}/html`), `${i.number}.html`)) }, 'HTML')))))) : h('p', { class: 'muted' }, 'No invoices yet.'))
}

async function payments(el, lib) {
  const { h, api, act, rerender, toast } = lib
  const [{ paymentMethods, testTokens }, credits, settings] = await Promise.all([api('GET', '/api/billing/payment-methods'), api('GET', '/api/billing/credits'), api('GET', '/api/billing/settings')])
  const tok = h('select', { 'aria-label': 'Test card token' }, testTokens.map((t) => h('option', {}, t)))
  const code = h('input', { placeholder: 'Coupon code', 'aria-label': 'Coupon code', maxlength: 40 })
  const company = h('input', { value: settings.companyName, placeholder: 'Company name (on invoices)', 'aria-label': 'Company name', maxlength: 300 })
  const tax = h('input', { type: 'number', min: '0', max: '50', step: '0.1', value: String(+(settings.taxRate * 100).toFixed(2)), 'aria-label': 'Tax rate percent' })
  put(el, h('div', { class: 'bl-note' }, 'This is a simulated payment provider: use a test token. Real card numbers are rejected and never stored.'),
    h('h3', {}, 'Payment methods'),
    ...paymentMethods.map((m) => h('div', { class: 'bl-row' }, h('b', {}, `${m.brand} •••• ${m.last4}${m.isDefault ? ' (default)' : ''}`), h('span', {}),
      h('span', {}, !m.isDefault ? h('button', { class: 'sec', onclick: act(async () => { await api('POST', `/api/billing/payment-methods/${m.id}/default`); rerender() }) }, 'Make default') : null, ' ',
        h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/billing/payment-methods/${m.id}`); rerender() }) }, 'Remove')))),
    h('div', { class: 'bl-form' }, tok, h('button', { onclick: act(async () => { await api('POST', '/api/billing/payment-methods', { token: tok.value }); rerender() }) }, 'Add test card')),
    h('h3', {}, `Credits: ${usd(credits.balance)}`),
    h('div', { class: 'bl-form' }, code, h('button', { onclick: act(async () => { await api('POST', '/api/billing/credits/redeem', { code: code.value }); toast('Credit added', 'info'); rerender() }) }, 'Redeem')),
    credits.credits.map((c) => h('div', { class: 'muted' }, `${c.reason}: ${usd(c.remaining)} of ${usd(c.amount)}${c.expiresAt ? `, expires ${new Date(c.expiresAt).toLocaleDateString()}` : ''}`)),
    h('h3', {}, 'Invoice details'),
    h('div', { class: 'bl-form' }, company, h('label', {}, 'Tax % ', tax), h('button', { onclick: act(async () => { await api('PUT', '/api/billing/settings', { companyName: company.value, taxRate: Number(tax.value) / 100 }); toast('Saved', 'info') }) }, 'Save')))
}

async function inbox(el, lib) {
  const { h, api, act, rerender, fmtDate } = lib
  const { notifications, unread } = await api('GET', '/api/notifications?limit=50')
  put(el, h('div', { class: 'bl-form' }, h('b', {}, `${unread} unread`), unread ? h('button', { class: 'sec', onclick: act(async () => { await api('POST', '/api/notifications/read', { all: true }); rerender() }) }, 'Mark all read') : null),
    notifications.length ? notifications.map((n) => h('div', { class: `bl-note ${n.read ? '' : 'unread'} ${n.level}` }, h('b', {}, n.title), n.body ? h('div', {}, n.body) : null, h('small', {}, `${n.source} · ${fmtDate(n.createdAt)} `),
      n.link ? h('a', { href: n.link }, 'Open') : null, ' ', h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/notifications/${n.id}`); rerender() }) }, 'Dismiss'))) : h('p', { class: 'muted' }, 'Nothing here.'))
}

const RENDER = { overview, quotas, budgets, plans, invoices, payments, inbox }

export default {
  id: 'usage', title: 'Usage & billing', group: 'Account', order: 20,
  async render(el, arg, lib) {
    const { h } = lib
    const tab = RENDER[arg] ? arg : 'overview'
    put(el, h('h1', {}, 'Usage & billing'),
      h('nav', { class: 'bl-tabs', 'aria-label': 'Billing sections' }, TABS.map(([id, label]) => h('a', { href: `#usage/${id}`, 'aria-current': id === tab ? 'page' : null }, label))))
    const body = h('div')
    el.append(body)
    await RENDER[tab](body, lib)
  },
}
