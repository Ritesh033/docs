// Console home: one glance at everything the account runs. Each card loads independently (Promise.allSettled semantics),
// so a slow or failing service degrades to "Unavailable" on its own card instead of blanking the page.
import { stackedBars, legend } from '/charts.js'
import { icon } from '/icons.js'

const pct = (n) => Math.max(0, Math.min(100, Math.round(n)))

function greeting(name) {
  const hr = new Date().getHours()
  const part = hr < 5 ? 'Working late' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'
  return name ? `${part}, ${name}` : part
}

async function render(el, _arg, lib) {
  const { h, api, fmtBytes, fmtMoney, fmtNumber, fmtRelative, badge, skeleton, emptyState } = lib

  const bar = (value, label) => {
    const p = pct(value)
    return h('div', { class: `hm-bar${p >= 100 ? ' bad' : p >= 80 ? ' warn' : ''}`, role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(p) }, h('i', { style: { width: `${p}%` } }))
  }
  const unavailable = (what) => h('p', { class: 'muted' }, `${what} is unavailable right now.`)
  const failed = (e) => (e?.status === 403 ? 'This key does not have access to that service' : 'Unavailable')

  // ---- header + status ---------------------------------------------------------------------------------------
  const sub = h('p', { class: 'muted' }, new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))
  const title = h('h1', {}, greeting(lib.state.me?.name))
  const statusEl = h('span', { class: 'hm-status' }, badge('Checking status…'))
  el.append(h('div', { class: 'page-head' }, h('div', {}, title, sub), statusEl))

  // ---- stat tiles ---------------------------------------------------------------------------------------------
  const mkTile = (href, ico, label) => {
    const value = h('div', { class: 'hm-val' }, skeleton(1, { height: '26px', width: '55%' }))
    const note = h('div', { class: 'hm-sub' })
    const extra = h('div', { class: 'hm-extra' })
    const a = h('a', { class: 'hm-tile', href }, h('span', { class: 'hm-ico' }, icon(ico)), h('div', { class: 'hm-lab' }, label), value, note, extra)
    return { a, set: (v, s, x) => { value.replaceChildren(String(v)); note.textContent = s ?? ''; if (x) extra.replaceChildren(x) }, fail: (e) => { value.replaceChildren('–'); note.textContent = failed(e) } }
  }
  const T = {
    compute: mkTile('#compute', 'compute', 'Instances'),
    functions: mkTile('#functions', 'functions', 'Functions'),
    storage: mkTile('#storage', 'storage', 'Buckets'),
    sql: mkTile('#sql', 'sql', 'SQL databases'),
    drive: mkTile('#drive', 'drive', 'Drive'),
    chat: mkTile('#chat', 'chat', 'Conversations'),
  }
  el.append(h('section', { class: 'hm-tiles', 'aria-label': 'Resources' }, ...Object.values(T).map((t) => t.a)))

  // ---- cards ----------------------------------------------------------------------------------------------------
  const card = (heading, ...kids) => {
    const body = h('div', { class: 'hm-body' }, skeleton(3))
    const sec = h('section', { class: 'hm-card' }, h('div', { class: 'hm-head' }, h('h2', {}, heading), ...kids), body)
    return { sec, body }
  }
  const spend = card('This month', h('a', { href: '#usage' }, 'Billing'))
  const quotas = card('Plan limits')
  const costs = card('Daily cost, last 14 days')
  const health = card('Last hour')
  const activity = card('Recent activity', h('a', { href: '#security' }, 'Audit log'))
  const actions = h('section', { class: 'hm-card' }, h('div', { class: 'hm-head' }, h('h2', {}, 'Quick actions')),
    h('div', { class: 'hm-actions' }, ...[
      ['#chat', 'chat', 'Ask the assistant'], ['#compute', 'compute', 'Launch an instance'], ['#functions', 'functions', 'Create a function'],
      ['#sql', 'sql', 'Create a SQL database'], ['#drive', 'drive', 'Upload to Drive'], ['#keys', 'keys', 'Create an API key'],
    ].map(([href, ico, label]) => h('a', { class: 'hm-act', href }, icon(ico), h('span', {}, label)))))
  el.append(h('div', { class: 'hm-grid' }, spend.sec, quotas.sec, costs.sec, health.sec, activity.sec, actions))

  // ---- data -----------------------------------------------------------------------------------------------------
  const get = (path) => api('GET', path)
  const jobs = [
    get('/api/me').then(({ user }) => { lib.state.me = user; if (user.name) title.textContent = greeting(user.name) }).catch(() => {}),

    get('/api/status').then((r) => {
      const bad = Object.entries(r.components ?? {}).filter(([k, v]) => k !== 'modules' && v.ok === false).map(([k]) => k)
        .concat(Object.entries(r.components?.modules ?? {}).filter(([, v]) => v.ok === false).map(([k]) => `${k} module`))
      statusEl.replaceChildren(r.status === 'ok' && !bad.length ? badge('All systems operational', 'ok') : badge(`Degraded: ${bad.join(', ') || r.status}`, 'warn'))
    }).catch(() => statusEl.replaceChildren(badge('Status unavailable', 'bad'))),

    get('/api/compute/instances').then((r) => {
      const live = r.instances.filter((i) => i.state !== 'terminated')
      T.compute.set(fmtNumber(live.filter((i) => i.state === 'running').length), `running of ${live.length}`)
    }).catch((e) => T.compute.fail(e)),

    get('/api/functions').then((r) => T.functions.set(fmtNumber(r.functions.length), r.functions.length === 1 ? 'serverless function' : 'serverless functions')).catch((e) => T.functions.fail(e)),

    get('/api/buckets').then((r) => T.storage.set(fmtNumber(r.buckets.length), `${fmtBytes(r.buckets.reduce((a, b) => a + (b.sizeBytes ?? 0), 0))} stored`)).catch((e) => T.storage.fail(e)),

    get('/api/sql').then((r) => T.sql.set(fmtNumber(r.databases.length), 'managed databases')).catch((e) => T.sql.fail(e)),

    get('/api/drive/usage').then((r) => T.drive.set(fmtBytes(r.used), r.quota ? `of ${fmtBytes(r.quota)}` : `${fmtNumber(r.files)} files`, r.quota ? bar((r.used / r.quota) * 100, 'Drive space used') : null)).catch((e) => T.drive.fail(e)),

    get('/api/conversations?limit=50').then((r) => T.chat.set(r.nextCursor ? `${r.conversations.length}+` : fmtNumber(r.conversations.length), 'with the assistant')).catch((e) => T.chat.fail(e)),

    Promise.all([get('/api/billing/forecast'), get('/api/billing/plan')]).then(([f, p]) => {
      spend.body.replaceChildren(
        h('div', { class: 'hm-kv' },
          h('div', {}, h('b', { class: 'hm-big' }, fmtMoney(f.monthToDate)), h('span', { class: 'muted' }, 'month to date')),
          h('div', {}, h('b', { class: 'hm-big' }, fmtMoney(f.projected)), h('span', { class: 'muted' }, `projected for ${f.period}`))),
        bar((f.daysElapsed / f.daysInMonth) * 100, `Day ${f.daysElapsed} of ${f.daysInMonth}`),
        h('p', { class: 'muted hm-note' }, `Day ${f.daysElapsed} of ${f.daysInMonth} · `, badge(p.name + (p.inTrial ? ' trial' : ''), 'info'), p.cancelAtPeriodEnd ? ' cancels at period end' : ''))
    }).catch((e) => spend.body.replaceChildren(unavailable(`Billing (${failed(e)})`))),

    get('/api/billing/quotas').then((r) => {
      const top = [...r.quotas].filter((q) => q.limit > 0).sort((a, b) => b.percent - a.percent).slice(0, 5)
      quotas.body.replaceChildren(top.length
        ? h('ul', { class: 'hm-quotas' }, ...top.map((q) => h('li', {}, h('div', { class: 'hm-qrow' }, h('span', {}, q.label), h('span', { class: 'muted' }, q.unit === 'bytes' ? `${fmtBytes(q.used)} / ${fmtBytes(q.limit)}` : `${fmtNumber(q.used)} / ${fmtNumber(q.limit)}`)), bar(q.percent, `${q.label} used`))))
        : h('p', { class: 'muted' }, 'No limits on this plan.'))
    }).catch((e) => quotas.body.replaceChildren(unavailable(`Limits (${failed(e)})`))),

    get('/api/billing/cost/daily').then((r) => {
      const days = r.days.slice(-14)
      const services = [...new Set(days.flatMap((d) => Object.keys(d.byService)))].sort()
      costs.body.replaceChildren(services.length
        ? h('div', {}, stackedBars(days.map((d) => ({ label: d.day.slice(5), parts: d.byService })), { title: 'Daily cost by service', format: (v) => fmtMoney(v) }), legend(h, services))
        : emptyState('No spend yet', 'Usage from compute, functions, storage and the assistant shows up here.'))
    }).catch((e) => costs.body.replaceChildren(unavailable(`Costs (${failed(e)})`))),

    get('/api/monitoring/overview').then((r) => {
      health.body.replaceChildren(h('div', { class: 'hm-kv' },
        h('div', {}, h('b', { class: 'hm-big' }, fmtNumber(r.requests)), h('span', { class: 'muted' }, 'API requests')),
        h('div', {}, h('b', { class: 'hm-big' }, `${(r.errorRate * 100).toFixed(r.errorRate && r.errorRate < 0.01 ? 2 : 1)}%`), h('span', { class: 'muted' }, 'error rate')),
        h('div', {}, h('b', { class: 'hm-big' }, r.latency?.p95 != null ? `${r.latency.p95} ms` : '–'), h('span', { class: 'muted' }, 'p95 latency'))),
      h('a', { href: '#monitoring', class: 'hm-note' }, 'Open monitoring'))
    }).catch((e) => health.body.replaceChildren(unavailable(`Monitoring (${failed(e)})`))),

    get('/api/audit?limit=6').then((r) => {
      activity.body.replaceChildren(r.entries.length
        ? h('ul', { class: 'hm-feed' }, ...r.entries.map((e) => h('li', {}, h('code', {}, e.action), h('span', { class: 'muted' }, fmtRelative(e.ts)))))
        : h('p', { class: 'muted' }, 'Nothing yet.'))
    }).catch((e) => activity.body.replaceChildren(unavailable(`Activity (${failed(e)})`))),
  ]
  void jobs // cards fill in as their requests settle; the page itself is ready immediately
}

export default { id: 'home', title: 'Overview', group: 'Overview', order: 0, keywords: 'dashboard home summary status', render }
