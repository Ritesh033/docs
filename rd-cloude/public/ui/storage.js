// Object storage console: buckets, file browser, uploads with progress, versions, presigned links, bucket settings.
// Backend: src/modules/storage.js (docs/storage.md). Replaces the built-in "storage" view.
// DOM is built with h() only: no innerHTML, no inline styles or scripts (CSP). Every class is prefixed st-.

const MiB = 1024 * 1024
const MULTIPART_AT = 32 * MiB // bigger files are sent in parts (resumable per part, no single 5-minute request)
const PART_BYTES = 16 * MiB
const PAGE = 100
const MAX_PARALLEL_FILES = 3
const MAX_DROPPED_FILES = 2000
const SETTINGS = [['general', 'General'], ['access', 'Public access'], ['lifecycle', 'Lifecycle'], ['cors', 'CORS'], ['website', 'Website']]
const CORS_METHODS = ['GET', 'PUT', 'POST', 'DELETE', 'HEAD']
const EXPIRY = [[300, '5 minutes'], [3600, '1 hour'], [86_400, '1 day'], [604_800, '7 days']]

const enc = (key) => key.split('/').map(encodeURIComponent).join('/')
const safeDecode = (s) => { try { return decodeURIComponent(s) } catch { return s } }
const baseName = (key) => key.replace(/\/$/, '').split('/').pop()
const shortId = (v) => (v && v.length > 14 ? `${v.slice(0, 6)}...${v.slice(-6)}` : v)

/** #storage/<bucket>/<folder>/...?tab=settings&s=cors  ->  { bucket, prefix, tab, section } */
function parseArg(arg = '') {
  const [path, qs = ''] = arg.split('?')
  const segs = path.split('/')
  const bucket = safeDecode(segs.shift() ?? '')
  let prefix = segs.map(safeDecode).join('/')
  if (prefix && !prefix.endsWith('/')) prefix += '/'
  const q = new URLSearchParams(qs)
  const tab = q.get('tab') === 'settings' ? 'settings' : 'objects'
  const section = SETTINGS.some(([id]) => id === q.get('s')) ? q.get('s') : 'general'
  return { bucket, prefix, tab, section }
}
const hashFor = (bucket, prefix = '') => `#storage/${encodeURIComponent(bucket)}${prefix ? `/${prefix.split('/').map(encodeURIComponent).join('/')}` : ''}`
const settingsHash = (bucket, section = 'general') => `#storage/${encodeURIComponent(bucket)}?tab=settings&s=${section}`

/* ============================================================================================ upload manager (module level: survives navigation) */

const uploads = { jobs: [], subs: new Set(), seq: 0, running: 0, info: null }
const notifyUploads = (event = 'progress', detail = null) => { for (const fn of [...uploads.subs]) fn(event, detail) }

