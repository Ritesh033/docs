// Shared UI helpers. UI modules in public/ui/*.js receive this object as their last render() argument.
// Rule: never put user data into innerHTML - build DOM with h() (text nodes are safe).
export const state = { token: localStorage.getItem('rd_token') }

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v) // CSSOM is CSP-safe; style="..." attributes are not
    else if (v === true) el.setAttribute(k, '')
    else el.setAttribute(k, v)
  }
  el.append(...kids.flat(Infinity).filter((x) => x != null && x !== false))
  return el
}

/** JSON/raw fetch against the API. Throws Error(message) on non-2xx. opts: {raw, headers, signal, response} */
export async function api(method, path, body, opts = {}) {
  let res
  try { res = await rawFetch(method, path, body, opts) } catch (e) {
    if (e?.name === 'AbortError') throw e
    setNet(false)
    const err = new Error('Network error - check your connection and try again')
    err.network = true
    throw err
  }
  if (opts.response) return res
  return finish(res, path)
}

let netOk = true
function setNet(ok) { if (ok !== netOk) { netOk = ok; window.dispatchEvent(new CustomEvent('rd:network', { detail: { ok } })) } }

const rawFetch = (method, path, body, opts) =>
  fetch(path, {
    method,
    signal: opts.signal,
    headers: {
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...(body !== undefined && !opts.raw ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
    body: body === undefined ? undefined : opts.raw ? body : JSON.stringify(body),
  })

async function finish(res, path) {
  if (res.status === 401 && state.token && !path.startsWith('/api/auth/')) {
    localStorage.removeItem('rd_token')
    location.reload()
    throw new Error('Session expired')
  }
  setNet(true)
  const isJson = /(^|[/+])json\b/.test(res.headers.get('content-type') ?? '') // application/json, +json; not x-ndjson
  const data = isJson ? await res.json() : await res.blob()
  if (!res.ok) {
    const err = new Error(data?.error || res.statusText)
    err.status = res.status
    err.data = isJson ? data : null
    throw err
  }
  return data
}

let toastHost
export function toast(message, kind = 'info') {
  toastHost ??= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }))
  const t = toastHost.appendChild(h('div', { class: `toast ${kind}` }, message))
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3000)
}

/** Wrap an async handler so errors surface as toasts. */
export const act = (fn) => async (e) => {
  try { await fn(e) } catch (err) { toast(err.message, 'error') }
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob)
  h('a', { href: url, download: name }).click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function dialog(build) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'modal' })
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v) }
    dlg.addEventListener('cancel', () => done(null))
    build(dlg, done)
    document.body.append(dlg)
    dlg.showModal()
  })
}
/** Resolves true/false. */
export const confirmDialog = (message, okLabel = 'Confirm') =>
  dialog((dlg, done) => dlg.append(h('p', {}, message), h('div', { class: 'row' }, h('button', { class: 'sec', onclick: () => done(false) }, 'Cancel'), h('button', { onclick: () => done(true) }, okLabel)))).then(Boolean)
/** Resolves the entered string or null. Pass {readonly:true} to show a value for copying. */
export const promptDialog = (message, value = '', opts = {}) =>
  dialog((dlg, done) => {
    const input = h('input', { value, ...(opts.readonly ? { readonly: true } : {}) })
    dlg.append(h('p', {}, message), input, h('div', { class: 'row' }, h('button', { class: 'sec', onclick: () => done(null) }, 'Close'), h('button', { onclick: () => done(input.value) }, opts.okLabel ?? 'OK')))
    setTimeout(() => input.select(), 0)
  })

