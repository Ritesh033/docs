import { lineChart } from '/charts.js'

const put = (el, ...kids) => el.append(...kids.flat(Infinity).filter((x) => x != null && x !== false))
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((x) => x != null && x !== false))
const TABS = [['code', 'Code'], ['test', 'Test'], ['versions', 'Versions & aliases'], ['env', 'Environment'], ['triggers', 'Triggers'], ['network', 'Network'], ['metrics', 'Metrics'], ['logs', 'Invocations']]
const STARTER = `// Runs in an isolated sandbox: no network (unless enabled), no file system, no child processes.
// ctx.kv is a small key-value store; ctx.env / process.env hold your environment variables.
module.exports = async (event, ctx) => {
  ctx.log('received', event)
  const visits = ((await ctx.kv.get('visits')) ?? 0) + 1
  await ctx.kv.set('visits', visits)
  return { message: 'Hello from RD Cloude!', visits, echo: event }
}
`

export default {
  id: 'functions', title: 'Functions', group: 'Cloud', order: 25,
  async render(el, arg, lib) {
    const { h, api, act, toast, rerender, confirmDialog, promptDialog, fmtDate } = lib
    const [fnId, tabArg] = (arg ?? '').split('/')
    const tab = TABS.some(([id]) => id === tabArg) ? tabArg : 'code'
    const { functions, isolation } = await api('GET', '/api/functions')
    const side = h('aside', { class: 'fn-side', 'aria-label': 'Functions' }, h('h3', {}, `Functions (${functions.length})`))
    for (const f of functions) side.append(h('button', { class: 'fn-item', 'aria-current': f.id === fnId ? 'true' : null, onclick: () => (location.hash = `#functions/${f.id}`) }, f.name, h('small', {}, `v${f.latestVersion}${f.http.enabled ? ' · http' : ''}${f.schedule?.enabled ? ' · cron' : ''}`)))
    const nameBox = h('input', { placeholder: 'new-function', 'aria-label': 'New function name', maxlength: 48 })
    put(side, h('div', { class: 'fn-row' }, nameBox, h('button', { onclick: act(async () => { const f = await api('POST', '/api/functions', { name: nameBox.value.trim(), code: STARTER }); location.hash = `#functions/${f.id}` }) }, 'Create')))
    const main = h('div')
    put(el, h('h1', {}, 'Functions'),
      !isolation.ready ? h('div', { class: 'fn-err', role: 'alert' }, 'Function execution is disabled on this host: the sandbox needs Linux namespaces and the Node permission model (see docs/functions.md). You can still edit functions.') : null,
      h('div', { class: 'fn-layout' }, side, main))
    const fn = fnId ? await api('GET', `/api/functions/${fnId}`).catch(() => null) : null
    if (!fn) { put(main, h('p', { class: 'muted' }, functions.length ? 'Choose a function on the left.' : 'No functions yet. Create one to run JavaScript on demand, over HTTP, or on a schedule.'), h('div', { class: 'fn-note' }, `Sandbox: ${isolation.mode === 'none' ? 'unavailable' : `${isolation.mode} (no network, own process tree, no file access)`}. Each invocation is limited by memory, time and output size.`)); return }

    const base = `/api/functions/${fn.id}`
    put(main, h('div', { class: 'fn-row' }, h('h2', { style: { margin: 0 } }, fn.name), h('span', { class: 'fn-badge' }, `v${fn.latestVersion}`), h('span', { class: 'muted' }, `${fn.memoryMb} MB · ${fn.timeoutMs} ms`),
      h('button', { class: 'sec', onclick: act(async () => { if (await confirmDialog(`Delete function "${fn.name}", its versions, kv data and logs?`, 'Delete function')) { await api('DELETE', base); location.hash = '#functions' } }) }, 'Delete')),
      h('div', { class: 'fn-tabs', role: 'tablist' }, TABS.map(([id, label]) => h('button', { role: 'tab', 'aria-selected': id === tab ? 'true' : 'false', onclick: () => (location.hash = `#functions/${fn.id}/${id}`) }, label))))
    const body = h('div')
    main.append(body)
    const errBox = (e) => h('div', { class: 'fn-err', role: 'alert' }, e.message)

    const resultView = (r) => h('div', { class: 'fn-out', 'aria-live': 'polite' },
      h('div', {}, h('span', { class: `fn-badge ${r.status === 'ok' ? 'fn-ok' : 'fn-bad'}` }, r.status), ` ${r.durationMs} ms · billed ${r.billedMs} ms · v${r.version}`),
      r.error ? h('pre', {}, `${r.error.name}: ${r.error.message}${r.error.stack ? `\n${r.error.stack}` : ''}`) : h('pre', {}, JSON.stringify(r.result, null, 2)),
      r.logs?.length ? [h('b', {}, 'Logs'), h('pre', {}, r.logs.map((l) => `+${l.t}ms ${l.level}: ${l.line}`).join('\n'))] : null)

    /* ---------------------------------------------------------------- code */
    if (tab === 'code') {
      const ta = h('textarea', { class: 'fn-code', spellcheck: 'false', wrap: 'off', 'aria-label': 'Function code' }); ta.value = fn.code
      const gutter = h('pre', { class: 'fn-gutter', 'aria-hidden': 'true' })
      const lines = () => { gutter.textContent = Array.from({ length: ta.value.split('\n').length }, (_, i) => i + 1).join('\n') }
      lines()
      ta.addEventListener('input', lines)
      ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop })
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); lines() }
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save() }
      })
      const save = act(async () => { const r = await api('PUT', `${base}/code`, { code: ta.value }); toast(r.unchanged ? 'No changes' : `Saved as version ${r.latestVersion} (live)`, 'info'); rerender() })
      put(body, h('div', { class: 'fn-editor' }, gutter, ta), h('div', { class: 'fn-row' }, h('button', { onclick: save }, 'Save new version (Ctrl/⌘+S)'), h('span', { class: 'muted' }, `${new Blob([fn.code]).size} bytes · handler: module.exports = async (event, ctx) => …`)))
    }

    /* ---------------------------------------------------------------- test */
    if (tab === 'test') {
      const ev = h('textarea', { class: 'fn-code', spellcheck: 'false', 'aria-label': 'Test event JSON', style: { height: '120px' } }); ev.value = sessionStorage.getItem(`rd_fnev_${fn.id}`) ?? '{\n  "hello": "world"\n}'
      const alias = h('select', { 'aria-label': 'Alias' }, Object.keys(fn.aliases).map((a) => h('option', { value: a }, `${a} (v${fn.aliases[a]})`)))
      const out = h('div')
      put(body, ev, h('div', { class: 'fn-row' }, alias, h('button', { onclick: act(async () => {
        let event; try { event = JSON.parse(ev.value || 'null') } catch (e) { fill(out, errBox(new Error(`Invalid JSON: ${e.message}`))); return }
        sessionStorage.setItem(`rd_fnev_${fn.id}`, ev.value)
        fill(out, h('p', { class: 'muted' }, 'Running…'))
        try { fill(out, resultView(await api('POST', `${base}/invoke`, { event, alias: alias.value }))) } catch (e) { fill(out, errBox(e)) }
      }) }, 'Invoke'), h('button', { class: 'sec', onclick: act(async () => { const r = await api('POST', `${base}/invoke`, { event: JSON.parse(ev.value || 'null'), alias: alias.value, async: true }); toast(`Queued job ${r.jobId}`, 'info') }) }, 'Invoke async')), out)
    }

    /* ---------------------------------------------------------------- versions */
    if (tab === 'versions') {
      const { versions } = await api('GET', `${base}/versions`)
      const pinned = (n) => Object.entries(fn.aliases).filter(([, v]) => v === n).map(([a]) => a)
      put(body, h('p', { class: 'muted' }, 'Aliases point at a version. "live" follows new saves; pin "staging" or others to test before promoting.'),
        h('table', { class: 'fn-table' }, h('thead', {}, h('tr', {}, ['Version', 'Created', 'Size', 'Aliases', ''].map((x) => h('th', {}, x)))),
          h('tbody', {}, versions.slice().reverse().map((v) => h('tr', {}, h('td', {}, `v${v.version}`), h('td', {}, fmtDate(v.createdAt)), h('td', {}, `${v.bytes} B`), h('td', {}, pinned(v.version).map((a) => h('span', { class: 'fn-badge' }, a))),
            h('td', {}, h('button', { class: 'sec', onclick: act(async () => { const a = await promptDialog('Point which alias at this version?', 'staging'); if (a) { await api('PUT', `${base}/aliases/${encodeURIComponent(a)}`, { version: v.version }); rerender() } }) }, 'Set alias'), ' ',
              h('button', { class: 'sec', onclick: act(async () => { const c = await api('GET', `${base}/versions/${v.version}`); const ta = h('textarea', { class: 'fn-code', readonly: true, style: { height: '260px' } }); ta.value = c.code; const d = h('dialog', { class: 'modal' }, h('h3', {}, `Version ${v.version}`), ta, h('div', { class: 'row' }, h('button', { class: 'sec', onclick: () => { d.close(); d.remove() } }, 'Close'))); document.body.append(d); d.showModal() }) }, 'View')))))),
        Object.keys(fn.aliases).filter((a) => a !== 'live').length ? h('div', { class: 'fn-row' }, Object.keys(fn.aliases).filter((a) => a !== 'live').map((a) => h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `${base}/aliases/${a}`); rerender() }) }, `Remove alias ${a}`))) : null)
    }

    /* ---------------------------------------------------------------- env */
    if (tab === 'env') {
      const rows = Object.entries(fn.env)
      const k = h('input', { placeholder: 'NAME', 'aria-label': 'Variable name', maxlength: 64 }), v = h('input', { placeholder: 'value', 'aria-label': 'Variable value', autocomplete: 'off' }), sec = h('input', { type: 'checkbox', id: 'fn-sec', checked: true })
      put(body, h('p', { class: 'muted' }, 'Available as ctx.env.NAME and process.env.NAME. Secret values are encrypted at rest and never shown again.'),
        rows.length ? h('table', { class: 'fn-table' }, h('tbody', {}, rows.map(([name, e]) => h('tr', {}, h('td', {}, h('code', {}, name)), h('td', {}, e.secret ? '•••••••• (secret)' : e.value),
          h('td', {}, h('button', { class: 'sec', onclick: act(async () => { const env = Object.fromEntries(Object.entries(fn.env).filter(([n]) => n !== name).map(([n, x]) => [n, { secret: x.secret }])); await api('PUT', `${base}/env`, { env }); rerender() }) }, 'Remove')))))) : h('p', { class: 'muted' }, 'No variables.'),
        h('div', { class: 'fn-row' }, k, v, h('label', {}, sec, ' secret'), h('button', { onclick: act(async () => {
          const env = Object.fromEntries(Object.entries(fn.env).map(([n, x]) => [n, { secret: x.secret }])); env[k.value.trim()] = { value: v.value, secret: sec.checked }
          await api('PUT', `${base}/env`, { env }); rerender()
        }) }, 'Add / update')))
    }

    /* ---------------------------------------------------------------- triggers */
    if (tab === 'triggers') {
      const en = h('input', { type: 'checkbox', id: 'fn-http', checked: fn.http.enabled ? true : null }), auth = h('select', { 'aria-label': 'HTTP auth' }, h('option', { value: 'apiKey', selected: fn.http.auth === 'apiKey' ? true : null }, 'API key (owner only)'), h('option', { value: 'none', selected: fn.http.auth === 'none' ? true : null }, 'Public (no auth)'))
      const cron = h('input', { value: fn.schedule?.cron ?? '*/5 * * * *', 'aria-label': 'Cron expression', maxlength: 100 }), sev = h('input', { value: JSON.stringify(fn.schedule?.event ?? {}), 'aria-label': 'Schedule event JSON' }), sen = h('input', { type: 'checkbox', id: 'fn-cron', checked: (fn.schedule ? fn.schedule.enabled : true) ? true : null })
      put(body, h('h3', {}, 'HTTP'), h('p', { class: 'muted' }, 'Expose the live version at /fn/<id>/… . Public functions run for anyone with the link — responses are always sandboxed (no scripts, no cookies).'),
        h('div', { class: 'fn-row' }, h('label', {}, en, ' enabled'), auth, h('button', { onclick: act(async () => { await api('PUT', `${base}/trigger`, { http: { enabled: en.checked, auth: auth.value } }); toast('Saved', 'info'); rerender() }) }, 'Save')),
        fn.url ? h('p', {}, h('code', {}, `${location.origin}${fn.url}`)) : null,
        h('h3', {}, 'Schedule (UTC cron)'), h('p', { class: 'muted' }, 'minute hour day-of-month month day-of-week — e.g. */5 * * * * (every 5 min), 0 9 * * mon (Mondays 09:00).'),
        h('div', { class: 'fn-row' }, cron, sev, h('label', {}, sen, ' enabled'), h('button', { onclick: act(async () => { let ev = {}; try { ev = JSON.parse(sev.value || '{}') } catch { throw new Error('Event must be JSON') } await api('PUT', `${base}/trigger`, { schedule: { cron: cron.value, event: ev, enabled: sen.checked } }); toast('Saved', 'info'); rerender() }) }, 'Save'),
          fn.schedule ? h('button', { class: 'sec', onclick: act(async () => { await api('PUT', `${base}/trigger`, { schedule: null }); rerender() }) }, 'Remove') : null),
        fn.schedule?.nextRunAt ? h('p', { class: 'muted' }, `Next run: ${fmtDate(fn.schedule.nextRunAt)}`) : null)
      const [{ jobs: dead }] = await Promise.all([api('GET', `${base}/dlq`)])
      if (dead.length) put(body, h('h3', {}, 'Dead-letter queue'), h('table', { class: 'fn-table' }, h('tbody', {}, dead.map((j) => h('tr', {}, h('td', {}, fmtDate(j.diedAt)), h('td', {}, j.lastError), h('td', {}, h('button', { class: 'sec', onclick: act(async () => { await api('POST', `${base}/dlq/${j.id}/retry`); rerender() }) }, 'Retry'), ' ', h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `${base}/dlq/${j.id}`); rerender() }) }, 'Discard')))))))
    }

    /* ---------------------------------------------------------------- network */
    if (tab === 'network') {
      const on = h('input', { type: 'checkbox', id: 'fn-net', checked: fn.allowNetwork ? true : null }), hosts = h('input', { value: fn.allowedHosts.join(', '), placeholder: 'api.example.com, *.example.org', 'aria-label': 'Allowed hosts' })
      put(body, h('div', { class: 'fn-note' }, 'Functions have no network of their own. With ctx.fetch enabled, requests are made by the platform on the function\'s behalf: only the hosts below, only public addresses (private, loopback and link-local ranges are blocked, redirects are re-checked), at most 10 requests of 1 MB per invocation.'),
        h('div', { class: 'fn-row' }, h('label', {}, on, ' allow ctx.fetch'), hosts, h('button', { onclick: act(async () => { await api('PATCH', base, { allowNetwork: on.checked, allowedHosts: hosts.value.split(',').map((s) => s.trim()).filter(Boolean) }); toast('Saved', 'info'); rerender() }) }, 'Save')))
      const mem = h('input', { type: 'number', min: '64', max: '512', value: String(fn.memoryMb), 'aria-label': 'Memory MB', style: { width: '90px' } }), to = h('input', { type: 'number', min: '100', value: String(fn.timeoutMs), 'aria-label': 'Timeout ms', style: { width: '110px' } })
      put(body, h('h3', {}, 'Resources'), h('div', { class: 'fn-row' }, h('label', {}, 'Memory (MB) ', mem), h('label', {}, 'Timeout (ms) ', to), h('button', { onclick: act(async () => { await api('PATCH', base, { memoryMb: Number(mem.value), timeoutMs: Number(to.value) }); toast('Saved', 'info'); rerender() }) }, 'Save')))
    }

    /* ---------------------------------------------------------------- metrics */
    if (tab === 'metrics') {
      const m = await api('GET', `${base}/metrics`)
      put(body, h('div', { class: 'fn-grid' }, [['Invocations (24h)', m.invocations], ['Errors', m.errors], ['p50', m.p50 == null ? '—' : `${m.p50} ms`], ['p95', m.p95 == null ? '—' : `${m.p95} ms`], ['Billed', `${(m.billedMs / 1000).toFixed(1)} s`]].map(([l, v]) => h('div', { class: 'fn-stat' }, h('b', {}, String(v)), h('span', {}, l)))),
        m.series.length ? [lineChart([{ name: 'Invocations', points: m.series.map((s) => ({ x: s.t.slice(11, 16), y: s.invocations })) }, { name: 'Errors', points: m.series.map((s) => ({ x: s.t.slice(11, 16), y: s.errors })) }], { title: 'Invocations and errors per hour', area: true })] : h('p', { class: 'muted' }, 'No invocations in the last 24 hours.'))
    }

    /* ---------------------------------------------------------------- logs */
    if (tab === 'logs') {
      const { invocations } = await api('GET', `${base}/invocations?limit=50`)
      put(body, invocations.length ? h('table', { class: 'fn-table' }, h('thead', {}, h('tr', {}, ['When', 'Status', 'Trigger', 'Duration', 'Version', 'Details'].map((x) => h('th', {}, x)))),
        h('tbody', {}, invocations.map((i) => h('tr', {}, h('td', {}, fmtDate(i.at)), h('td', {}, h('span', { class: `fn-badge ${i.status === 'ok' ? 'fn-ok' : 'fn-bad'}` }, i.status)), h('td', {}, i.trigger), h('td', {}, `${i.durationMs} ms`), h('td', {}, `v${i.version}${i.alias ? ` (${i.alias})` : ''}`),
          h('td', {}, i.error ? h('div', {}, i.error) : null, i.logs?.length ? h('pre', { class: 'muted', style: { margin: 0, fontSize: '12px', whiteSpace: 'pre-wrap' } }, i.logs.map((l) => `${l.level}: ${l.line}`).join('\n')) : null)))))
        : h('p', { class: 'muted' }, 'No invocations yet.'))
    }
  },
}
