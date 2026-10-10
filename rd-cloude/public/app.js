const $ = (s) => document.querySelector(s)
let token = localStorage.getItem('rd_token')
let mode = 'login'

// All dynamic text goes through h()/text nodes - never innerHTML with user data.
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) k.startsWith('on') ? el.addEventListener(k.slice(2), v) : el.setAttribute(k, v)
  el.append(...kids.flat().filter((x) => x != null))
  return el
}

async function api(method, path, body, opts = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body && !opts.raw ? { 'content-type': 'application/json' } : {}) },
    body: opts.raw ? body : body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401 && token) return logout()
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.blob()
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}
const act = (fn) => async (e) => { try { await fn(e) } catch (err) { alert(err.message) } }
function download(blob, name) { const a = h('a', { href: URL.createObjectURL(blob), download: name }); a.click() }

function logout() { localStorage.removeItem('rd_token'); token = null; boot() }

// ---------- views ----------
const views = {
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
          h('button', { class: 'sec', onclick: act(async () => { const s = await api('POST', `/api/drive/files/${f.id}/share`); prompt('Share link', location.origin + s.url) }) }, 'Share'), ' ',
          h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/drive/files/${f.id}`); route() }) }, 'Delete'))))))
  },
  async keys(el) {
    const { keys } = await api('GET', '/api/keys')
    const name = h('input', { placeholder: 'Key name' })
    el.append(h('h1', {}, 'API keys'), h('p', { class: 'muted' }, 'Use as: Authorization: Bearer rdk_…'),
      h('div', { class: 'row' }, name, h('button', { onclick: act(async () => { const r = await api('POST', '/api/keys', { name: name.value }); prompt('Copy your key now — it will not be shown again', r.secret); route() }) }, 'Create key')),
      h('table', {}, ...keys.filter((k) => !k.revoked).map((k) => h('tr', {}, h('td', {}, k.name), h('td', {}, `${k.prefix}…`), h('td', {}, h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/keys/${k.id}`); route() }) }, 'Revoke'))))))
  },
  async usage(el) {
    const u = await api('GET', '/api/billing/usage')
    el.append(h('h1', {}, 'Usage & billing'), h('p', {}, `Estimated total: $${u.total.toFixed(4)}`),
      h('table', {}, h('tr', {}, ...['Service', 'Quantity', 'Rate', 'Cost'].map((x) => h('th', {}, x))),
        ...u.lines.map((l) => h('tr', {}, h('td', {}, l.kind), h('td', {}, l.qty.toFixed(4)), h('td', {}, `$${l.price} ${l.unit}`), h('td', {}, `$${l.cost.toFixed(4)}`)))))
  },
}

async function route() {
  const [name, arg] = (location.hash.slice(1) || 'chat').split('/')
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('on', a.hash === `#${name}`))
  const el = $('#view'); el.replaceChildren()
  try { await (views[name] ?? views.chat)(el, arg) } catch (e) { el.append(h('p', { class: 'err' }, e.message)) }
}

async function boot() {
  $('#auth').hidden = !!token; $('#app').hidden = !token
  if (token) route()
}
$('#toggleMode').onclick = () => { mode = mode === 'login' ? 'register' : 'login'; $('#authForm button[type=submit]').textContent = mode === 'login' ? 'Sign in' : 'Create account'; $('#toggleMode').textContent = mode === 'login' ? 'Create an account' : 'Have an account? Sign in' }
$('#authForm').onsubmit = async (e) => {
  e.preventDefault(); const f = new FormData(e.target)
  try { const r = await api('POST', `/api/auth/${mode}`, { email: f.get('email'), password: f.get('password') }); token = r.token; localStorage.setItem('rd_token', token); boot() }
  catch (err) { $('#authErr').textContent = err.message }
}
$('#logout').onclick = () => api('POST', '/api/auth/logout').finally(logout)
addEventListener('hashchange', route)
boot()
