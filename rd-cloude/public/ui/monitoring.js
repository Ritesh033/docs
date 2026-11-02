import { lineChart, legend } from '/charts.js'

const put = (el, ...kids) => el.append(...kids.flat(Infinity).filter((x) => x != null && x !== false))
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((x) => x != null && x !== false))
const TABS = [['overview', 'Overview'], ['logs', 'Request log'], ['alerts', 'Alerts'], ['uptime', 'Uptime checks'], ['channels', 'Webhooks'], ['status', 'System status']]
const ALERT_HELP = { error_rate: '5xx rate in % (needs ≥ 10 requests in the window)', latency_p95: 'p95 latency in ms', error_count: 'number of 5xx responses', no_traffic: 'minutes without any request' }

export default {
  id: 'monitoring', title: 'Monitoring', group: 'Cloud', order: 60,
  async render(el, arg, lib) {
    const { h, api, act, toast, rerender, confirmDialog, promptDialog, fmtDate } = lib
    const tab = TABS.some(([id]) => id === arg) ? arg : 'overview'
    put(el, h('h1', {}, 'Monitoring'), h('nav', { class: 'mo-tabs', 'aria-label': 'Monitoring sections' }, TABS.map(([id, l]) => h('a', { href: `#monitoring/${id}`, 'aria-current': id === tab ? 'page' : null }, l))))
    const body = h('div'); el.append(body)
    const err = (e) => h('div', { class: 'mo-err', role: 'alert' }, e.message)
    const badge = (t, cls = t) => h('span', { class: `mo-badge mo-${cls}` }, t)
    const field = (l, i) => h('label', {}, l, i)
    const sel = (opts, v, aria) => h('select', { 'aria-label': aria }, opts.map(([x, l]) => h('option', { value: x, selected: x === v ? true : null }, l)))

    /* ---------------------------------------------------------------- overview */
    if (tab === 'overview') {
      const win = sessionStorage.getItem('rd_mo_win') ?? '1h'
      const o = await api('GET', `/api/monitoring/overview?window=${win}`)
      const w = sel([['1h', 'Last hour'], ['24h', 'Last 24 hours']], win, 'Time window'); w.addEventListener('change', () => { sessionStorage.setItem('rd_mo_win', w.value); rerender() })
      put(body, h('div', { class: 'mo-row' }, w, h('span', { class: 'muted' }, 'Your account\'s API and console traffic.')),
        h('div', { class: 'mo-grid' }, [['Requests', o.requests], ['5xx errors', o.errors5xx], ['Error rate', `${o.errorRate}%`], ['p50', o.latency.p50 == null ? '—' : `${o.latency.p50} ms`], ['p95', o.latency.p95 == null ? '—' : `${o.latency.p95} ms`], ['p99', o.latency.p99 == null ? '—' : `${o.latency.p99} ms`]].map(([l, v]) => h('div', { class: 'mo-stat' }, h('b', {}, String(v)), h('span', {}, l)))),
        o.series.length ? [h('h3', {}, 'Requests and errors'), lineChart([{ name: 'Requests', points: o.series.map((p) => ({ x: p.t.slice(11, 16), y: p.requests })) }, { name: 'Errors', points: o.series.map((p) => ({ x: p.t.slice(11, 16), y: p.errors })) }], { title: 'Requests and 5xx errors over time', area: true }), legend(h, ['Requests', 'Errors']),
          h('h3', {}, 'p95 latency (ms)'), lineChart([{ name: 'p95', points: o.series.map((p) => ({ x: p.t.slice(11, 16), y: p.p95 ?? 0 })) }], { title: 'p95 latency per interval' })] : h('p', { class: 'muted' }, 'No traffic in this window yet.'),
        h('h3', {}, 'Top endpoints'), o.topEndpoints.length ? h('table', { class: 'mo-table' }, h('thead', {}, h('tr', {}, ['Endpoint', 'Requests', 'Errors', 'Avg ms'].map((x) => h('th', {}, x)))), h('tbody', {}, o.topEndpoints.map((e) => h('tr', {}, h('td', {}, h('code', {}, e.endpoint)), h('td', {}, e.requests), h('td', {}, e.errors), h('td', {}, e.avgMs))))) : h('p', { class: 'muted' }, '—'),
        h('h3', {}, 'By credential'), o.byKey.length ? h('table', { class: 'mo-table' }, h('tbody', {}, o.byKey.map((k) => h('tr', {}, h('td', {}, k.key), h('td', {}, k.requests))))) : h('p', { class: 'muted' }, '—'))
    }

    /* ---------------------------------------------------------------- request log */
    if (tab === 'logs') {
      const f = { status: sel([['', 'Any status'], ['200', '2xx'], ['400', '4xx'], ['500', '5xx'], ['404', '404'], ['401', '401']], '', 'Status'), method: sel([['', 'Any method'], ['GET', 'GET'], ['POST', 'POST'], ['PUT', 'PUT'], ['PATCH', 'PATCH'], ['DELETE', 'DELETE']], '', 'Method'), path: h('input', { type: 'search', placeholder: 'path contains…', 'aria-label': 'Path filter' }), rid: h('input', { placeholder: 'request id', 'aria-label': 'Request id' }) }
      const out = h('div', { class: 'mo-tail', tabindex: 0, 'aria-label': 'Request log', 'aria-live': 'polite' })
      let cursor = null, timer = null
      const qs = () => { const p = new URLSearchParams({ limit: '100' }); if (f.status.value) p.set('status', f.status.value); if (f.method.value) p.set('method', f.method.value); if (f.path.value) p.set('path', f.path.value); if (f.rid.value) p.set('requestId', f.rid.value); return p }
      const row = (e) => h('tr', {}, h('td', {}, new Date(e.at).toLocaleTimeString()), h('td', {}, badge(String(e.status), `${String(e.status)[0]}xx`)), h('td', {}, e.method), h('td', {}, h('code', { class: 'mo-code' }, e.path)), h('td', {}, `${e.durationMs} ms`), h('td', {}, e.key ?? ''), h('td', {}, h('code', { class: 'mo-code' }, e.requestId?.slice(0, 8) ?? '')))
      const load = async (append) => {
        try {
          const p = qs(); if (append && cursor) p.set('cursor', cursor)
          const r = await api('GET', `/api/monitoring/logs?${p}`)
          cursor = r.nextCursor
          if (append) { out.querySelector('tbody').append(...r.logs.map(row)); out.querySelector('.more')?.remove() } else fill(out, r.logs.length ? h('table', { class: 'mo-table' }, h('thead', {}, h('tr', {}, ['Time', 'Status', 'Method', 'Path', 'Duration', 'Credential', 'Request'].map((x) => h('th', {}, x)))), h('tbody', {}, r.logs.map(row))) : h('p', { class: 'muted', style: { padding: '8px' } }, 'No requests match.'))
          if (cursor) out.append(h('button', { class: 'sec more', onclick: act(() => load(true)) }, 'Load more'))
        } catch (e) { fill(out, err(e)) }
      }
      const live = h('input', { type: 'checkbox', id: 'mo-live' })
      live.addEventListener('change', () => { clearInterval(timer); if (live.checked) { timer = setInterval(() => load(false), 3000); window.addEventListener('hashchange', () => clearInterval(timer), { once: true }) } })
      put(body, h('div', { class: 'mo-row' }, f.status, f.method, f.path, f.rid, h('button', { onclick: act(() => load(false)) }, 'Search'), h('label', {}, live, ' live tail (3 s)')), h('p', { class: 'muted' }, 'Query strings and credentials are never recorded. Entries are kept in a bounded buffer.'), out)
      await load(false)
    }

    /* ---------------------------------------------------------------- alerts */
    if (tab === 'alerts') {
      const [{ alerts }, { events }] = await Promise.all([api('GET', '/api/monitoring/alerts'), api('GET', '/api/monitoring/alerts/history')])
      const name = h('input', { placeholder: 'High error rate', 'aria-label': 'Rule name', maxlength: 80 }), type = sel(Object.keys(ALERT_HELP).map((k) => [k, k]), 'error_rate', 'Type'), thr = h('input', { type: 'number', value: '5', step: 'any', 'aria-label': 'Threshold' }), win2 = h('input', { type: 'number', value: '5', min: '1', max: '1440', 'aria-label': 'Window in minutes' }), help = h('span', { class: 'muted' }, ALERT_HELP.error_rate)
      type.addEventListener('change', () => { help.textContent = ALERT_HELP[type.value] })
      put(body, h('div', { class: 'mo-form' }, field('Name', name), field('Condition', type), field('Threshold', thr), field('Window (min)', win2)), h('div', { class: 'mo-row' }, h('button', { onclick: act(async () => { await api('POST', '/api/monitoring/alerts', { name: name.value, type: type.value, threshold: Number(thr.value), windowMin: Number(win2.value) }); rerender() }) }, 'Add rule'), help),
        alerts.length ? h('table', { class: 'mo-table' }, h('thead', {}, h('tr', {}, ['Rule', 'Condition', 'State', 'Last value', ''].map((x) => h('th', {}, x)))), h('tbody', {}, alerts.map((a) => h('tr', {}, h('td', {}, a.name), h('td', {}, `${a.type} ≥ ${a.threshold} over ${a.windowMin} min`), h('td', {}, badge(a.state), a.silencedUntil ? h('span', { class: 'muted' }, ` silenced until ${new Date(a.silencedUntil).toLocaleTimeString()}`) : null), h('td', {}, a.lastValue ?? '—'),
          h('td', {}, h('button', { class: 'sec', onclick: act(async () => { await api('POST', `/api/monitoring/alerts/${a.id}/silence`, { minutes: a.silencedUntil ? 0 : 60 }); rerender() }) }, a.silencedUntil ? 'Unsilence' : 'Silence 1 h'), ' ', h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/monitoring/alerts/${a.id}`); rerender() }) }, 'Delete')))))) : h('p', { class: 'muted' }, 'No alert rules.'),
        h('h3', {}, 'History'), events.length ? h('table', { class: 'mo-table' }, h('tbody', {}, events.map((e) => h('tr', {}, h('td', {}, fmtDate(e.at)), h('td', {}, e.rule), h('td', {}, badge(e.state)), h('td', {}, `${e.value ?? '—'} (threshold ${e.threshold})`))))) : h('p', { class: 'muted' }, 'Nothing has fired yet.'),
        h('p', { class: 'muted' }, 'Alerts create in-app notifications and are sent to your webhook channels.'))
    }

    /* ---------------------------------------------------------------- uptime checks */
    if (tab === 'uptime') {
      const { checks } = await api('GET', '/api/monitoring/checks')
      const name = h('input', { placeholder: 'My API', 'aria-label': 'Check name' }), url = h('input', { placeholder: 'https://example.com/health', 'aria-label': 'URL', type: 'url' }), iv = sel([['60', '1 min'], ['300', '5 min'], ['900', '15 min'], ['3600', '1 h']], '300', 'Interval'), st = h('input', { type: 'number', value: '200', min: '100', max: '599', 'aria-label': 'Expected status', style: { width: '90px' } })
      put(body, h('div', { class: 'mo-note' }, 'Checks run from the platform with SSRF protection: only public http(s) addresses are allowed (private, loopback and link-local ranges are blocked, redirects are re-checked). Two consecutive failures mark a check “down”.'),
        h('div', { class: 'mo-form' }, field('Name', name), field('URL', url), field('Interval', iv), field('Expected status', st)), h('div', { class: 'mo-row' }, h('button', { onclick: act(async () => { await api('POST', '/api/monitoring/checks', { name: name.value, url: url.value, intervalSec: Number(iv.value), expectedStatus: Number(st.value) }); rerender() }) }, 'Add check')),
        checks.length ? h('table', { class: 'mo-table' }, h('thead', {}, h('tr', {}, ['Check', 'State', 'Uptime (24 h)', 'Avg', 'Last run', ''].map((x) => h('th', {}, x)))), h('tbody', {}, checks.map((c) => h('tr', {}, h('td', {}, c.name, h('div', { class: 'muted mo-code' }, c.url)), h('td', {}, badge(c.state)), h('td', {}, c.uptimePercent == null ? '—' : `${c.uptimePercent}% (${c.samples})`), h('td', {}, c.avgMs == null ? '—' : `${c.avgMs} ms`), h('td', {}, c.lastCheckedAt ? fmtDate(c.lastCheckedAt) : '—'),
          h('td', {}, h('button', { class: 'sec', onclick: act(async () => { const r = await api('POST', `/api/monitoring/checks/${c.id}/run`, {}); toast(r.ok ? `OK (${r.status}, ${r.ms} ms)` : `Failed: ${r.error}`, r.ok ? 'info' : 'error'); rerender() }) }, 'Run now'), ' ', h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/monitoring/checks/${c.id}`); rerender() }) }, 'Delete')))))) : h('p', { class: 'muted' }, 'No checks yet.'))
    }

    /* ---------------------------------------------------------------- channels */
    if (tab === 'channels') {
      const { channels } = await api('GET', '/api/monitoring/channels')
      const name = h('input', { placeholder: 'On-call webhook', 'aria-label': 'Channel name' }), url = h('input', { placeholder: 'https://hooks.example.com/rd', 'aria-label': 'Webhook URL', type: 'url' })
      put(body, h('div', { class: 'mo-note' }, 'Payloads are JSON, signed with HMAC-SHA256: header ', h('code', {}, 'x-rd-signature: v1=hex(hmac(secret, timestamp + "." + body))'), ' with ', h('code', {}, 'x-rd-timestamp'), '. Failed deliveries are retried (3 attempts). Internal addresses are blocked.'),
        h('div', { class: 'mo-form' }, field('Name', name), field('URL', url)), h('div', { class: 'mo-row' }, h('button', { onclick: act(async () => {
          const c = await api('POST', '/api/monitoring/channels', { name: name.value, url: url.value })
          await promptDialog('Signing secret — copy it now, it is shown only once', c.secret, { readonly: true }); rerender()
        }) }, 'Add channel')),
        channels.length ? h('table', { class: 'mo-table' }, h('tbody', {}, channels.map((c) => h('tr', {}, h('td', {}, c.name, h('div', { class: 'muted mo-code' }, c.url)), h('td', {}, c.events.join(', ')), h('td', {}, badge(c.enabled ? 'ok' : 'unknown', c.enabled ? 'ok' : 'unknown'), ` ${c.enabled ? 'enabled' : 'disabled'}`),
          h('td', {}, h('button', { class: 'sec', onclick: act(async () => { const r = await api('POST', `/api/monitoring/channels/${c.id}/test`, {}); toast(r.delivered ? `Delivered (${r.status})` : `Failed: ${r.error ?? r.status}`, r.delivered ? 'info' : 'error') }) }, 'Send test'), ' ',
            h('button', { class: 'sec', onclick: act(async () => { await api('PATCH', `/api/monitoring/channels/${c.id}`, { enabled: !c.enabled }); rerender() }) }, c.enabled ? 'Disable' : 'Enable'), ' ',
            h('button', { class: 'sec', onclick: act(async () => { if (await confirmDialog(`Delete channel "${c.name}"?`, 'Delete')) { await api('DELETE', `/api/monitoring/channels/${c.id}`); rerender() } }) }, 'Delete')))))) : h('p', { class: 'muted' }, 'No channels.'))
    }

    /* ---------------------------------------------------------------- status */
    if (tab === 'status') {
      const s = await api('GET', '/api/status')
      put(body, h('div', { class: 'mo-row' }, h('h2', { style: { margin: 0 } }, 'Platform status'), badge(s.status)), h('p', { class: 'muted' }, `Up for ${Math.floor(s.uptimeSeconds / 60)} min since ${fmtDate(s.startedAt)}.`),
        h('table', { class: 'mo-table' }, h('tbody', {}, h('tr', {}, h('td', {}, 'Database'), h('td', {}, badge(s.components.database.ok ? 'ok' : 'down'))),
          h('tr', {}, h('td', {}, 'Event loop'), h('td', {}, badge(s.components.eventLoop.ok ? 'ok' : 'degraded'), ` mean ${s.components.eventLoop.meanLagMs} ms · p99 ${s.components.eventLoop.p99LagMs} ms`)),
          Object.entries(s.components.modules).map(([m, v]) => h('tr', {}, h('td', {}, `module: ${m}`), h('td', {}, badge(v.ok ? 'ok' : 'down'), v.error ? ` ${v.error}` : ''))))))
    }
  },
}
