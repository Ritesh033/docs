// Shared UI helpers. UI modules in public/ui/*.js receive this object as their last render() argument.
// Rule: never put user data into innerHTML - build DOM with h() (text nodes are safe).
export const state = { token: localStorage.getItem('rd_token') }

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else if (v === true) el.setAttribute(k, '')
    else el.setAttribute(k, v)
  }
  el.append(...kids.flat(Infinity).filter((x) => x != null && x !== false))
  return el
}

/** JSON/raw fetch against the API. Throws Error(message) on non-2xx. opts: {raw, headers, signal, response} */
export async function api(method, path, body, opts = {}) {
  const res = await fetch(path, {
    method,
    signal: opts.signal,
    headers: {
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...(body !== undefined && !opts.raw ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
    body: body === undefined ? undefined : opts.raw ? body : JSON.stringify(body),
  })
  if (opts.response) return res
  if (res.status === 401 && state.token && !path.startsWith('/api/auth/')) {
    localStorage.removeItem('rd_token')
    location.reload()
    throw new Error('Session expired')
  }
  const isJson = res.headers.get('content-type')?.includes('json')
  const data = isJson ? await res.json() : await res.blob()
  if (!res.ok) throw new Error(data?.error || res.statusText)
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

export const rerender = () => window.dispatchEvent(new Event('rd:rerender'))
export const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`)
export const fmtDate = (d) => (d ? new Date(d).toLocaleString() : '')

export const lib = { h, api, toast, act, download, confirmDialog, promptDialog, rerender, fmtBytes, fmtDate, state }
