// API reference viewer: renders /api/openapi.json (generated from the router) as a searchable, grouped list. DOM-built, CSP-safe.
import { h } from '/lib.js'

const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete', 'head']
const main = document.getElementById('api-main')
const nav = document.getElementById('api-nav')

let spec
try { spec = await (await fetch('/api/openapi.json')).json() } catch (e) { main.replaceChildren(h('p', { class: 'err' }, `Could not load the API description: ${e.message}`)); throw e }

const ops = []
for (const [path, item] of Object.entries(spec.paths)) for (const [method, op] of Object.entries(item)) ops.push({ path, method, op, tag: op.tags?.[0] ?? 'other' })
ops.sort((a, b) => a.path.localeCompare(b.path) || METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method))
const groups = [...new Set(ops.map((o) => o.tag))].sort((a, b) => a.localeCompare(b))

const curl = ({ path, method, op }) => {
  const url = path.replace(/\{(\w+)\}/g, '<$1>')
  const auth = op.security?.some((s) => s.bearerAuth) ? ` \\\n  -H "Authorization: Bearer $RD_TOKEN"` : ''
  const body = op.requestBody?.content?.['application/json']?.example
  return `curl -X ${method.toUpperCase()} "$RD_URL${url}"${auth}${body ? ` \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body)}'` : ''}`
}

function card(o) {
  const { path, method, op } = o
  const open = h('details', { class: 'dc-op', 'data-text': `${method} ${path} ${op.summary ?? ''} ${o.tag}`.toLowerCase() },
    h('summary', {}, h('span', { class: `dc-m dc-${method}` }, method.toUpperCase()), h('code', {}, path), h('span', { class: 'dc-sum muted' }, op.summary && !op.summary.startsWith(method.toUpperCase() + ' /') ? op.summary : ''),
      op.security?.length === 0 ? h('span', { class: 'badge info' }, 'public') : null),
    h('div', { class: 'dc-body' },
      op.description ? h('p', {}, op.description) : null,
      op.parameters?.length ? h('p', {}, h('b', {}, 'Path parameters: '), op.parameters.map((p) => h('code', {}, p.name)).flatMap((c, i) => (i ? [', ', c] : [c]))) : null,
      op.requestBody ? h('p', {}, h('b', {}, 'Body: '), Object.keys(op.requestBody.content)[0]) : null,
      op.requestBody?.content?.['application/json']?.example ? h('pre', {}, JSON.stringify(op.requestBody.content['application/json'].example, null, 2)) : null,
      op.responses?.['200']?.content || op.responses?.['2XX']?.content ? h('pre', {}, JSON.stringify((op.responses['200'] ?? op.responses['2XX']).content['application/json'].example, null, 2)) : null,
      h('pre', { class: 'dc-curl' }, curl(o))))
  return open
}

function render(filter = '') {
  const q = filter.trim().toLowerCase()
  const sections = []
  for (const g of groups) {
    const list = ops.filter((o) => o.tag === g)
    const el = h('section', { class: 'dc-group', id: `g-${g.replace(/\W+/g, '-').toLowerCase()}` }, h('h2', {}, g, ' ', h('span', { class: 'muted dc-count' }, String(list.length))), ...list.map(card))
    if (q) { let any = false; for (const d of el.querySelectorAll('.dc-op')) { const hit = d.dataset.text.includes(q); d.hidden = !hit; any ||= hit }; el.hidden = !any; if (any) for (const d of el.querySelectorAll('.dc-op:not([hidden])')) if (el.querySelectorAll('.dc-op:not([hidden])').length <= 8) d.open = true }
    sections.push(el)
  }
  main.replaceChildren(
    h('h1', {}, spec.info.title), h('p', { class: 'muted' }, spec.info.description),
    h('p', {}, `${ops.length} operations in ${groups.length} groups. Set `, h('code', {}, 'RD_URL'), ' and ', h('code', {}, 'RD_TOKEN'), ' (a session token or an ', h('code', {}, 'rdk_…'), ' API key) to try the examples.'),
    h('input', { type: 'search', id: 'dc-filter', placeholder: 'Filter by path, method or text…', 'aria-label': 'Filter operations', value: filter, oninput: (e) => { const v = e.target.value; render(v); const i = document.getElementById('dc-filter'); i.focus(); i.setSelectionRange(v.length, v.length) } }),
    ...sections)
}
nav.replaceChildren(...groups.map((g) => h('a', { href: `#g-${g.replace(/\W+/g, '-').toLowerCase()}` }, g, h('span', { class: 'muted' }, String(ops.filter((o) => o.tag === g).length)))))
render()
if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView()