function xhrSend(method, url, { body, headers = {}, token, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(method, url)
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`)
    for (const [k, v] of Object.entries(headers)) if (v) xhr.setRequestHeader(k, v)
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded)
    xhr.onerror = () => reject(new Error('Network error'))
    xhr.onabort = () => reject(Object.assign(new Error('Cancelled'), { cancelled: true }))
    xhr.onload = () => {
      let data = null
      try { data = JSON.parse(xhr.responseText) } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve({ status: xhr.status, data })
      else reject(Object.assign(new Error(data?.error || `HTTP ${xhr.status}`), { status: xhr.status }))
    }
    if (signal) {
      if (signal.aborted) return reject(Object.assign(new Error('Cancelled'), { cancelled: true }))
      signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }
    xhr.send(body)
  })
}

async function runJob(job, lib) {
  const token = lib.state.token
  const base = `/api/buckets/${encodeURIComponent(job.bucket)}`
  const ctl = new AbortController()
  job.cancel = () => ctl.abort()
  job.status = 'uploading'
  notifyUploads()
  try {
    if (job.size <= MULTIPART_AT) {
      await xhrSend('PUT', `${base}/objects/${enc(job.key)}`, {
        body: job.file, token, signal: ctl.signal, headers: { 'content-type': job.file.type || '' },
        onProgress: (n) => { job.loaded = n; notifyUploads() },
      })
    } else {
      const limits = uploads.info?.limits ?? {}
      const partBytes = Math.max(PART_BYTES, limits.minPartBytes ?? 0, Math.ceil(job.size / (limits.maxParts ?? 1000)))
      const init = await lib.api('POST', `${base}/uploads`, { key: job.key, contentType: job.file.type || undefined })
      job.uploadId = init.uploadId
      const count = Math.ceil(job.size / partBytes)
      const done = new Array(count).fill(0)
      const parts = new Array(count)
      let next = 0
      const sum = () => done.reduce((s, n) => s + n, 0)
      const worker = async () => {
        while (next < count && !ctl.signal.aborted) {
          const i = next++
          const blob = job.file.slice(i * partBytes, Math.min(job.size, (i + 1) * partBytes))
          for (let attempt = 1; ; attempt++) {
            try {
              const r = await xhrSend('PUT', `${base}/uploads/${init.uploadId}/parts/${i + 1}`, {
                body: blob, token, signal: ctl.signal, onProgress: (n) => { done[i] = n; job.loaded = sum(); notifyUploads() },
              })
              parts[i] = { partNumber: i + 1, etag: r.data.etag }
              done[i] = blob.size
              break
            } catch (e) {
              if (e.cancelled || attempt >= 3 || (e.status && e.status < 500 && e.status !== 408)) throw e
              done[i] = 0
              await new Promise((r) => setTimeout(r, 800 * attempt))
            }
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, count) }, worker))
      if (ctl.signal.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true })
      await lib.api('POST', `${base}/uploads/${init.uploadId}/complete`, { parts })
    }
    job.loaded = job.size
    job.status = 'done'
  } catch (e) {
    if (job.uploadId) lib.api('DELETE', `${base}/uploads/${job.uploadId}`).catch(() => {})
    job.status = e.cancelled ? 'cancelled' : 'error'
    job.error = e.cancelled ? 'Cancelled' : e.message
  }
  job.cancel = null
}

function pumpUploads(lib) {
  while (uploads.running < MAX_PARALLEL_FILES) {
    const job = uploads.jobs.find((j) => j.status === 'queued')
    if (!job) break
    uploads.running++
    runJob(job, lib).finally(() => {
      uploads.running--
      notifyUploads('finished', job)
      pumpUploads(lib)
    })
  }
}

async function enqueueUploads(lib, bucket, entries) {
  if (!uploads.info) { try { uploads.info = await lib.api('GET', '/api/storage/info') } catch { uploads.info = {} } }
  for (const { file, key } of entries) {
    uploads.jobs.push({ id: ++uploads.seq, bucket, key, file, size: file.size, loaded: 0, status: 'queued', error: null, cancel: null, uploadId: null })
  }
  if (uploads.jobs.length > 200) uploads.jobs = uploads.jobs.filter((j) => j.status === 'queued' || j.status === 'uploading').concat(uploads.jobs.slice(-50))
  notifyUploads()
  pumpUploads(lib)
}

/** Files from a drop, including whole folders (webkitGetAsEntry). Returns [{ file, rel }]. */
async function filesFromDrop(dt) {
  const out = []
  const items = [...(dt.items ?? [])].filter((i) => i.kind === 'file')
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean)
  if (!entries.length) return [...(dt.files ?? [])].map((file) => ({ file, rel: file.name }))
  const readAll = (reader) => new Promise((resolve, reject) => {
    const all = []
    const step = () => reader.readEntries((batch) => { if (!batch.length) resolve(all); else { all.push(...batch); step() } }, reject)
    step()
  })
  const walk = async (entry, path) => {
    if (out.length >= MAX_DROPPED_FILES) return
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject))
      out.push({ file, rel: `${path}${entry.name}` })
    } else if (entry.isDirectory) {
      for (const child of await readAll(entry.createReader())) await walk(child, `${path}${entry.name}/`)
    }
  }
  for (const e of entries) await walk(e, '')
  return out
}

/* ============================================================================================ small kit */

function kit(lib) {
  const { h } = lib
  const uid = () => `st-${Math.random().toString(36).slice(2, 9)}`
  const SVG = 'http://www.w3.org/2000/svg'
  const ICONS = {
    folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z',
    file: 'M7 3.5h7l4 4V20H7z M14 3.5v4h4',
    bucket: 'M4 7h16l-1.5 12.5a1 1 0 0 1-1 .9H6.5a1 1 0 0 1-1-.9z M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3',
    upload: 'M12 16V5 M7.5 9.5 12 5l4.5 4.5 M5 19h14',
  }
  const icon = (name) => {
    const s = document.createElementNS(SVG, 'svg')
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: `st-icon st-icon-${name}` })) s.setAttribute(k, v)
    const p = document.createElementNS(SVG, 'path')
    p.setAttribute('d', ICONS[name])
    s.append(p)
    return s
  }
  const card = (title, ...kids) => h('section', { class: 'st-card' }, title ? h('h2', { class: 'st-h' }, title) : null, ...kids)
  const field = (label, input, hint) => {
    input.id = input.id || uid()
    return h('div', { class: 'st-field' }, h('label', { for: input.id }, label), input, hint ? h('small', { class: 'st-hint' }, hint) : null)
  }
  const msg = () => h('p', { class: 'st-msg', role: 'status', 'aria-live': 'polite' })
  const say = (m, text, kind = 'info') => { m.textContent = text ?? ''; m.className = `st-msg st-${kind}` }
  const badge = (text, kind = 'muted') => h('span', { class: `st-badge st-${kind}` }, text)
  const run = (m, fn) => async (e) => {
    e?.preventDefault?.()
    if (m) say(m, '')
    try { await fn(e) } catch (err) { if (m) say(m, err.message, 'bad'); else lib.toast(err.message, 'error') }
  }
  const copy = async (text, label = 'Copied') => {
    try { await navigator.clipboard.writeText(text); lib.toast(label) } catch { lib.toast('Copy failed: select the text and copy it manually', 'error') }
  }
  const table = (head, rows, cls = '') => {
    for (const tr of rows) [...tr.children].forEach((td, i) => td.setAttribute('data-label', head[i] ?? ''))
    return h('div', { class: 'st-scroll' }, h('table', { class: `st-table ${cls}` },
      h('thead', {}, h('tr', {}, ...head.map((x) => h('th', { scope: 'col' }, x)))), h('tbody', {}, ...rows)))
  }
  /** Modal dialog. build(body, close) fills it; resolves with whatever close(value) is called with (null on Escape / backdrop click). */
  const modal = (title, build, opts = {}) => new Promise((resolve) => {
    const titleId = uid()
    const body = h('div', { class: 'st-dlg-body' })
    const dlg = h('dialog', { class: `st-dialog${opts.drawer ? ' st-drawer' : ''}${opts.wide ? ' st-wide' : ''}`, 'aria-labelledby': titleId })
    const close = (v = null) => { try { dlg.close() } catch { /* already closed */ } dlg.remove(); resolve(v) }
    dlg.append(h('div', { class: 'st-dlg-head' }, h('h2', { id: titleId, class: 'st-h' }, title), h('button', { class: 'sec st-x', type: 'button', 'aria-label': 'Close', onclick: () => close(null) }, 'Close')), body)
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null) })
    dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) close(null) })
    build(body, close)
    document.body.append(dlg)
    dlg.showModal()
  })
  const confirm = (title, text, okLabel, danger = true) => modal(title, (body, close) => {
    body.append(h('p', {}, text), h('div', { class: 'st-actions' },
      h('button', { class: 'sec', type: 'button', onclick: () => close(false) }, 'Cancel'),
      h('button', { class: danger ? 'st-danger' : '', type: 'button', onclick: () => close(true) }, okLabel)))
  }).then(Boolean)
  const urlBox = (text) => {
    const input = h('input', { readonly: true, value: text, 'aria-label': 'URL', class: 'st-url' })
    return h('div', { class: 'st-copy' }, input, h('button', { class: 'sec', type: 'button', onclick: () => { input.select(); copy(text, 'Link copied') } }, 'Copy'))
  }
  return { h, icon, card, field, msg, say, badge, run, copy, table, modal, confirm, urlBox, uid }
}

const when = (d) => (d ? new Date(d).toLocaleString() : '')
const bytes = (lib, n) => lib.fmtBytes(n ?? 0)

/* ============================================================================================ entry point */

export default {
  id: 'storage',
  title: 'Storage',
  group: 'Cloud',
  order: 20,
  async render(el, arg, lib) {
    const k = kit(lib)
    const route = parseArg(arg)
    const root = k.h('div', { class: 'st-root' })
    el.append(root)
    if (!route.bucket) return bucketList(root, lib, k)
    return bucketPage(root, lib, k, route)
  },
}

/* ============================================================================================ bucket list */

async function bucketList(root, lib, k) {
  const { h } = k
  const [{ buckets }, usage, info] = await Promise.all([lib.api('GET', '/api/buckets'), lib.api('GET', '/api/storage/usage'), lib.api('GET', '/api/storage/info')])
  uploads.info = info
  const pct = usage.quotaBytes ? Math.min(100, (usage.usedBytes / usage.quotaBytes) * 100) : 0
  const meter = h('div', { class: 'st-meter', role: 'progressbar', 'aria-label': 'Storage used', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)) },
    h('div', { class: `st-meter-bar${pct > 90 ? ' st-hot' : ''}`, style: { width: `${pct}%` } }))

  const name = h('input', { name: 'name', required: true, maxlength: 63, pattern: '[a-z0-9][a-z0-9\\-]{2,62}', autocomplete: 'off', placeholder: 'my-bucket' })
  const region = h('select', { name: 'region' }, ...info.regions.map((r) => h('option', { value: r }, r)))
  const versioning = h('input', { type: 'checkbox', name: 'versioning' })
  const m = k.msg()
  const create = h('form', { class: 'st-form st-create', onsubmit: k.run(m, async () => {
    const b = await lib.api('POST', '/api/buckets', { name: name.value.trim(), region: region.value, versioning: versioning.checked ? 'enabled' : 'disabled' })
    location.hash = hashFor(b.name)
  }) },
  k.field('Bucket name', name, '3-63 characters: lowercase letters, digits and hyphens. Names are unique across the platform.'),
  k.field('Region', region, info.regions.length === 1 ? 'A label only: this deployment stores everything in one place.' : undefined),
  h('label', { class: 'st-check' }, versioning, 'Keep every version of each object (versioning)'),
  h('div', { class: 'st-actions' }, h('button', { type: 'submit' }, 'Create bucket')), m)

  const rows = buckets.map((b) => h('tr', {},
    h('td', {}, h('a', { class: 'st-name', href: hashFor(b.name) }, k.icon('bucket'), b.name)),
    h('td', {}, b.region),
    h('td', {}, k.badge(b.versioning === 'enabled' ? 'Versioned' : b.versioning === 'suspended' ? 'Suspended' : 'Off', b.versioning === 'enabled' ? 'ok' : 'muted')),
    h('td', {}, b.acl === 'public-read' ? k.badge('Public read', 'warn') : k.badge('Private', 'muted')),
    h('td', {}, String(b.objectCount)),
    h('td', {}, bytes(lib, b.sizeBytes)),
    h('td', {}, when(b.createdAt)),
    h('td', { class: 'st-row-actions' },
      h('a', { class: 'st-btnlink', href: hashFor(b.name) }, 'Open'),
      h('a', { class: 'st-btnlink', href: settingsHash(b.name) }, 'Settings'),
      h('button', { class: 'sec', type: 'button', onclick: lib.act(async () => { if (await deleteBucket(lib, k, b)) lib.rerender() }) }, 'Delete'))))

  root.append(
    h('div', { class: 'st-title' }, h('h1', {}, 'Storage'), h('p', { class: 'st-muted' }, 'S3-style object storage with versions, lifecycle rules, presigned links and static websites.')),
    k.card('Usage', h('p', { class: 'st-muted' }, `${bytes(lib, usage.usedBytes)} of ${bytes(lib, usage.quotaBytes)} used`
      + (usage.inFlightMultipartBytes ? ` (${bytes(lib, usage.inFlightMultipartBytes)} in unfinished multipart uploads)` : '')), meter),
    k.card('Create a bucket', create),
    k.card('Your buckets', buckets.length ? k.table(['Name', 'Region', 'Versioning', 'Access', 'Objects', 'Size', 'Created', ''], rows, 'st-buckets') : h('p', { class: 'st-muted' }, 'No buckets yet. Create one above.')),
  )
}

async function deleteBucket(lib, k, b) {
  const empty = b.versionCount === 0
  const ok = await k.confirm(`Delete ${b.name}?`, empty ? 'The bucket is empty and will be removed.' : `This permanently deletes ${b.objectCount} object(s)${b.versionCount > b.objectCount ? ` and their ${b.versionCount - b.objectCount} other version(s)` : ''} (${bytes(lib, b.sizeBytes)}), including unfinished uploads. This cannot be undone.`, empty ? 'Delete bucket' : 'Delete everything')
  if (!ok) return false
  await lib.api('DELETE', `/api/buckets/${encodeURIComponent(b.name)}${empty ? '' : '?force=true'}`)
  lib.toast(`Deleted ${b.name}`)
  return true
}

/* ============================================================================================ bucket page */

async function bucketPage(root, lib, k, route) {
  const { h } = k
  let bucket
  try { bucket = await lib.api('GET', `/api/buckets/${encodeURIComponent(route.bucket)}`) } catch (e) {
    root.append(h('p', { class: 'err' }, e.message), h('a', { href: '#storage' }, 'Back to buckets'))
    return
  }
  uploads.info ??= await lib.api('GET', '/api/storage/info').catch(() => ({}))
  const tabs = h('nav', { class: 'st-tabs', 'aria-label': 'Bucket sections' },
    h('a', { class: `st-tab${route.tab === 'objects' ? ' on' : ''}`, href: hashFor(bucket.name), ...(route.tab === 'objects' ? { 'aria-current': 'page' } : {}) }, 'Objects'),
    h('a', { class: `st-tab${route.tab === 'settings' ? ' on' : ''}`, href: settingsHash(bucket.name), ...(route.tab === 'settings' ? { 'aria-current': 'page' } : {}) }, 'Settings'))
  root.append(
    h('p', { class: 'st-crumbs' }, h('a', { href: '#storage' }, 'Storage'), ' / ', h('strong', {}, bucket.name)),
    h('div', { class: 'st-title' },
      h('h1', { class: 'st-h1' }, k.icon('bucket'), bucket.name),
      h('div', { class: 'st-badges' },
        k.badge(bucket.region), k.badge(bucket.versioning === 'enabled' ? 'Versioning on' : bucket.versioning === 'suspended' ? 'Versioning suspended' : 'Versioning off', bucket.versioning === 'enabled' ? 'ok' : 'muted'),
        bucket.acl === 'public-read' ? k.badge('Public read', 'warn') : k.badge('Private'), bucket.website ? k.badge('Website', 'ok') : null,
        k.badge(`${bucket.objectCount} object${bucket.objectCount === 1 ? '' : 's'}, ${bytes(lib, bucket.sizeBytes)}`))),
    tabs)
  if (route.tab === 'settings') return settingsPage(root, lib, k, bucket, route.section)
  return browser(root, lib, k, bucket, route.prefix)
}

/* ============================================================================================ file browser */

async function browser(root, lib, k, bucket, prefix) {
  const { h } = k
  const B = encodeURIComponent(bucket.name)
  const state = { folders: [], objects: [], token: null, loading: false, selected: new Map(), filter: '', sort: 'name', dir: 1 }
  const status = k.msg()

  // ---- toolbar
  const fileInput = h('input', { type: 'file', multiple: true, class: 'st-hidden', 'aria-label': 'Choose files to upload', tabindex: '-1' })
  const dirInput = h('input', { type: 'file', multiple: true, webkitdirectory: true, class: 'st-hidden', 'aria-label': 'Choose a folder to upload', tabindex: '-1' })
  const upload = (list) => {
    const entries = list.map(({ file, rel }) => ({ file, key: prefix + rel }))
    if (entries.length) enqueueUploads(lib, bucket.name, entries)
  }
  fileInput.addEventListener('change', () => { upload([...fileInput.files].map((file) => ({ file, rel: file.name }))); fileInput.value = '' })
  dirInput.addEventListener('change', () => { upload([...dirInput.files].map((file) => ({ file, rel: file.webkitRelativePath || file.name }))); dirInput.value = '' })
  const filter = h('input', { type: 'search', placeholder: 'Filter this folder', 'aria-label': 'Filter by name', class: 'st-filter', oninput: () => { state.filter = filter.value.toLowerCase(); paint() } })
  const bar = h('div', { class: 'st-toolbar' },
    h('button', { type: 'button', onclick: () => fileInput.click() }, k.icon('upload'), 'Upload files'),
    h('button', { class: 'sec', type: 'button', onclick: () => dirInput.click() }, 'Upload folder'),
    h('button', { class: 'sec', type: 'button', onclick: lib.act(newFolder) }, 'New folder'),
    h('button', { class: 'sec', type: 'button', onclick: () => load(true) }, 'Refresh'),
    filter, fileInput, dirInput)

  const actions = h('div', { class: 'st-selbar', role: 'toolbar', 'aria-label': 'Actions for selected items', hidden: true })
  const crumbs = h('nav', { class: 'st-path', 'aria-label': 'Folder path' })
  const list = h('div', { class: 'st-list' })
  const more = h('div', { class: 'st-more' })
  const drop = h('div', { class: 'st-drop', hidden: true, 'aria-hidden': 'true' }, k.icon('upload'), h('span', {}, `Drop files or folders to upload to ${prefix || '/'}`))
  const panel = h('div', { class: 'st-uploads', 'aria-label': 'Uploads' })
  const area = h('div', { class: 'st-area' }, list, more, drop)
  root.append(bar, crumbs, actions, status, area, panel)

  const paintCrumbs = () => {
    const parts = prefix.split('/').filter(Boolean)
    const links = [h('a', { href: hashFor(bucket.name) }, bucket.name)]
    parts.forEach((p, i) => links.push(' / ', i === parts.length - 1 ? h('strong', { 'aria-current': 'page' }, p) : h('a', { href: hashFor(bucket.name, `${parts.slice(0, i + 1).join('/')}/`) }, p)))
    crumbs.replaceChildren(...links)
  }

  // ---- drag and drop
  let depth = 0
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files')
  area.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; drop.hidden = false })
  area.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } })
  area.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) drop.hidden = true })
  area.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth = 0
    drop.hidden = true
    try { upload(await filesFromDrop(e.dataTransfer)) } catch (err) { lib.toast(`Could not read the dropped items: ${err.message}`, 'error') }
  })

  // ---- loading
  async function load(reset) {
    if (state.loading) return
    state.loading = true
    if (reset) { state.folders = []; state.objects = []; state.token = null; state.selected.clear(); list.replaceChildren(h('p', { class: 'st-muted' }, 'Loading...')) }
    try {
      const qs = new URLSearchParams({ prefix, delimiter: '/', 'max-keys': String(PAGE) })
      if (state.token) qs.set('continuation-token', state.token)
      const page = await lib.api('GET', `/api/buckets/${B}/objects?${qs}`)
      state.folders.push(...page.commonPrefixes)
      state.objects.push(...page.objects.filter((o) => o.key !== prefix)) // the folder's own marker object is not a file
      state.token = page.nextContinuationToken
      k.say(status, '')
    } catch (e) { k.say(status, e.message, 'bad'); list.replaceChildren() } finally { state.loading = false }
    paint()
  }

  // ---- rendering
  const selKey = (type, key) => `${type}:${key}`
  const visibleFolders = () => state.folders.filter((p) => baseName(p).toLowerCase().includes(state.filter))
  const visibleObjects = () => {
    const rows = state.objects.filter((o) => baseName(o.key).toLowerCase().includes(state.filter))
    const by = { name: (o) => baseName(o.key).toLowerCase(), size: (o) => o.size, date: (o) => o.lastModified }[state.sort]
    return rows.sort((a, b) => (by(a) < by(b) ? -1 : by(a) > by(b) ? 1 : 0) * state.dir)
  }
  const sortHead = (id, label) => h('th', { scope: 'col', 'aria-sort': state.sort === id ? (state.dir === 1 ? 'ascending' : 'descending') : 'none' },
    h('button', { class: 'link st-sort', type: 'button', onclick: () => { state.dir = state.sort === id ? -state.dir : 1; state.sort = id; paint() } }, label))

  function paint() {
    paintCrumbs()
    const folders = visibleFolders()
    const objects = visibleObjects()
    const all = [...folders.map((p) => selKey('d', p)), ...objects.map((o) => selKey('f', o.key))]
    const allBox = h('input', { type: 'checkbox', 'aria-label': 'Select all', checked: all.length > 0 && all.every((id) => state.selected.has(id)), disabled: !all.length,
      onchange: () => { for (const id of all) { if (allBox.checked) state.selected.set(id, id); else state.selected.delete(id) } paint() } })
    const check = (id, label) => h('input', { type: 'checkbox', 'aria-label': `Select ${label}`, checked: state.selected.has(id),
      onchange: (e) => { if (e.target.checked) state.selected.set(id, id); else state.selected.delete(id); paintSelection(); e.target.closest('tr')?.classList.toggle('st-sel', e.target.checked) } })
    const rows = []
    if (prefix) {
      const parent = prefix.split('/').filter(Boolean).slice(0, -1)
      rows.push(h('tr', {}, h('td', {}), h('td', { colspan: 5 }, h('a', { class: 'st-name', href: hashFor(bucket.name, parent.length ? `${parent.join('/')}/` : '') }, k.icon('folder'), '..'))))
    }
    for (const p of folders) {
      rows.push(h('tr', { class: state.selected.has(selKey('d', p)) ? 'st-sel' : '' },
        h('td', { class: 'st-check-cell' }, check(selKey('d', p), baseName(p))),
        h('td', {}, h('a', { class: 'st-name', href: hashFor(bucket.name, p) }, k.icon('folder'), baseName(p))),
        h('td', {}, '-'), h('td', {}, 'Folder'), h('td', {}, '-'),
        h('td', { class: 'st-row-actions' }, h('a', { class: 'st-btnlink', href: hashFor(bucket.name, p) }, 'Open'))))
    }
    for (const o of objects) {
      const name = baseName(o.key)
      const isPublic = o.acl === 'public-read' || (bucket.acl === 'public-read' && o.acl !== 'private')
      rows.push(h('tr', { class: state.selected.has(selKey('f', o.key)) ? 'st-sel' : '' },
        h('td', { class: 'st-check-cell' }, check(selKey('f', o.key), name)),
        h('td', {}, h('button', { class: 'link st-name', type: 'button', title: o.key, onclick: () => details(o) }, k.icon('file'), name), isPublic ? [' ', k.badge('public', 'warn')] : null),
        h('td', {}, bytes(lib, o.size)), h('td', {}, o.contentType),
        h('td', {}, when(o.lastModified)),
        h('td', { class: 'st-row-actions' },
          h('button', { class: 'sec', type: 'button', onclick: lib.act(() => downloadVersion(o.key)) }, 'Download'),
          h('button', { class: 'sec', type: 'button', onclick: () => presignDialog(lib, k, bucket, o.key) }, 'Share'),
          h('button', { class: 'sec', type: 'button', onclick: () => details(o) }, 'Details'),
          h('button', { class: 'sec', type: 'button', onclick: lib.act(() => removeItems([{ type: 'f', key: o.key }])) }, 'Delete'))))
    }
    if (!rows.length || (prefix && rows.length === 1)) {
      list.replaceChildren(h('div', { class: 'st-empty' }, k.icon('folder'), h('p', {}, state.filter ? 'Nothing matches the filter.' : state.loading ? 'Loading...' : 'This folder is empty. Drop files here or use "Upload files".')))
    } else {
      list.replaceChildren(h('div', { class: 'st-scroll' }, h('table', { class: 'st-table st-files' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col', class: 'st-check-cell' }, allBox), sortHead('name', 'Name'), sortHead('size', 'Size'), h('th', { scope: 'col' }, 'Type'), sortHead('date', 'Modified'), h('th', { scope: 'col' }, h('span', { class: 'st-sr' }, 'Actions')))),
        h('tbody', {}, ...rows.map((tr) => { [...tr.children].forEach((td, i) => td.setAttribute('data-label', ['', 'Name', 'Size', 'Type', 'Modified', ''][i] ?? '')); return tr })))))
    }
    more.replaceChildren(state.token ? h('button', { class: 'sec', type: 'button', onclick: () => load(false) }, 'Load more') : h('span', { class: 'st-muted' }, `${folders.length + objects.length} item${folders.length + objects.length === 1 ? '' : 's'}`))
    paintSelection()
  }

  function paintSelection() {
    const sel = [...state.selected.keys()].map((id) => ({ type: id[0], key: id.slice(2) }))
    actions.hidden = !sel.length
    if (!sel.length) return actions.replaceChildren()
    const one = sel.length === 1 && sel[0].type === 'f' ? sel[0] : null
    const obj = one && state.objects.find((o) => o.key === one.key)
    actions.replaceChildren(
      h('strong', {}, `${sel.length} selected`),
      one ? h('button', { class: 'sec', type: 'button', onclick: lib.act(() => downloadVersion(one.key)) }, 'Download') : null,
      one ? h('button', { class: 'sec', type: 'button', onclick: () => presignDialog(lib, k, bucket, one.key) }, 'Share link') : null,
      obj ? h('button', { class: 'sec', type: 'button', onclick: () => details(obj) }, 'Details and versions') : null,
      h('button', { class: 'sec', type: 'button', onclick: lib.act(() => copyItems(sel)) }, 'Copy to...'),
      h('button', { class: 'st-danger', type: 'button', onclick: lib.act(() => removeItems(sel)) }, 'Delete'),
      h('button', { class: 'link', type: 'button', onclick: () => { state.selected.clear(); paint() } }, 'Clear selection'))
  }

  // ---- actions
  async function newFolder() {
    const name = await k.modal('New folder', (body, close) => {
      const input = h('input', { required: true, maxlength: 200, autocomplete: 'off', 'aria-label': 'Folder name' })
      const m = k.msg()
      body.append(h('form', { class: 'st-form', onsubmit: (e) => {
        e.preventDefault()
        const v = input.value.trim().replace(/^\/+|\/+$/g, '')
        if (!v || /[\\]|(^|\/)\.\.?(\/|$)|\/\//.test(v)) return k.say(m, 'Use a plain name; "..", empty segments and backslashes are not allowed', 'bad')
        close(v)
      } }, k.field('Folder name', input, `Created inside ${prefix || 'the bucket root'}`), m, h('div', { class: 'st-actions' }, h('button', { class: 'sec', type: 'button', onclick: () => close(null) }, 'Cancel'), h('button', { type: 'submit' }, 'Create'))))
      setTimeout(() => input.focus(), 0)
    })
    if (!name) return
    await lib.api('PUT', `/api/buckets/${B}/objects/${enc(`${prefix}${name}/`)}`, new Blob([]), { raw: true })
    await load(true)
  }

  async function downloadVersion(key, versionId) {
    const r = await lib.api('POST', `/api/buckets/${B}/presign`, { key, expiresIn: 300, disposition: 'attachment', ...(versionId ? { versionId } : {}) })
    const a = h('a', { href: r.path, download: baseName(key) })
    document.body.append(a)
    a.click()
    a.remove()
  }

  async function removeItems(items) {
    const folders = items.filter((i) => i.type === 'd')
    const files = items.filter((i) => i.type === 'f')
    const label = [files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : '', folders.length ? `${folders.length} folder${folders.length === 1 ? '' : 's'} with everything inside` : ''].filter(Boolean).join(' and ')
    const note = bucket.versioning === 'enabled' ? 'Versioning is on: deleting adds delete markers and older versions stay recoverable from the Details panel.' : 'This cannot be undone.'
    if (!(await k.confirm(`Delete ${label}?`, note, 'Delete'))) return
    let removed = 0
    for (let i = 0; i < files.length; i += 500) {
      const r = await lib.api('POST', `/api/buckets/${B}/delete`, { objects: files.slice(i, i + 500).map((f) => ({ key: f.key })) })
      removed += r.deleted.length
      if (r.errors.length) throw new Error(`${r.errors.length} item(s) could not be deleted: ${r.errors[0].error}`)
    }
    for (const f of folders) {
      for (;;) { // the server removes at most a few thousand keys per call
        const r = await lib.api('POST', `/api/buckets/${B}/delete`, { prefix: f.key })
        removed += r.deleted.length
        if (!r.truncated) break
      }
    }
    lib.toast(`Deleted ${removed} item${removed === 1 ? '' : 's'}`)
    await load(true)
  }

  async function copyItems(items) {
    const { buckets } = await lib.api('GET', '/api/buckets')
    const target = await k.modal('Copy to...', (body, close) => {
      const dest = h('select', { 'aria-label': 'Destination bucket' }, ...buckets.map((b) => h('option', { value: b.name, selected: b.name === bucket.name }, b.name)))
      const path = h('input', { value: prefix, maxlength: 900, autocomplete: 'off', placeholder: 'folder/ (empty = bucket root)' })
      const single = items.length === 1 && items[0].type === 'f'
      const name = h('input', { value: single ? baseName(items[0].key) : '', maxlength: 200, disabled: !single, 'aria-label': 'New name' })
      const m = k.msg()
      body.append(h('form', { class: 'st-form', onsubmit: (e) => {
        e.preventDefault()
        let p = path.value.trim().replace(/^\/+/, '')
        if (p && !p.endsWith('/')) p += '/'
        close({ bucket: dest.value, prefix: p, name: single ? name.value.trim() : null })
      } }, k.field('Destination bucket', dest), k.field('Destination folder', path, 'Copies keep their data, metadata and tags; access (ACL) resets to the bucket default.'),
      single ? k.field('Name', name) : null, m, h('div', { class: 'st-actions' }, h('button', { class: 'sec', type: 'button', onclick: () => close(null) }, 'Cancel'), h('button', { type: 'submit' }, 'Copy'))))
    })
    if (!target) return
    // expand folders into their keys
    const jobs = []
    for (const it of items) {
      if (it.type === 'f') jobs.push({ src: it.key, dst: `${target.prefix}${target.name || baseName(it.key)}` })
      else {
        let token = null
        do {
          const qs = new URLSearchParams({ prefix: it.key, 'max-keys': '1000' })
          if (token) qs.set('continuation-token', token)
          const page = await lib.api('GET', `/api/buckets/${B}/objects?${qs}`)
          for (const o of page.objects) jobs.push({ src: o.key, dst: `${target.prefix}${baseName(it.key)}/${o.key.slice(it.key.length)}` })
          token = page.nextContinuationToken
        } while (token && jobs.length < 5000)
      }
    }
    if (jobs.length > 1000 && !(await k.confirm(`Copy ${jobs.length} objects?`, 'This is a lot of objects; the copies run one after another and count toward your quota.', 'Copy', false))) return
    let done = 0
    const errors = []
    for (const j of jobs) {
      k.say(status, `Copying ${++done} of ${jobs.length}...`)
      try { await lib.api('POST', `/api/buckets/${encodeURIComponent(target.bucket)}/copy`, { source: { bucket: bucket.name, key: j.src }, destination: { key: j.dst } }) } catch (e) { errors.push(`${j.src}: ${e.message}`) }
    }
    k.say(status, errors.length ? `Copied ${jobs.length - errors.length} of ${jobs.length}. ${errors[0]}` : `Copied ${jobs.length} object${jobs.length === 1 ? '' : 's'}.`, errors.length ? 'bad' : 'ok')
    if (target.bucket === bucket.name) await load(true)
  }

  function details(o) { return detailsDrawer(lib, k, bucket, o, { downloadVersion, reload: () => load(true) }) }

  // ---- upload panel (module-level jobs survive navigation; this view just renders them)
  const paintUploads = () => {
    const shown = uploads.jobs.filter((j) => j.bucket === bucket.name).slice(-12)
    if (!shown.length) return panel.replaceChildren()
    const active = shown.filter((j) => j.status === 'queued' || j.status === 'uploading').length
    panel.replaceChildren(h('div', { class: 'st-card st-up' },
      h('div', { class: 'st-up-head' }, h('strong', {}, active ? `Uploading ${active} file${active === 1 ? '' : 's'}...` : 'Uploads'),
        h('button', { class: 'link', type: 'button', onclick: () => { uploads.jobs = uploads.jobs.filter((j) => j.status === 'queued' || j.status === 'uploading'); notifyUploads() } }, 'Clear finished')),
      h('ul', { class: 'st-up-list' }, ...shown.map((j) => {
        const pct = j.size ? Math.min(100, (j.loaded / j.size) * 100) : j.status === 'done' ? 100 : 0
        return h('li', { class: `st-up-item st-up-${j.status}` },
          h('span', { class: 'st-up-name', title: j.key }, j.key.slice(prefix.length) || j.key),
          h('span', { class: 'st-up-meta' }, j.status === 'error' ? j.error : j.status === 'done' ? `Done, ${bytes(lib, j.size)}` : j.status === 'cancelled' ? 'Cancelled' : j.status === 'queued' ? 'Waiting...' : `${Math.round(pct)}% of ${bytes(lib, j.size)}`),
          h('div', { class: 'st-meter st-slim', role: 'progressbar', 'aria-label': `Upload of ${baseName(j.key)}`, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)) },
            h('div', { class: `st-meter-bar${j.status === 'error' ? ' st-hot' : ''}`, style: { width: `${pct}%` } })),
          j.status === 'queued' || j.status === 'uploading' ? h('button', { class: 'sec', type: 'button', onclick: () => { if (j.cancel) j.cancel(); else { j.status = 'cancelled'; j.error = 'Cancelled'; notifyUploads() } } }, 'Cancel') : null,
          j.status === 'error' || j.status === 'cancelled' ? h('button', { class: 'sec', type: 'button', onclick: () => { j.status = 'queued'; j.loaded = 0; j.error = null; notifyUploads(); pumpUploads(lib) } }, 'Retry') : null)
      }))))
  }
  let refreshTimer = null
  const onUploads = (event, job) => {
    if (!root.isConnected) { uploads.subs.delete(onUploads); return }
    paintUploads()
    if (event === 'finished' && job?.bucket === bucket.name && job.status === 'done') {
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => { if (root.isConnected) load(true) }, 250)
    }
  }
  uploads.subs.add(onUploads)
  paintUploads()
  await load(true)
}

/* ============================================================================================ presign dialog */

function presignDialog(lib, k, bucket, key, opts = {}) {
  const { h } = k
  return k.modal('Share a link', (body, close) => {
    const method = h('select', { name: 'method' }, h('option', { value: 'GET' }, 'Download (GET)'), h('option', { value: 'PUT' }, 'Upload (PUT)'), h('option', { value: 'DELETE' }, 'Delete (DELETE)'))
    const expires = h('select', { name: 'expires' }, ...EXPIRY.map(([s, label]) => h('option', { value: s, selected: s === 3600 }, label)))
    const download = h('input', { type: 'checkbox', checked: true })
    const ctype = h('input', { placeholder: 'e.g. image/png (optional)', maxlength: 200, autocomplete: 'off' })
    const downloadRow = h('label', { class: 'st-check' }, download, 'Force a download (instead of showing it in the browser)')
    const ctypeRow = k.field('Required Content-Type', ctype, 'The uploader must send exactly this Content-Type.')
    ctypeRow.hidden = true
    const out = h('div', { class: 'st-presign-out' })
    const m = k.msg()
    const sync = () => { downloadRow.hidden = method.value !== 'GET'; ctypeRow.hidden = method.value !== 'PUT' }
    method.addEventListener('change', sync)
    sync()
    const warn = h('p', { class: 'st-warnbox' }, 'Anyone who has this link can use it to perform that one action until it expires, without signing in. The object itself stays private.')
    const form = h('form', { class: 'st-form', onsubmit: k.run(m, async () => {
      const req = { key, method: method.value, expiresIn: Number(expires.value) }
      if (opts.versionId) req.versionId = opts.versionId
      if (method.value === 'GET' && download.checked) req.disposition = 'attachment'
      if (method.value === 'PUT' && ctype.value.trim()) req.contentType = ctype.value.trim()
      const r = await lib.api('POST', `/api/buckets/${encodeURIComponent(bucket.name)}/presign`, req)
      const full = new URL(r.path, location.origin).href
      const hint = r.method === 'PUT' ? `curl -X PUT --data-binary @file ${req.contentType ? `-H 'Content-Type: ${req.contentType}' ` : ''}'${full}'` : r.method === 'DELETE' ? `curl -X DELETE '${full}'` : null
      out.replaceChildren(h('p', {}, `Valid until ${when(r.expiresAt)}.`), k.urlBox(full), hint ? h('pre', { class: 'st-pre' }, hint) : null)
    }) },
    h('p', { class: 'st-muted' }, h('code', {}, key), opts.versionId ? ` (version ${shortId(opts.versionId)})` : ''),
    opts.versionId ? null : k.field('Link allows', method), k.field('Expires after', expires), downloadRow, ctypeRow, warn,
    h('div', { class: 'st-actions' }, h('button', { class: 'sec', type: 'button', onclick: () => close(null) }, 'Close'), h('button', { type: 'submit' }, 'Create link')), m, out)
    body.append(form)
  })
}

/* ============================================================================================ details + versions drawer */

async function detailsDrawer(lib, k, bucket, listed, hooks) {
  const { h } = k
  const B = encodeURIComponent(bucket.name)
  const key = listed.key
  return k.modal(baseName(key), (body, close) => {
    const root = h('div', { class: 'st-details' }, h('p', { class: 'st-muted' }, 'Loading...'))
    body.append(root)
    const m = k.msg()
    const paint = async () => {
      let meta
      let versions = []
      try {
        meta = await lib.api('GET', `/api/buckets/${B}/meta/${enc(key)}`)
        if (bucket.versioning !== 'disabled') versions = (await lib.api('GET', `/api/buckets/${B}/versions?key=${encodeURIComponent(key)}&max-keys=200`)).versions
      } catch (e) { root.replaceChildren(h('p', { class: 'err' }, e.message)); return }
      const isPublic = meta.acl === 'public-read' || (bucket.acl === 'public-read' && meta.acl !== 'private')
      const publicUrl = new URL(`/pub/${encodeURIComponent(bucket.name)}/${enc(key)}`, location.origin).href
      const kv = (label, value) => [h('dt', {}, label), h('dd', {}, value)]
      const preview = h('div', { class: 'st-preview' })
      if (/^image\/(png|jpe?g|gif|webp|avif|svg\+xml)/.test(meta.contentType) && meta.size < 8 * MiB) {
        lib.api('POST', `/api/buckets/${B}/presign`, { key, expiresIn: 300, disposition: 'inline' }).then((r) => preview.append(h('img', { src: r.path, alt: `Preview of ${baseName(key)}`, loading: 'lazy' }))).catch(() => {})
      }
      // ---- access
      const acl = h('select', { 'aria-label': 'Access' }, ...[['inherit', `Same as the bucket (${bucket.acl === 'public-read' ? 'public read' : 'private'})`], ['private', 'Always private'], ['public-read', 'Public read']].map(([v, l]) => h('option', { value: v, selected: v === meta.acl }, l)))
      const aclForm = h('form', { class: 'st-inline', onsubmit: k.run(m, async () => {
        if (acl.value === 'public-read' && !(await k.confirm('Make this object public?', 'Anyone with the link can read it without signing in.', 'Make public', false))) return
        await lib.api('PUT', `/api/buckets/${B}/acl/${enc(key)}`, { acl: acl.value })
        k.say(m, 'Access saved', 'ok')
        hooks.reload()
        paint()
      }) }, acl, h('button', { type: 'submit' }, 'Save access'))
      // ---- tags
      const tagRows = h('div', { class: 'st-tags' })
      const addTag = (name = '', value = '') => {
        const n = h('input', { value: name, placeholder: 'key', maxlength: 128, 'aria-label': 'Tag key' })
        const v = h('input', { value, placeholder: 'value', maxlength: 256, 'aria-label': 'Tag value' })
        const row = h('div', { class: 'st-tagrow' }, n, v, h('button', { class: 'sec', type: 'button', 'aria-label': 'Remove tag', onclick: () => row.remove() }, 'Remove'))
        tagRows.append(row)
      }
      Object.entries(meta.tags ?? {}).forEach(([n, v]) => addTag(n, v))
      const tagForm = h('form', { class: 'st-form', onsubmit: k.run(m, async () => {
        const tags = {}
        for (const row of tagRows.children) { const [n, v] = row.querySelectorAll('input'); if (n.value.trim()) tags[n.value.trim()] = v.value }
        await lib.api('PUT', `/api/buckets/${B}/tagging/${enc(key)}`, { tags })
        k.say(m, 'Tags saved', 'ok')
      }) }, tagRows, h('div', { class: 'st-actions' }, h('button', { class: 'sec', type: 'button', onclick: () => addTag() }, 'Add tag'), h('button', { type: 'submit' }, 'Save tags')))
      // ---- content type + metadata (a server-side copy onto itself)
      const ctype = h('input', { value: meta.contentType, maxlength: 255, 'aria-label': 'Content type' })
      const metaRows = h('div', { class: 'st-tags' })
      const addMeta = (name = '', value = '') => {
        const n = h('input', { value: name, placeholder: 'name', maxlength: 64, 'aria-label': 'Metadata name' })
        const v = h('input', { value, placeholder: 'value', maxlength: 1024, 'aria-label': 'Metadata value' })
        const row = h('div', { class: 'st-tagrow' }, n, v, h('button', { class: 'sec', type: 'button', 'aria-label': 'Remove metadata', onclick: () => row.remove() }, 'Remove'))
        metaRows.append(row)
      }
      Object.entries(meta.metadata ?? {}).forEach(([n, v]) => addMeta(n, v))
      const metaForm = h('form', { class: 'st-form', onsubmit: k.run(m, async () => {
        const metadata = {}
        for (const row of metaRows.children) { const [n, v] = row.querySelectorAll('input'); if (n.value.trim()) metadata[n.value.trim()] = v.value }
        await lib.api('POST', `/api/buckets/${B}/copy`, { source: { key }, destination: { key }, metadataDirective: 'REPLACE', contentType: ctype.value.trim() || meta.contentType, metadata, tags: meta.tags,
          ...(meta.cacheControl ? { cacheControl: meta.cacheControl } : {}), ...(meta.contentDisposition ? { contentDisposition: meta.contentDisposition } : {}) })
        k.say(m, bucket.versioning === 'enabled' ? 'Saved as a new version' : 'Saved', 'ok')
        hooks.reload()
        paint()
      }) }, k.field('Content type', ctype), metaRows, h('div', { class: 'st-actions' }, h('button', { class: 'sec', type: 'button', onclick: () => addMeta() }, 'Add metadata'), h('button', { type: 'submit' }, 'Save metadata')))

      // ---- versions
      const vrows = versions.map((v) => h('tr', {},
        h('td', {}, h('code', { title: v.versionId }, shortId(v.versionId)), ' ', v.isLatest ? k.badge('current', 'ok') : null, v.deleteMarker ? [' ', k.badge('delete marker', 'warn')] : null),
        h('td', {}, v.deleteMarker ? '-' : bytes(lib, v.size)),
        h('td', {}, when(v.lastModified)),
        h('td', { class: 'st-row-actions' },
          !v.deleteMarker ? h('button', { class: 'sec', type: 'button', onclick: lib.act(() => hooks.downloadVersion(key, v.versionId)) }, 'Download') : null,
          !v.deleteMarker ? h('button', { class: 'sec', type: 'button', onclick: () => presignDialog(lib, k, bucket, key, { versionId: v.versionId }) }, 'Share') : null,
          !v.deleteMarker && !v.isLatest ? h('button', { class: 'sec', type: 'button', onclick: lib.act(async () => {
            await lib.api('POST', `/api/buckets/${B}/restore`, { key, versionId: v.versionId })
            lib.toast('Version restored as the newest version')
            hooks.reload()
            paint()
          }) }, 'Restore') : null,
          h('button', { class: 'sec', type: 'button', onclick: lib.act(async () => {
            if (!(await k.confirm('Delete this version permanently?', v.deleteMarker ? 'Removing the delete marker makes the previous version current again.' : 'The data of this version is removed for good.', 'Delete version'))) return
            await lib.api('DELETE', `/api/buckets/${B}/objects/${enc(key)}?versionId=${encodeURIComponent(v.versionId)}`)
            hooks.reload()
            paint()
          }) }, 'Delete'))))
      const versionBox = bucket.versioning === 'disabled'
        ? h('p', { class: 'st-muted' }, 'Versioning is off for this bucket, so only the latest data is kept. ', h('a', { href: settingsHash(bucket.name), onclick: () => close(null) }, 'Turn it on in Settings.'))
        : k.table(['Version', 'Size', 'Modified', ''], vrows, 'st-versions')

      root.replaceChildren(
        preview,
        h('dl', { class: 'st-dl' }, ...kv('Key', h('code', {}, key)), ...kv('Size', `${bytes(lib, meta.size)} (${meta.size.toLocaleString()} bytes)`), ...kv('Type', meta.contentType), ...kv('Modified', when(meta.lastModified)),
          ...kv('ETag', h('code', {}, meta.etag ?? '')), ...kv('Version', h('code', {}, meta.versionId)), ...(meta.partCount ? kv('Multipart', `${meta.partCount} parts`) : [])),
        h('div', { class: 'st-actions' },
          h('button', { type: 'button', onclick: lib.act(() => hooks.downloadVersion(key)) }, 'Download'),
          h('button', { class: 'sec', type: 'button', onclick: () => presignDialog(lib, k, bucket, key) }, 'Share link')),
        k.card('Access', aclForm, isPublic ? [h('p', { class: 'st-warnbox' }, 'This object is publicly readable at:'), k.urlBox(publicUrl)] : h('p', { class: 'st-muted' }, 'Only you can read this object. Use "Share link" for temporary access.')),
        k.card('Tags', tagForm),
        k.card('Content type and metadata', metaForm),
        k.card(`Versions${bucket.versioning !== 'disabled' ? ` (${versions.length})` : ''}`, versionBox),
        m)
    }
    paint()
  }, { drawer: true })
}

/* ============================================================================================ settings */

async function settingsPage(root, lib, k, bucket, section) {
  const { h } = k
  const nav = h('nav', { class: 'st-subtabs', 'aria-label': 'Settings sections' },
    ...SETTINGS.map(([id, label]) => h('a', { class: `st-subtab${id === section ? ' on' : ''}`, href: settingsHash(bucket.name, id), ...(id === section ? { 'aria-current': 'page' } : {}) }, label)))
  const body = h('div', { class: 'st-settings' })
  root.append(nav, body)
  const B = encodeURIComponent(bucket.name)
  const sections = { general: generalSettings, access: accessSettings, lifecycle: lifecycleSettings, cors: corsSettings, website: websiteSettings }
  await sections[section](body, lib, k, bucket, B)
}

async function generalSettings(body, lib, k, bucket, B) {
  const { h } = k
  const info = uploads.info ?? {}
  const vm = k.msg()
  const setVersioning = (v) => k.run(vm, async () => {
    if (v === 'suspended' && !(await k.confirm('Suspend versioning?', 'New uploads replace the current "null" version instead of creating versions. Existing versions are kept.', 'Suspend', false))) return
    await lib.api('PATCH', `/api/buckets/${B}`, { versioning: v })
    lib.rerender()
  })
  const versionCard = k.card('Versioning',
    h('p', {}, bucket.versioning === 'enabled' ? 'Every upload creates a new version. Deleting an object adds a delete marker and keeps the data, so mistakes are recoverable. All versions count toward your quota.'
      : bucket.versioning === 'suspended' ? 'Versioning is suspended: new uploads overwrite the "null" version; older versions are kept until you delete them or a lifecycle rule expires them.'
        : 'Versioning is off: an upload replaces the previous data and a delete is permanent.'),
    h('div', { class: 'st-actions' },
      bucket.versioning !== 'enabled' ? h('button', { type: 'button', onclick: setVersioning('enabled') }, 'Enable versioning') : null,
      bucket.versioning === 'enabled' ? h('button', { class: 'sec', type: 'button', onclick: setVersioning('suspended') }, 'Suspend versioning') : null),
    bucket.versioning === 'disabled' ? h('p', { class: 'st-hint' }, 'Versioning can be suspended later but never switched off completely.') : null, vm)

  const tags = h('div', { class: 'st-tags' })
  const addTag = (n = '', v = '') => {
    const ni = h('input', { value: n, placeholder: 'key', maxlength: 128, 'aria-label': 'Tag key' })
    const vi = h('input', { value: v, placeholder: 'value', maxlength: 256, 'aria-label': 'Tag value' })
    const row = h('div', { class: 'st-tagrow' }, ni, vi, h('button', { class: 'sec', type: 'button', 'aria-label': 'Remove tag', onclick: () => row.remove() }, 'Remove'))
    tags.append(row)
  }
  Object.entries(bucket.tags ?? {}).forEach(([n, v]) => addTag(n, v))
  const tm = k.msg()
  const tagCard = k.card('Bucket tags', h('form', { class: 'st-form', onsubmit: k.run(tm, async () => {
    const out = {}
    for (const row of tags.children) { const [n, v] = row.querySelectorAll('input'); if (n.value.trim()) out[n.value.trim()] = v.value }
    await lib.api('PUT', `/api/buckets/${B}/tags`, { tags: out })
    k.say(tm, 'Tags saved', 'ok')
  }) }, tags, h('div', { class: 'st-actions' }, h('button', { class: 'sec', type: 'button', onclick: () => addTag() }, 'Add tag'), h('button', { type: 'submit' }, 'Save tags')), tm))

  const uploadsBox = h('div', {}, h('p', { class: 'st-muted' }, 'Loading...'))
  const paintUploads = async () => {
    const { uploads: open } = await lib.api('GET', `/api/buckets/${B}/uploads`)
    uploadsBox.replaceChildren(open.length ? k.table(['Key', 'Started', 'Parts', 'Size', ''], open.map((u) => h('tr', {}, h('td', {}, h('code', {}, u.key)), h('td', {}, when(u.createdAt)), h('td', {}, String(u.partCount)), h('td', {}, bytes(lib, u.size)),
      h('td', { class: 'st-row-actions' }, h('button', { class: 'sec', type: 'button', onclick: lib.act(async () => { await lib.api('DELETE', `/api/buckets/${B}/uploads/${u.uploadId}`); paintUploads() }) }, 'Abort'))))) : h('p', { class: 'st-muted' }, 'No unfinished multipart uploads.'))
  }
  paintUploads().catch((e) => uploadsBox.replaceChildren(h('p', { class: 'err' }, e.message)))

  const dm = k.msg()
  body.append(
    k.card('Details', h('dl', { class: 'st-dl' }, h('dt', {}, 'Name'), h('dd', {}, bucket.name), h('dt', {}, 'Region'), h('dd', {}, `${bucket.region}${(info.regions?.length ?? 2) === 1 ? ' (label only: one deployment, one storage location)' : ''}`),
      h('dt', {}, 'Created'), h('dd', {}, when(bucket.createdAt)), h('dt', {}, 'Contents'), h('dd', {}, `${bucket.objectCount} objects, ${bucket.versionCount} versions in total, ${bytes(lib, bucket.sizeBytes)}`))),
    versionCard, tagCard,
    k.card('Unfinished multipart uploads', h('p', { class: 'st-muted' }, 'Parts of interrupted large uploads still use quota until they are completed, aborted or cleaned up by the lifecycle sweeper (after 7 days at the latest).'), uploadsBox),
    h('section', { class: 'st-card st-danger-zone' }, h('h2', { class: 'st-h' }, 'Delete bucket'), h('p', {}, 'Removes the bucket and everything in it, including all versions.'),
      h('button', { class: 'st-danger', type: 'button', onclick: lib.act(async () => { if (await deleteBucket(lib, k, bucket)) location.hash = '#storage' }) }, 'Delete this bucket'), dm))
}

async function accessSettings(body, lib, k, bucket, B) {
  const { h } = k
  const m = k.msg()
  const pub = bucket.acl === 'public-read'
  const set = (acl) => k.run(m, async () => {
    if (acl === 'public-read' && !(await k.confirm('Make this bucket public?', 'Every object in it (except those marked "always private") becomes readable by anyone on the internet, without signing in. Listing stays private.', 'Make public', false))) return
    await lib.api('PATCH', `/api/buckets/${B}`, { acl })
    lib.rerender()
  })
  const publicBase = new URL(`/pub/${encodeURIComponent(bucket.name)}/`, location.origin).href
  const revokeMsg = k.msg()
  body.append(
    k.card('Public access', h('p', {}, pub ? 'This bucket is public: its objects can be read by anyone at the URL below. Individual objects can be marked "always private" from their Details panel.'
      : 'This bucket is private: only you (signed in) can read it. You can still mark single objects public from their Details panel, or share temporary presigned links.'),
    pub ? [h('p', {}, 'Public object URL prefix:'), k.urlBox(publicBase)] : null,
    h('div', { class: 'st-actions' }, pub ? h('button', { class: 'sec', type: 'button', onclick: set('private') }, 'Make private') : h('button', { type: 'button', onclick: set('public-read') }, 'Make public (read)')), m),
    k.card('How public content is served', h('ul', { class: 'st-list-plain' },
      h('li', {}, 'Public files are served from this origin with ', h('code', {}, 'X-Content-Type-Options: nosniff'), ' and a sandboxing Content-Security-Policy, so an uploaded HTML or SVG file can never run scripts against the console.'),
      h('li', {}, 'HTML, SVG, XML and script files are served as downloads on public links. To publish a real web page, use the Website tab.'),
      h('li', {}, 'Cross-origin browser access to public files needs a CORS rule.'))),
    k.card('Presigned links', h('p', {}, 'Links created with "Share" are signed with a server secret and expire on their own (5 minutes to 7 days). If one leaks you can invalidate every link ever issued for this bucket at once.'),
      h('div', { class: 'st-actions' }, h('button', { class: 'sec', type: 'button', onclick: k.run(revokeMsg, async () => {
        if (!(await k.confirm('Revoke all presigned links?', 'Every link issued so far for this bucket stops working immediately. New links work normally.', 'Revoke links'))) return
        await lib.api('POST', `/api/buckets/${B}/presign/revoke`, {})
        k.say(revokeMsg, 'All earlier links are revoked.', 'ok')
      }) }, 'Revoke all presigned links')), revokeMsg))
}

async function lifecycleSettings(body, lib, k, bucket, B) {
  const { h } = k
  const { rules } = await lib.api('GET', `/api/buckets/${B}/lifecycle`)
  const m = k.msg()
  const save = async (next, okText) => {
    await lib.api('PUT', `/api/buckets/${B}/lifecycle`, { rules: next })
    k.say(m, okText, 'ok')
    paint(next)
  }
  const describe = (r) => [
    r.expirationDays ? `delete current objects ${r.expirationDays} day(s) after upload${bucket.versioning !== 'disabled' ? ' (adds a delete marker)' : ''}` : null,
    r.noncurrentExpirationDays ? `delete old versions ${r.noncurrentExpirationDays} day(s) after they were replaced` : null,
    r.abortIncompleteMultipartDays ? `abort unfinished uploads after ${r.abortIncompleteMultipartDays} day(s)` : null,
    r.expiredObjectDeleteMarker ? 'remove delete markers that hide nothing' : null,
  ].filter(Boolean).join('; ')
  const list = h('div', {})
  const report = h('div', { class: 'st-report', 'aria-live': 'polite' })
  const run = (dryRun) => k.run(m, async () => {
    const r = await lib.api('POST', `/api/buckets/${B}/lifecycle/run?dryRun=${dryRun}`)
    const lines = [`${dryRun ? 'Would expire' : 'Expired'} ${r.expired} object(s), remove ${r.noncurrentRemoved} old version(s) and ${r.markersRemoved} delete marker(s), abort ${r.uploadsAborted} upload(s).`]
    if (r.truncated) lines.push('More work remains; run again.')
    report.replaceChildren(...lines.map((l) => h('p', {}, l)), r.sample.length ? h('ul', { class: 'st-list-plain' }, ...r.sample.slice(0, 10).map((s) => h('li', {}, h('code', {}, s.key), ` (${s.action})`))) : null)
  })
  function paint(current) {
    list.replaceChildren(current.length ? k.table(['Rule', 'Applies to', 'Does', 'Status', ''], current.map((r, i) => h('tr', {},
      h('td', {}, h('code', {}, r.id)), h('td', {}, r.prefix ? `keys starting with "${r.prefix}"` : 'all objects'), h('td', {}, describe(r)),
      h('td', {}, k.badge(r.status, r.status === 'enabled' ? 'ok' : 'muted')),
      h('td', { class: 'st-row-actions' },
        h('button', { class: 'sec', type: 'button', onclick: k.run(m, () => save(current.map((x, j) => (j === i ? { ...x, status: x.status === 'enabled' ? 'disabled' : 'enabled' } : x)), 'Rule updated')) }, r.status === 'enabled' ? 'Disable' : 'Enable'),
        h('button', { class: 'sec', type: 'button', onclick: k.run(m, () => save(current.filter((_, j) => j !== i), 'Rule removed')) }, 'Remove'))))) : h('p', { class: 'st-muted' }, 'No lifecycle rules. Objects stay until you delete them.'))
  }
  paint(rules)

  const id = h('input', { placeholder: 'e.g. expire-tmp', maxlength: 64, pattern: '[A-Za-z0-9_.:\\-]{1,64}', 'aria-label': 'Rule name' })
  const prefix = h('input', { placeholder: 'tmp/ (empty = whole bucket)', maxlength: 500, autocomplete: 'off' })
  const num = (label) => h('input', { type: 'number', min: '1', max: '36500', inputmode: 'numeric', 'aria-label': label, placeholder: 'days' })
  const exp = num('Expire current objects after days')
  const non = num('Expire old versions after days')
  const abort = num('Abort unfinished uploads after days')
  const marker = h('input', { type: 'checkbox' })
  const fm = k.msg()
  const add = h('form', { class: 'st-form', onsubmit: k.run(fm, async () => {
    const rule = { id: id.value.trim() || undefined, prefix: prefix.value.trim(), status: 'enabled', expiredObjectDeleteMarker: marker.checked }
    if (exp.value) rule.expirationDays = Number(exp.value)
    if (non.value) rule.noncurrentExpirationDays = Number(non.value)
    if (abort.value) rule.abortIncompleteMultipartDays = Number(abort.value)
    const current = (await lib.api('GET', `/api/buckets/${B}/lifecycle`)).rules
    if (!rule.id) rule.id = `rule-${current.length + 1}`
    await lib.api('PUT', `/api/buckets/${B}/lifecycle`, { rules: [...current, rule] })
    lib.rerender()
  }) }, k.field('Rule name', id), k.field('Applies to keys starting with', prefix),
  k.field('Delete current objects after (days)', exp, bucket.versioning === 'enabled' ? 'In a versioned bucket this adds a delete marker.' : 'Counted from the upload time.'),
  k.field('Delete old versions after (days)', non, 'Counted from the moment a version was replaced or deleted.'),
  k.field('Abort unfinished multipart uploads after (days)', abort), h('label', { class: 'st-check' }, marker, 'Remove delete markers once no version is left behind them'),
  h('div', { class: 'st-actions' }, h('button', { type: 'submit' }, 'Add rule')), fm)

  body.append(
    k.card('Lifecycle rules', h('p', { class: 'st-muted' }, 'Rules run automatically every few minutes. Uploads abandoned for 7 days are always cleaned up.'), list, m,
      h('div', { class: 'st-actions' }, h('button', { class: 'sec', type: 'button', onclick: run(true) }, 'Preview (dry run)'), h('button', { class: 'sec', type: 'button', onclick: lib.act(async () => { if (await k.confirm('Run lifecycle rules now?', 'Matching objects are deleted as the rules say.', 'Run now')) await run(false)() }) }, 'Run now')), report),
    k.card('Add a rule', add))
}

async function corsSettings(body, lib, k, bucket, B) {
  const { h } = k
  const { rules } = await lib.api('GET', `/api/buckets/${B}/cors`)
  const m = k.msg()
  const holder = h('div', { class: 'st-cors' })
  const cards = []
  const addCard = (r = { allowedOrigins: [''], allowedMethods: ['GET', 'HEAD'], allowedHeaders: ['*'], exposeHeaders: ['ETag'], maxAgeSeconds: 3600 }) => {
    const origins = h('textarea', { rows: 3, 'aria-label': 'Allowed origins', placeholder: 'https://app.example.com\nhttps://*.example.com\n*' }, r.allowedOrigins.join('\n'))
    const methods = CORS_METHODS.map((mm) => h('label', { class: 'st-check' }, h('input', { type: 'checkbox', value: mm, checked: r.allowedMethods.includes(mm) }), mm))
    const headers = h('input', { value: r.allowedHeaders.join(', '), placeholder: '*, content-type, range', autocomplete: 'off', 'aria-label': 'Allowed request headers' })
    const expose = h('input', { value: r.exposeHeaders.join(', '), placeholder: 'ETag, x-rd-version-id', autocomplete: 'off', 'aria-label': 'Exposed response headers' })
    const age = h('input', { type: 'number', min: '0', max: '86400', value: String(r.maxAgeSeconds ?? 3600), 'aria-label': 'Preflight cache seconds' })
    const card = h('fieldset', { class: 'st-corscard' }, h('legend', {}, `Rule ${cards.length + 1}`),
      k.field('Allowed origins (one per line)', origins, 'Exact origins, "*", or one wildcard such as https://*.example.com'),
      h('div', { class: 'st-field' }, h('span', { class: 'st-label' }, 'Allowed methods'), h('div', { class: 'st-checks' }, ...methods)),
      k.field('Allowed request headers (comma separated)', headers), k.field('Exposed response headers (comma separated)', expose), k.field('Preflight cache (seconds)', age),
      h('button', { class: 'sec', type: 'button', onclick: () => { cards.splice(cards.indexOf(get), 1); card.remove() } }, 'Remove this rule'))
    const split = (v, sep) => v.split(sep).map((s) => s.trim()).filter(Boolean)
    const get = () => ({ allowedOrigins: split(origins.value, '\n'), allowedMethods: methods.map((l) => l.firstChild).filter((c) => c.checked).map((c) => c.value),
      allowedHeaders: split(headers.value, ','), exposeHeaders: split(expose.value, ','), maxAgeSeconds: Number(age.value) || 0 })
    cards.push(get)
    holder.append(card)
  }
  rules.forEach(addCard)
  body.append(k.card('Cross-origin access (CORS)',
    h('p', { class: 'st-muted' }, 'CORS rules decide which websites may read this bucket from a browser. They apply to public files (/pub), website files and presigned links. Without a rule, browsers block cross-origin reads.'),
    holder, m,
    h('div', { class: 'st-actions' }, h('button', { class: 'sec', type: 'button', onclick: () => addCard() }, 'Add rule'),
      h('button', { type: 'button', onclick: k.run(m, async () => { await lib.api('PUT', `/api/buckets/${B}/cors`, { rules: cards.map((g) => g()) }); k.say(m, 'CORS rules saved', 'ok') }) }, 'Save rules'))))
}

async function websiteSettings(body, lib, k, bucket, B) {
  const { h } = k
  let site = null
  try { site = await lib.api('GET', `/api/buckets/${B}/website`) } catch { /* not enabled */ }
  const index = h('input', { value: site?.indexDocument ?? 'index.html', maxlength: 200, autocomplete: 'off' })
  const error = h('input', { value: site?.errorDocument ?? '', placeholder: '404.html (optional)', maxlength: 500, autocomplete: 'off' })
  const m = k.msg()
  const url = new URL(`/site/${encodeURIComponent(bucket.name)}/`, location.origin).href
  body.append(k.card('Static website hosting',
    h('p', { class: 'st-muted' }, 'Serves the public objects of this bucket as a website at the address below. Scripts on the site run in a sandbox: they cannot reach the console, your account or the API.'),
    bucket.acl !== 'public-read' ? h('p', { class: 'st-warnbox' }, 'This bucket is private, so the site would show "not found" for everything. ', h('a', { href: settingsHash(bucket.name, 'access') }, 'Make the bucket public'), ' (or mark the site files public one by one).') : null,
    site ? [h('p', {}, 'Website address:'), k.urlBox(url), h('p', {}, h('a', { href: url, target: '_blank', rel: 'noopener' }, 'Open the site in a new tab'))] : null,
    h('form', { class: 'st-form', onsubmit: k.run(m, async () => {
      await lib.api('PUT', `/api/buckets/${B}/website`, { indexDocument: index.value.trim() || 'index.html', ...(error.value.trim() ? { errorDocument: error.value.trim() } : {}) })
      lib.rerender()
    }) }, k.field('Index document', index, 'Served for "/" and for folders (for example docs/ serves docs/index.html).'), k.field('Error document', error, 'Served with status 404 when a page is missing.'),
    h('div', { class: 'st-actions' }, h('button', { type: 'submit' }, site ? 'Save' : 'Enable website hosting'),
      site ? h('button', { class: 'sec', type: 'button', onclick: k.run(m, async () => { await lib.api('DELETE', `/api/buckets/${B}/website`); lib.rerender() }) }, 'Disable') : null), m)))
}
