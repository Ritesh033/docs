import { lib, h, api, act, download, promptDialog, state, toast } from '/lib.js'

const $ = (s) => document.querySelector(s)
let mode = 'login'

function logout() { localStorage.removeItem('rd_token'); state.token = null; boot() }

// ---------- built-in views (can be overridden by public/ui/*.js modules with the same id) ----------
const builtinRenderers = {
  async chat(el, arg) {
    const { conversations } = await api('GET', '/api/conversations')
    let current = arg
    const list = h('div', {}, h('button', { onclick: act(async () => { const c = await api('POST', '/api/conversations', {}); location.hash = `#chat/${c.id}` }) }, 'New chat'),
      ...conversations.map((c) => h('div', {}, h('a', { href: `#chat/${c.id}` }, c.title))))
    const log = h('div')
    const input = h('textarea', { placeholder: 'Message RD Cloude…' })
    const send = h('button', { onclick: act(async () => {
      if (!current) current = (await api('POST', '/api/conversations', {})).id
      const content = input.value.trim(); if (!content) return
      input.value = ''
      log.append(h('div', { class: 'msg user' }, content))
      const r = await api('POST', `/api/conversations/${current}/messages`, { content })
      log.append(h('div', { class: 'msg' }, r.assistantMessage.content))
      if (r.artifacts.length) log.append(h('p', { class: 'muted' }, `${r.artifacts.length} artifact(s) saved`))
    }) }, 'Send')
    if (current) {
      const { messages } = await api('GET', `/api/conversations/${current}`)
      messages.forEach((m) => log.append(h('div', { class: `msg ${m.role}` }, m.content)))
    }
    el.append(h('h1', {}, 'Chat'), list, log, h('div', { class: 'row' }, input, send))
  },
  async projects(el) {
    const { projects } = await api('GET', '/api/projects')
    const name = h('input', { placeholder: 'Project name' })
    const ins = h('textarea', { placeholder: 'Custom instructions' })
    el.append(h('h1', {}, 'Projects'), h('div', { class: 'row' }, name, ins, h('button', { onclick: act(async () => { await api('POST', '/api/projects', { name: name.value, instructions: ins.value }); route() }) }, 'Create')),
      ...projects.map((p) => h('div', { class: 'card' }, h('b', {}, p.name), h('p', { class: 'muted' }, p.instructions || 'No instructions'),
        h('button', { class: 'sec', onclick: act(async () => { const c = await api('POST', '/api/conversations', { projectId: p.id }); location.hash = `#chat/${c.id}` }) }, 'New chat'), ' ',
        h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/projects/${p.id}`); route() }) }, 'Delete'))))
  },
  async artifacts(el) {
    const { artifacts } = await api('GET', '/api/artifacts')
    el.append(h('h1', {}, 'Artifacts'), ...artifacts.map((a) => {
      const ta = h('textarea', {}); ta.value = a.content
      return h('div', { class: 'card' }, h('b', {}, a.title), ` · ${a.language} · v${a.versions.length + 1}`, ta,
        h('button', { onclick: act(async () => { await api('PUT', `/api/artifacts/${a.id}`, { content: ta.value }); route() }) }, 'Save version'))
    }), artifacts.length ? null : h('p', { class: 'muted' }, 'Code blocks from chat replies appear here.'))
  },
  async compute(el) {
    const { instances } = await api('GET', '/api/compute/instances')
    const name = h('input', { placeholder: 'Instance name' })
    const type = h('select', {}, ...['small', 'medium', 'large'].map((t) => h('option', {}, t)))
    const op = (i, a) => h('button', { class: 'sec', onclick: act(async () => { await api('POST', `/api/compute/instances/${i.id}/${a}`); route() }) }, a)
    el.append(h('h1', {}, 'Compute'), h('div', { class: 'row' }, name, type, h('button', { onclick: act(async () => { await api('POST', '/api/compute/instances', { name: name.value, type: type.value }); route() }) }, 'Launch')),
      h('table', {}, h('tr', {}, ...['Name', 'Type', 'State', 'IP', 'Hours', ''].map((x) => h('th', {}, x))),
        ...instances.map((i) => h('tr', {}, h('td', {}, i.name), h('td', {}, `${i.type} (${i.vcpu} vCPU, ${i.memGb} GB)`), h('td', {}, i.state), h('td', {}, i.ip), h('td', {}, String(i.hoursRunning)),
          h('td', {}, i.state === 'running' ? op(i, 'stop') : op(i, 'start'), ' ', op(i, 'terminate'))))))
  },
  async storage(el, bucketName) {
    if (bucketName) {
      const { objects } = await api('GET', `/api/buckets/${bucketName}/objects`)
      const file = h('input', { type: 'file' })
      el.append(h('h1', {}, bucketName), h('a', { href: '#storage' }, '← Buckets'),
        h('div', { class: 'row' }, file, h('button', { onclick: act(async () => { const f = file.files[0]; if (!f) return; await api('PUT', `/api/buckets/${bucketName}/objects/${f.name}`, f, { raw: true }); route() }) }, 'Upload')),
        h('table', {}, ...objects.map((o) => h('tr', {}, h('td', {}, o.key), h('td', {}, `${o.size} B`),
          h('td', {}, h('button', { class: 'sec', onclick: act(async () => download(await api('GET', `/api/buckets/${bucketName}/objects/${o.key}`), o.key.split('/').pop())) }, 'Download'), ' ',
            h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/buckets/${bucketName}/objects/${o.key}`); route() }) }, 'Delete'))))))
      return
    }
    const { buckets } = await api('GET', '/api/buckets')
    const name = h('input', { placeholder: 'bucket-name' })
    el.append(h('h1', {}, 'Storage'), h('div', { class: 'row' }, name, h('button', { onclick: act(async () => { await api('POST', '/api/buckets', { name: name.value }); route() }) }, 'Create bucket')),
      ...buckets.map((b) => h('div', { class: 'card' }, h('a', { href: `#storage/${b.name}` }, b.name), ` · ${b.objectCount} objects · ${b.sizeBytes} B `,
        h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/buckets/${b.name}`); route() }) }, 'Delete'))))
  },
  async database(el, coll = 'notes') {
    const { documents } = await api('GET', `/api/db/${coll}`)
    const c = h('input', { value: coll }); const json = h('textarea', { placeholder: '{"title":"hello"}' })
    el.append(h('h1', {}, 'Database'), h('div', { class: 'row' }, c, h('button', { class: 'sec', onclick: () => (location.hash = `#database/${c.value}`) }, 'Open collection')),
      json, h('button', { onclick: act(async () => { await api('POST', `/api/db/${coll}`, JSON.parse(json.value || '{}')); route() }) }, 'Insert document'),
      ...documents.map((d) => h('div', { class: 'card' }, h('pre', {}, JSON.stringify(d.data, null, 2)), h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/db/${coll}/${d.id}`); route() }) }, 'Delete'))))
  },
  async drive(el) {
    const { files } = await api('GET', '/api/drive/files')
    const file = h('input', { type: 'file' })
    el.append(h('h1', {}, 'Drive'), h('div', { class: 'row' }, file, h('button', { onclick: act(async () => { const f = file.files[0]; if (!f) return; await api('PUT', `/api/drive/files?name=${encodeURIComponent(f.name)}`, f, { raw: true }); route() }) }, 'Upload')),
      h('table', {}, ...files.map((f) => h('tr', {}, h('td', {}, f.name), h('td', {}, `v${f.versionCount} · ${f.size} B`),
        h('td', {}, h('button', { class: 'sec', onclick: act(async () => download(await api('GET', `/api/drive/files/${f.id}`), f.name)) }, 'Download'), ' ',
          h('button', { class: 'sec', onclick: act(async () => { const s = await api('POST', `/api/drive/files/${f.id}/share`); await promptDialog('Share link', location.origin + s.url, { readonly: true }) }) }, 'Share'), ' ',
          h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/drive/files/${f.id}`); route() }) }, 'Delete'))))))
  },
  async keys(el) {
    const { keys } = await api('GET', '/api/keys')
    const name = h('input', { placeholder: 'Key name' })
    el.append(h('h1', {}, 'API keys'), h('p', { class: 'muted' }, 'Use as: Authorization: Bearer rdk_…'),
      h('div', { class: 'row' }, name, h('button', { onclick: act(async () => { const r = await api('POST', '/api/keys', { name: name.value }); await promptDialog('Copy your key now — it will not be shown again', r.secret, { readonly: true }); route() }) }, 'Create key')),
      h('table', {}, ...keys.filter((k) => !k.revoked).map((k) => h('tr', {}, h('td', {}, k.name), h('td', {}, `${k.prefix}…`), h('td', {}, h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/keys/${k.id}`); route() }) }, 'Revoke'))))))
  },
  async usage(el) {
    const u = await api('GET', '/api/billing/usage')
    el.append(h('h1', {}, 'Usage & billing'), h('p', {}, `Estimated total: $${u.total.toFixed(4)}`),
      h('table', {}, h('tr', {}, ...['Service', 'Quantity', 'Rate', 'Cost'].map((x) => h('th', {}, x))),
        ...u.lines.map((l) => h('tr', {}, h('td', {}, l.kind), h('td', {}, l.qty.toFixed(4)), h('td', {}, `$${l.price} ${l.unit}`), h('td', {}, `$${l.cost.toFixed(4)}`)))))
  },
}

const BUILTIN = [
  ['chat', 'Chat', 'AI', 10], ['projects', 'Projects', 'AI', 20], ['artifacts', 'Artifacts', 'AI', 30],
  ['compute', 'Compute', 'Cloud', 10], ['storage', 'Storage', 'Cloud', 20], ['database', 'Database', 'Cloud', 30], ['drive', 'Drive', 'Cloud', 40],
  ['keys', 'API keys', 'Account', 10], ['usage', 'Usage & billing', 'Account', 20],
]
const registry = new Map(BUILTIN.map(([id, title, group, order]) => [id, { id, title, group, order, render: builtinRenderers[id] }]))
const GROUP_ORDER = ['AI', 'Cloud', 'Account']

// UI plugin modules: public/ui/*.js, each `export default {id,title,group,order,render(el,arg,lib)}` (or an array of those).
async function loadUiModules() {
  let names = []
  try {
    const r = await api('GET', '/api/ui-modules')
    names = r.modules
    for (const css of r.styles ?? []) document.head.append(h('link', { rel: 'stylesheet', href: '/ui/' + css }))
  } catch {}
  for (const n of names) {
    try {
      const m = await import('/ui/' + n)
      for (const v of [m.default].flat().filter(Boolean)) registry.set(v.id, { order: 100, group: 'Cloud', ...v })
    } catch (e) { console.error('UI module failed:', n, e) }
  }
}

function buildNav() {
  const nav = $('#nav'); nav.replaceChildren(h('h2', {}, 'RD Cloude'))
  const groups = [...new Set([...GROUP_ORDER, ...[...registry.values()].map((v) => v.group)])]
  for (const g of groups) {
    const items = [...registry.values()].filter((v) => v.group === g && !v.hidden).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
    if (!items.length) continue
    if (g !== 'AI') nav.append(h('small', {}, g))
    items.forEach((v) => nav.append(h('a', { href: `#${v.id}` }, v.title)))
  }
  nav.append(h('button', { id: 'logout', class: 'link', onclick: () => api('POST', '/api/auth/logout').finally(logout) }, 'Sign out'))
}

async function route() {
  const [name, ...rest] = (location.hash.slice(1) || 'chat').split('/')
  const arg = rest.join('/') || undefined
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.hash === `#${name}`))
  const el = $('#view'); el.replaceChildren()
  const view = registry.get(name) ?? registry.get('chat')
  try { await view.render(el, arg, lib) } catch (e) { el.append(h('p', { class: 'err' }, e.message)) }
}
window.addEventListener('rd:rerender', route)

async function boot() {
  $('#auth').hidden = !!state.token; $('#app').hidden = !state.token
  if (state.token) { await loadUiModules(); buildNav(); route() }
}
$('#toggleMode').onclick = () => { mode = mode === 'login' ? 'register' : 'login'; $('#authForm button[type=submit]').textContent = mode === 'login' ? 'Sign in' : 'Create account'; $('#toggleMode').textContent = mode === 'login' ? 'Create an account' : 'Have an account? Sign in' }
$('#authForm').onsubmit = async (e) => {
  e.preventDefault(); const f = new FormData(e.target)
  try { const r = await api('POST', `/api/auth/${mode}`, { email: f.get('email'), password: f.get('password') }); state.token = r.token; localStorage.setItem('rd_token', r.token); boot() }
  catch (err) { $('#authErr').textContent = err.message }
}
addEventListener('hashchange', route)
boot()