// ---- additive presentation helpers (all DOM-built; safe for user data) ----------------------------------------
/** Small status pill. kind: ok | warn | bad | info | (none). */
export const badge = (text, kind = '') => h('span', { class: `badge ${kind}`.trim() }, text)
/** Friendly empty state: emptyState('No buckets yet', 'Create one to store files.', actionButtonOrNull). */
export const emptyState = (title, hint, action) => h('div', { class: 'empty' }, h('h3', {}, title), hint ? h('p', {}, hint) : null, action ?? null)
export const spinner = (label = 'Loading') => h('span', { class: 'spinner', role: 'status', 'aria-label': label })
/** Placeholder block while data loads: skeleton(3) -> three bars; skeleton(1, {height:'80px'}). */
export const skeleton = (lines = 1, style = {}) => h('div', { 'aria-hidden': 'true' }, ...Array.from({ length: lines }, (_, i) => h('span', { class: 'skeleton', style: { height: '14px', margin: '8px 0', width: i === lines - 1 && lines > 1 ? '60%' : '100%', ...style } })))
/** Responsive table: table(['Name','Size'], rows, {caption}) where rows are arrays of strings/Nodes. */
export const table = (headers, rows, opts = {}) =>
  h('div', { class: 'tbl-wrap' }, h('table', {}, opts.caption ? h('caption', { class: 'sr-only' }, opts.caption) : null,
    h('thead', {}, h('tr', {}, ...headers.map((x) => h('th', { scope: 'col' }, x)))),
    h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, c)))))))
export const debounce = (fn, ms = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } }
export const fmtNumber = (n) => (Number.isFinite(n) ? new Intl.NumberFormat().format(n) : '-')
export const fmtMoney = (n) => (Number.isFinite(n) ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: n !== 0 && Math.abs(n) < 1 ? 4 : 2 }).format(n) : '-')
export const fmtDuration = (ms) => {
  if (!Number.isFinite(ms)) return '-'
  const s = Math.floor(ms / 1000)
  if (s < 1) return `${Math.round(ms)} ms`
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const hrs = Math.floor(m / 60)
  return hrs < 48 ? `${hrs}h ${m % 60}m` : `${Math.floor(hrs / 24)}d ${hrs % 24}h`
}
/** "3 minutes ago" / "in 2 hours". */
export const fmtRelative = (d) => {
  const t = typeof d === 'number' ? d : Date.parse(d)
  if (!Number.isFinite(t)) return ''
  const diff = (t - Date.now()) / 1000
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]]
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [u, sec] of units) if (Math.abs(diff) >= sec) return rtf.format(Math.round(diff / sec), u)
  return rtf.format(Math.round(diff), 'second')
}
/** Copies text; resolves true/false (falls back to a hidden textarea where the async clipboard API is unavailable). */
export async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true } catch { /* fall through */ }
  const ta = h('textarea', { 'aria-hidden': 'true', readonly: true, style: { position: 'fixed', opacity: '0', top: '0' } })
  ta.value = text
  document.body.append(ta); ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { /* unsupported */ }
  ta.remove()
  return ok
}

// ---- theme (shared by the shell's toggle and the Settings view). 'auto' follows the OS; see /theme-init.js ----------
export function getTheme() {
  try { const t = localStorage.getItem('rd_theme'); return t === 'light' || t === 'dark' ? t : 'auto' } catch { return 'auto' }
}
export function setTheme(t) {
  const v = t === 'light' || t === 'dark' ? t : 'auto'
  try { v === 'auto' ? localStorage.removeItem('rd_theme') : localStorage.setItem('rd_theme', v) } catch { /* storage blocked: applies for this page only */ }
  v === 'auto' ? document.documentElement.removeAttribute('data-theme') : document.documentElement.setAttribute('data-theme', v)
  window.dispatchEvent(new CustomEvent('rd:theme', { detail: v }))
}

export const rerender = () => window.dispatchEvent(new Event('rd:rerender'))
export const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`)
export const fmtDate = (d) => (d ? new Date(d).toLocaleString() : '')

export const lib = { h, api, toast, act, download, confirmDialog, promptDialog, rerender, fmtBytes, fmtDate, state, badge, emptyState, spinner, skeleton, table, debounce, fmtNumber, fmtMoney, fmtDuration, fmtRelative, copyToClipboard, getTheme, setTheme }
