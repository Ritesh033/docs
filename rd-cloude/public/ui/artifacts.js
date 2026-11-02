// Artifacts view + the shared AI UI kit (icons, dialogs, menus, sandboxed preview frame, artifact viewer).
// chat.js and projects.js import the kit from here, so every AI view looks and behaves the same.
//
// Safety rules, all enforced in this file:
//   * DOM is built with h()/createElement only; user and model text always goes through textContent or text nodes.
//   * HTML artifacts are previewed in <iframe sandbox="allow-scripts"> WITHOUT allow-same-origin: the page can run its own
//     scripts but has an opaque origin, so it cannot read cookies, storage or call the API as the user.
//     It is served from /preview/<ticket> (own strict CSP, 5 minute ticket) and falls back to srcdoc when that fails.
//   * SVG artifacts are shown through <img> (scripts never run in an image context); Markdown through renderMarkdown().
import { renderMarkdown, renderCode } from '/markdown.js'

/* ------------------------------------------------------------------------------------------ tiny helpers */

/** Standalone element builder (same contract as lib.h) for pages that do not receive `lib`, such as /share/<token>. */
export function miniH(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
    else if (v === true) el.setAttribute(k, '')
    else el.setAttribute(k, v)
  }
  el.append(...kids.flat(Infinity).filter((x) => x != null && x !== false))
  return el
}

export const TYPE_LABEL = { code: 'Code', html: 'HTML', svg: 'SVG', markdown: 'Markdown' }
export const typeLabel = (t) => TYPE_LABEL[t] ?? 'Code'

export function relTime(iso) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`
  return new Date(t).toLocaleDateString()
}
export const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`)
export const fmtTokens = (n) => (n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k` : `${(n / 1e6).toFixed(1)}M`)

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true } catch { /* fall back below */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.className = 'ai-offscreen'
    document.body.append(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch { return false }
}

/** Remember small per-viewer conveniences (never anything that must persist). */
export const pref = {
  get(key, dflt = null) { try { const v = localStorage.getItem(`rd.ai.${key}`); return v === null ? dflt : v } catch { return dflt } },
  set(key, value) { try { if (value === null || value === undefined || value === '') localStorage.removeItem(`rd.ai.${key}`); else localStorage.setItem(`rd.ai.${key}`, String(value)) } catch { /* private mode */ } },
}

/* ------------------------------------------------------------------------------------------ icons */

const SVG_NS = 'http://www.w3.org/2000/svg'
const ICONS = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  up: '<path d="M7 11v9H4v-9z"/><path d="M7 11l4-8a2 2 0 0 1 2 2v4h6a2 2 0 0 1 2 2l-1 6a2 2 0 0 1-2 2H7"/>',
  down: '<path d="M7 13V4H4v9z"/><path d="M7 13l4 8a2 2 0 0 0 2-2v-4h6a2 2 0 0 0 2-2l-1-6a2 2 0 0 0-2-2H7"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  left: '<path d="M15 5l-7 7 7 7"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  send: '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/>',
  clip: '<path d="M20.5 11.5l-8.6 8.6a5 5 0 0 1-7-7l8.6-8.6a3.4 3.4 0 0 1 4.9 4.9l-8.6 8.6a1.9 1.9 0 0 1-2.7-2.7l7.9-7.9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.2 11l7.6-4M8.2 13l7.6 4"/>',
  download: '<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/>',
  sliders: '<path d="M4 7h9M19 7h1M4 17h1M11 17h9"/><circle cx="16" cy="7" r="2.2"/><circle cx="8" cy="17" r="2.2"/>',
  pin: '<path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/>',
  archive: '<path d="M4 5h16v4H4z"/><path d="M6 9v10h12V9"/><path d="M10 13h4"/>',
  more: '<circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M5 18l5-5 4 4 2-2 3 3"/>',
  code: '<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4v4h4"/><path d="M12 8v4l3 2"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  down2: '<path d="M6 9l6 6 6-6"/>',
  up2: '<path d="M6 15l6-6 6 6"/>',
  diff: '<path d="M8 4v12"/><path d="M4 8l4-4 4 4"/><path d="M16 20V8"/><path d="M12 16l4 4 4-4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="M11 11l8-8M16 6l3 3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.1"/>',
  drive: '<path d="M4 15l3-9h10l3 9z"/><path d="M4 15v4h16v-4"/><path d="M8 17h.01"/>',
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
}
/** An inline SVG icon (decorative: aria-hidden). Buttons must carry their own aria-label. */
export function icon(name, size = 16) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.9')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('class', 'ai-icon')
  // ICONS holds static, trusted path data (never user input), parsed through a template so no innerHTML touches user text.
  const tpl = document.createElementNS(SVG_NS, 'g')
  tpl.append(...parseSvgFragment(ICONS[name] ?? ICONS.info))
  svg.append(tpl)
  return svg
}
function parseSvgFragment(markup) {
  const out = []
  const re = /<(path|circle|rect)\b([^>]*?)\/>/g
  let m
  while ((m = re.exec(markup))) {
    const node = document.createElementNS(SVG_NS, m[1])
    for (const a of m[2].matchAll(/([a-z-]+)="([^"]*)"/g)) node.setAttribute(a[1], a[2])
    out.push(node)
  }
  return out
}

/** Icon-only button with an accessible name and tooltip. */
export function iconButton(h, name, label, onclick, { cls = '', size = 16, pressed } = {}) {
  const b = h('button', { type: 'button', class: `ai-ibtn ${cls}`.trim(), 'aria-label': label, title: label, onclick }, icon(name, size))
  if (pressed !== undefined) b.setAttribute('aria-pressed', String(!!pressed))
  return b
}

/* ------------------------------------------------------------------------------------------ dialog + menu */

let dialogSeq = 0
/**
 * Modal dialog on a native <dialog> (focus trap, Esc, backdrop). build(body, close) fills the body.
 * Returns { dlg, close }. The dialog removes itself from the DOM when closed.
 */
export function openDialog(h, { title, wide = false, build, onClose }) {
  const id = `ai-dlg-${++dialogSeq}`
  const body = h('div', { class: 'ai-dialog-body' })
  const dlg = h('dialog', { class: `ai-dialog${wide ? ' ai-dialog-wide' : ''}`, 'aria-labelledby': id },
    h('div', { class: 'ai-dialog-in' },
      h('div', { class: 'ai-dialog-head' }, h('h2', { id, class: 'ai-dialog-title' }, title), iconButton(h, 'x', 'Close', () => dlg.close())),
      body))
  const close = () => { if (dlg.open) dlg.close() }
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close() })
  dlg.addEventListener('close', () => { dlg.remove(); onClose?.() })
  build(body, close)
  document.body.append(dlg)
  dlg.showModal()
  return { dlg, close }
}

/** Popup menu anchored to a button. items: [{label, icon?, onclick, danger?, disabled?, checked?}] or 'sep'. */
export function openMenu(h, anchor, items, { align = 'end' } = {}) {
  document.querySelectorAll('.ai-menu').forEach((m) => m.remove())
  const menu = h('div', { class: 'ai-menu', role: 'menu' })
  const btns = []
  for (const it of items) {
    if (it === 'sep') { menu.append(h('div', { class: 'ai-menu-sep', role: 'separator' })); continue }
    const b = h('button', {
      type: 'button', role: it.checked === undefined ? 'menuitem' : 'menuitemcheckbox', class: `ai-menu-item${it.danger ? ' ai-danger' : ''}`,
      disabled: it.disabled || null, 'aria-checked': it.checked === undefined ? null : String(!!it.checked),
      onclick: () => { close(false); it.onclick?.() },
    }, it.icon ? icon(it.icon, 15) : h('span', { class: 'ai-menu-pad' }), h('span', { class: 'ai-menu-label' }, it.label), it.checked ? icon('check', 14) : null)
    btns.push(b)
    menu.append(b)
  }
  const onDoc = (e) => { if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(false) }
  function close(refocus = true) {
    document.removeEventListener('pointerdown', onDoc, true)
    window.removeEventListener('resize', onResize)
    menu.remove()
    anchor.setAttribute('aria-expanded', 'false')
    if (refocus) anchor.focus()
  }
  const onResize = () => close(false)
  menu.addEventListener('keydown', (e) => {
    const enabled = btns.filter((b) => !b.disabled)
    const i = enabled.indexOf(document.activeElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); enabled[(i + 1) % enabled.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); enabled[(i - 1 + enabled.length) % enabled.length]?.focus() }
    else if (e.key === 'Home') { e.preventDefault(); enabled[0]?.focus() }
    else if (e.key === 'End') { e.preventDefault(); enabled.at(-1)?.focus() }
    else if (e.key === 'Tab') close(false)
  })
  anchor.setAttribute('aria-haspopup', 'menu')
  anchor.setAttribute('aria-expanded', 'true')
  document.body.append(menu)
  const r = anchor.getBoundingClientRect()
  const mw = menu.offsetWidth
  const mh = menu.offsetHeight
  let left = align === 'end' ? r.right - mw : r.left
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8))
  let top = r.bottom + 4
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4)
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
  document.addEventListener('pointerdown', onDoc, true)
  window.addEventListener('resize', onResize)
  btns.find((b) => !b.disabled)?.focus()
  return { close }
}

/** Render `text` with the [start,end] ranges wrapped in <mark> (search snippets). Text nodes only. */
export function highlighted(h, text, ranges = []) {
  const out = []
  let pos = 0
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (a < pos || b > text.length || a >= b) continue
    if (a > pos) out.push(text.slice(pos, a))
    out.push(h('mark', {}, text.slice(a, b)))
    pos = b
  }
  if (pos < text.length) out.push(text.slice(pos))
  return out
}

/* ------------------------------------------------------------------------------------------ sandboxed preview */

/**
 * <iframe sandbox="allow-scripts"> for untrusted HTML. Never add allow-same-origin: together with allow-scripts it would let the
 * page remove its own sandbox. loadUrl() returns a same-origin /preview/<ticket> URL (own CSP); if it fails we use srcdoc.
 */
export function previewFrame(h, { html, loadUrl, title = 'Preview' }) {
  const frame = h('iframe', { class: 'ai-frame', title, referrerpolicy: 'no-referrer', loading: 'lazy' })
  frame.setAttribute('sandbox', 'allow-scripts')
  const wrap = h('div', { class: 'ai-frame-wrap' }, frame,
    h('p', { class: 'ai-frame-note' }, icon('info', 13), ' Runs in an isolated sandbox: its scripts cannot reach your account, cookies, storage or the platform API.'))
  ;(async () => {
    try {
      const url = loadUrl ? await loadUrl() : null
      if (!url || !/^\/preview\/[\w-]+$/.test(url)) throw new Error('no preview url')
      frame.src = url
    } catch {
      frame.srcdoc = html // fallback; the page CSP may limit inline scripts/styles here
      wrap.append(h('p', { class: 'ai-frame-note' }, 'Using the in-page fallback preview: inline scripts and styles may be blocked by the console security policy.'))
    }
  })()
  return wrap
}

/* ------------------------------------------------------------------------------------------ diff rendering */

/** Render the { hunks } of GET /api/artifacts/:id/diff as +/- lines; long unchanged runs are folded. */
export function renderDiff(h, diff) {
  const root = h('div', { class: 'ai-diff', role: 'table', 'aria-label': 'Changes' })
  const CTX = 3
  const row = (kind, text) => h('div', { class: `ai-diff-line ai-diff-${kind}`, role: 'row' },
    h('span', { class: 'ai-diff-sign', 'aria-hidden': 'true' }, kind === 'add' ? '+' : kind === 'del' ? '-' : ' '),
    h('span', { class: 'ai-diff-text', role: 'cell' }, text === '' ? '​' : text))
  diff.hunks.forEach((hk, idx) => {
    if (hk.type !== 'eq' || hk.lines.length <= CTX * 2 + 2) { hk.lines.forEach((l) => root.append(row(hk.type, l))); return }
    const first = idx === 0
    const last = idx === diff.hunks.length - 1
    if (!first) hk.lines.slice(0, CTX).forEach((l) => root.append(row('eq', l)))
    const hidden = hk.lines.length - (first ? 0 : CTX) - (last ? 0 : CTX)
    const folded = hk.lines.slice(first ? 0 : CTX, last ? hk.lines.length : hk.lines.length - CTX)
    const btn = h('button', { type: 'button', class: 'ai-diff-fold', 'aria-expanded': 'false' }, `${hidden} unchanged line${hidden === 1 ? '' : 's'}`)
    btn.addEventListener('click', () => { btn.replaceWith(...folded.map((l) => row('eq', l))) })
    root.append(btn)
    if (!last) hk.lines.slice(-CTX).forEach((l) => root.append(row('eq', l)))
  })
  if (!diff.hunks.some((x) => x.type !== 'eq')) root.append(h('p', { class: 'ai-muted ai-diff-same' }, 'These versions are identical.'))
  return root
}

/* ------------------------------------------------------------------------------------------ share dialog */

/** Dialog to create / copy / revoke public read-only links for a conversation or an artifact. */
export function openShareDialog(lib, { kind, targetId, title, body: createBody = {}, what }) {
  const { h, api, toast } = lib
  openDialog(h, {
    title: `Share ${what ?? kind}`,
    build(body) {
      const list = h('ul', { class: 'ai-share-list' })
      const status = h('p', { class: 'ai-muted', role: 'status' })
      const refresh = async () => {
        const { shares } = await api('GET', `/api/ai/shares?kind=${kind}&targetId=${encodeURIComponent(targetId)}`)
        list.replaceChildren(...shares.map((s) => {
          const url = `${location.origin}${s.url}`
          return h('li', { class: 'ai-share-item' },
            h('input', { class: 'ai-share-url', readonly: true, value: url, 'aria-label': 'Share link', onfocus: (e) => e.target.select() }),
            h('div', { class: 'ai-row' },
              h('button', { type: 'button', class: 'ai-btn', onclick: async () => { toast((await copyText(url)) ? 'Link copied' : 'Copy failed: select the link and copy it', 'info') } }, icon('copy', 14), ' Copy'),
              h('button', { type: 'button', class: 'ai-btn ai-btn-danger', onclick: async () => {
                if (!(await lib.confirmDialog('Revoke this link? Anyone who has it will lose access immediately.', 'Revoke'))) return
                try { await api('DELETE', `/api/ai/shares/${encodeURIComponent(s.token)}`); toast('Link revoked'); await refresh() } catch (e) { toast(e.message, 'error') }
              } }, 'Revoke'),
              h('small', { class: 'ai-muted' }, `created ${relTime(s.createdAt)}`)))
        }))
        status.textContent = shares.length ? '' : 'No active links yet.'
      }
      body.append(
        h('p', {}, `Anyone with a link can read a read-only snapshot of this ${what ?? kind}${kind === 'conversation' ? ' (the messages on the branch you are viewing right now)' : ' version'}. They need no account. Revoking a link takes effect immediately.`),
        h('button', { type: 'button', class: 'ai-btn ai-btn-primary', onclick: async (e) => {
          const btn = e.currentTarget; btn.disabled = true
          try { await api('POST', `/api/${kind === 'conversation' ? 'conversations' : 'artifacts'}/${encodeURIComponent(targetId)}/share`, createBody); await refresh() } catch (err) { toast(err.message, 'error') } finally { btn.disabled = false }
        } }, icon('link', 14), ' Create link'),
        status, list)
      refresh().catch((e) => { status.textContent = e.message })
    },
  })
}

/* ------------------------------------------------------------------------------------------ artifact viewer */

const filenameFrom = (res, fallback) => {
  const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')
  if (!m) return fallback
  try { return decodeURIComponent(m[1]) } catch { return fallback }
}

/**
 * The artifact viewer: preview / code / diff tabs, version selector with restore, manual editing (saved as a new version),
 * copy, download, public share links. Used by the chat side panel and by the Artifacts page.
 *   const v = artifactViewer(lib, { onClose, onChange, onDelete }); parent.append(v.el); await v.show(artifactId)
 */
export function artifactViewer(lib, { onClose, onChange, onDelete } = {}) {
  const { h, api, toast } = lib
  const root = h('section', { class: 'ai-av', 'aria-label': 'Artifact' })
  let art = null // full artifact (current version)
  let viewing = null // { version, content, at, note, current }
  let tab = 'preview'
  let editing = false
  let gen = 0 // guards against late responses after a newer show()
  let objectUrl = null

  const revoke = () => { if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null } }
  const type = () => art?.type ?? 'code'

  async function show(id, { version, keepTab } = {}) {
    const mine = ++gen
    root.classList.add('ai-av-busy')
    try {
      const full = await api('GET', `/api/artifacts/${encodeURIComponent(id)}`)
      if (mine !== gen) return
      art = full
      editing = false
      if (!keepTab) tab = ['html', 'svg', 'markdown'].includes(full.type) ? 'preview' : 'code'
      await pick(version ?? full.version, mine)
    } catch (e) {
      if (mine !== gen) return
      art = null
      root.replaceChildren(h('div', { class: 'ai-av-empty' }, h('p', { class: 'ai-error' }, e.message), onClose ? h('button', { type: 'button', class: 'ai-btn', onclick: onClose }, 'Close') : null))
    } finally { if (mine === gen) root.classList.remove('ai-av-busy') }
  }
  async function pick(version, mine = gen) {
    if (!art) return
    if (version === art.version) viewing = { version, content: art.content, at: art.updatedAt, current: true }
    else {
      const v = await api('GET', `/api/artifacts/${encodeURIComponent(art.id)}/versions/${version}`)
      if (mine !== gen) return
      viewing = { version, content: v.content, at: v.at, note: v.note, current: v.current }
    }
    draw()
  }

  function draw() {
    revoke()
    if (!art || !viewing) return
    const richTabs = ['preview', 'code'].concat(art.versionCount > 1 ? ['changes'] : [])
    if (!richTabs.includes(tab)) tab = 'preview'
    const versionSelect = h('select', { class: 'ai-select', 'aria-label': 'Version', onchange: (e) => pick(Number(e.target.value)).catch((err) => toast(err.message, 'error')) },
      h('option', { value: String(art.version), selected: viewing.version === art.version || null }, `v${art.version} (current)`),
      ...[...art.versions].reverse().map((v) => h('option', { value: String(v.version), selected: viewing.version === v.version || null }, `v${v.version} · ${relTime(v.at)}${v.note ? ` · ${v.note}` : ''}`)))
    const tabBtn = (id, label, ic) => h('button', {
      type: 'button', role: 'tab', class: `ai-tab${tab === id ? ' ai-tab-on' : ''}`, 'aria-selected': String(tab === id), onclick: () => { editing = false; tab = id; draw() },
    }, icon(ic, 14), ' ', label)
    const head = h('header', { class: 'ai-av-head' },
      h('div', { class: 'ai-av-titles' },
        h('h2', { class: 'ai-av-title', title: art.title }, art.title),
        h('div', { class: 'ai-av-sub' }, h('span', { class: `ai-chip ai-chip-${art.type}` }, typeLabel(art.type)), art.language && art.language !== 'text' && art.language !== art.type ? h('span', { class: 'ai-muted' }, art.language) : null,
          h('span', { class: 'ai-muted' }, `${fmtSize(art.size)} · updated ${relTime(art.updatedAt)}`))),
      h('div', { class: 'ai-av-tools' }, versionSelect,
        iconButton(h, 'copy', 'Copy to clipboard', async () => { toast((await copyText(viewing.content)) ? 'Copied' : 'Copy failed') }),
        iconButton(h, 'download', 'Download', () => download().catch((e) => toast(e.message, 'error'))),
        iconButton(h, 'share', 'Share a public link', () => openShareDialog(lib, { kind: 'artifact', targetId: art.id, title: art.title, body: { version: viewing.version }, what: `artifact (v${viewing.version})` })),
        iconButton(h, 'more', 'More actions', (e) => openMenu(h, e.currentTarget, [
          { label: 'Rename', icon: 'edit', onclick: rename },
          { label: viewing.current ? 'Edit content' : 'Edit (current version only)', icon: 'code', disabled: !viewing.current, onclick: () => { editing = true; tab = 'code'; draw() } },
          'sep',
          { label: 'Delete artifact', icon: 'trash', danger: true, onclick: remove },
        ])),
        onClose ? iconButton(h, 'x', 'Close artifact', onClose, { cls: 'ai-av-close' }) : null))
    const tabs = h('div', { class: 'ai-tabs', role: 'tablist', 'aria-label': 'View' }, tabBtn('preview', 'Preview', 'eye'), tabBtn('code', 'Code', 'code'), art.versionCount > 1 ? tabBtn('changes', 'Changes', 'diff') : null)
    const banner = viewing.current ? null : h('div', { class: 'ai-banner ai-banner-warn' }, h('span', {}, `You are looking at version ${viewing.version}${viewing.note ? ` (${viewing.note})` : ''}, not the latest.`),
      h('button', { type: 'button', class: 'ai-btn', onclick: restore }, icon('history', 14), ` Restore v${viewing.version}`))
    const panel = h('div', { class: 'ai-av-body', role: 'tabpanel' })
    root.replaceChildren(...[head, tabs, banner, panel].filter(Boolean))
    if (editing) drawEditor(panel)
    else if (tab === 'preview') drawPreview(panel)
    else if (tab === 'code') panel.append(renderCode(viewing.content, art.language === 'text' ? (art.type === 'code' ? '' : art.type) : art.language, { title: null }))
    else drawChanges(panel).catch((e) => panel.replaceChildren(h('p', { class: 'ai-error' }, e.message)))
  }

  function drawPreview(panel) {
    const content = viewing.content
    if (type() === 'html') {
      panel.append(previewFrame(h, {
        html: content, title: `Preview of ${art.title}`,
        loadUrl: async () => (await api('POST', `/api/artifacts/${encodeURIComponent(art.id)}/preview`, { version: viewing.version })).url,
      }))
    } else if (type() === 'svg') {
      objectUrl = URL.createObjectURL(new Blob([content], { type: 'image/svg+xml' }))
      panel.append(h('div', { class: 'ai-svg-wrap' }, h('img', { class: 'ai-svg', src: objectUrl, alt: art.title })),
        h('p', { class: 'ai-frame-note' }, icon('info', 13), ' Shown as an image: scripts inside an SVG never run.'))
    } else if (type() === 'markdown') {
      panel.append(h('div', { class: 'ai-md ai-md-doc' }, renderMarkdown(content)))
    } else panel.append(renderCode(content, art.language === 'text' ? '' : art.language))
  }

  function drawEditor(panel) {
    const ta = h('textarea', { class: 'ai-editor', spellcheck: 'false', 'aria-label': 'Artifact content', maxlength: '262144' })
    ta.value = viewing.content
    const msg = h('p', { class: 'ai-error', role: 'alert' })
    panel.append(ta, msg, h('div', { class: 'ai-row' },
      h('button', { type: 'button', class: 'ai-btn ai-btn-primary', onclick: async (e) => {
        const btn = e.currentTarget; btn.disabled = true
        try {
          const saved = await api('PUT', `/api/artifacts/${encodeURIComponent(art.id)}`, { content: ta.value, note: 'Edited manually' })
          art = saved
          editing = false
          viewing = { version: saved.version, content: saved.content, at: saved.updatedAt, current: true }
          toast(saved.version === viewing.version ? 'Saved as a new version' : 'Saved')
          draw()
          onChange?.(saved)
        } catch (err) { msg.textContent = err.message; btn.disabled = false }
      } }, 'Save as new version'),
      h('button', { type: 'button', class: 'ai-btn', onclick: () => { editing = false; draw() } }, 'Cancel'),
      h('small', { class: 'ai-muted' }, 'Saving keeps the previous content in the version history.')))
    setTimeout(() => ta.focus(), 0)
  }

  async function drawChanges(panel) {
    const versions = [art.version, ...[...art.versions].reverse().map((v) => v.version)] // newest first
    const idx = versions.indexOf(viewing.version)
    const olderOptions = versions.slice(idx + 1)
    if (!olderOptions.length) { panel.append(h('p', { class: 'ai-muted' }, 'This is the first version: there is nothing earlier to compare with.')); return }
    const holder = h('div', { class: 'ai-diff-holder' })
    const stats = h('p', { class: 'ai-muted', role: 'status' })
    const fromSel = h('select', { class: 'ai-select', 'aria-label': 'Compare with', onchange: () => load(Number(fromSel.value)) },
      ...olderOptions.map((v) => h('option', { value: String(v) }, `v${v}`)))
    panel.append(h('div', { class: 'ai-row' }, h('label', { class: 'ai-muted' }, `Changes in v${viewing.version} compared with `), fromSel), stats, holder)
    async function load(from) {
      const d = await api('GET', `/api/artifacts/${encodeURIComponent(art.id)}/diff?from=${from}&to=${viewing.version}`)
      stats.textContent = `+${d.stats.added} added, -${d.stats.removed} removed${d.exact ? '' : ' (very large change: shown as full replacement)'}`
      holder.replaceChildren(renderDiff(h, d))
    }
    await load(olderOptions[0])
  }

  async function download() {
    const res = await api('GET', `/api/artifacts/${encodeURIComponent(art.id)}/download?version=${viewing.version}`, undefined, { response: true })
    if (!res.ok) throw new Error('Download failed')
    lib.download(await res.blob(), filenameFrom(res, `${art.title}.txt`))
  }
  async function rename() {
    const name = await lib.promptDialog('Rename artifact', art.title, { okLabel: 'Rename' })
    if (!name || !name.trim() || name === art.title) return
    try { art = await api('PUT', `/api/artifacts/${encodeURIComponent(art.id)}`, { content: art.content, title: name.trim() }); draw(); onChange?.(art) } catch (e) { toast(e.message, 'error') }
  }
  async function restore() {
    try {
      art = await api('POST', `/api/artifacts/${encodeURIComponent(art.id)}/restore`, { version: viewing.version })
      toast(`Restored as v${art.version}`)
      await pick(art.version)
      onChange?.(art)
    } catch (e) { toast(e.message, 'error') }
  }
  async function remove() {
    if (!(await lib.confirmDialog(`Delete "${art.title}" and all its versions? Public links to it stop working.`, 'Delete'))) return
    try { await api('DELETE', `/api/artifacts/${encodeURIComponent(art.id)}`); const id = art.id; art = null; root.replaceChildren(); onDelete?.(id) } catch (e) { toast(e.message, 'error') }
  }

  return {
    el: root,
    show,
    get id() { return art?.id ?? null },
    destroy() { gen++; revoke(); root.remove() },
  }
}

/* ------------------------------------------------------------------------------------------ Artifacts page */

let page = null
async function renderPage(el, arg, lib) {
  page?.destroy?.()
  const { h, api, toast } = lib
  const state = { q: pref.get('art.q', '') ?? '', type: pref.get('art.type', '') ?? '', items: [], next: null }
  const list = h('ul', { class: 'ai-art-list' })
  const more = h('button', { type: 'button', class: 'ai-btn ai-art-more', hidden: true }, 'Load more')
  const count = h('p', { class: 'ai-muted', role: 'status' })
  let selected = arg ?? null
  const viewer = artifactViewer(lib, {
    onClose: () => { selected = null; history.replaceState(null, '', '#artifacts'); root.dataset.view = 'list' },
    onChange: (a) => { const i = state.items.findIndex((x) => x.id === a.id); if (i >= 0) state.items[i] = { ...state.items[i], ...a, preview: undefined }; drawList() },
    onDelete: (id) => { state.items = state.items.filter((x) => x.id !== id); selected = null; history.replaceState(null, '', '#artifacts'); root.dataset.view = 'list'; drawList() },
  })
  const empty = h('div', { class: 'ai-av-empty' }, icon('code', 28), h('p', {}, 'Select an artifact to view it.'),
    h('p', { class: 'ai-muted' }, 'Artifacts are created when the assistant produces a document, web page, SVG or a longer piece of code in a chat. You can also edit them here; every change is kept as a version.'))
  const search = h('input', { type: 'search', class: 'ai-input', placeholder: 'Search artifacts', 'aria-label': 'Search artifacts by title', value: state.q })
  const typeSel = h('select', { class: 'ai-select', 'aria-label': 'Filter by type' }, h('option', { value: '' }, 'All types'), ...Object.entries(TYPE_LABEL).map(([v, l]) => h('option', { value: v, selected: state.type === v || null }, l)))
  const root = h('div', { class: 'ai-page ai-art-page', 'data-view': selected ? 'viewer' : 'list' },
    h('aside', { class: 'ai-art-side', 'aria-label': 'Artifacts' },
      h('h1', { class: 'ai-page-title' }, 'Artifacts'),
      h('div', { class: 'ai-row' }, search, typeSel), count, list, more),
    h('section', { class: 'ai-art-main' },
      h('button', { type: 'button', class: 'ai-btn ai-art-back', onclick: () => { root.dataset.view = 'list'; history.replaceState(null, '', '#artifacts') } }, icon('left', 14), ' All artifacts'),
      empty, viewer.el))
  viewer.el.hidden = true

  function drawList() {
    list.replaceChildren(...state.items.map((a) => h('li', {}, h('a', {
      class: `ai-art-item${a.id === selected ? ' ai-art-on' : ''}`, href: `#artifacts/${encodeURIComponent(a.id)}`, 'aria-current': a.id === selected ? 'true' : null,
      onclick: (e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) return; e.preventDefault(); open(a.id) },
    }, h('span', { class: 'ai-art-title' }, a.title), h('span', { class: 'ai-art-meta' }, h('span', { class: `ai-chip ai-chip-${a.type}` }, typeLabel(a.type)), h('span', { class: 'ai-muted' }, `v${a.version} · ${relTime(a.updatedAt)}`))))))
    more.hidden = !state.next
    count.textContent = state.items.length ? '' : (state.q || state.type ? 'No artifacts match.' : 'No artifacts yet.')
  }
  async function load(append = false) {
    const params = new URLSearchParams({ limit: '50' })
    if (state.q) params.set('q', state.q)
    if (state.type) params.set('type', state.type)
    if (append && state.next) params.set('cursor', state.next)
    const r = await api('GET', `/api/artifacts?${params}`)
    state.items = append ? [...state.items, ...r.artifacts] : r.artifacts
    state.next = r.nextCursor
    drawList()
  }
  async function open(id) {
    selected = id
    history.replaceState(null, '', `#artifacts/${encodeURIComponent(id)}`)
    root.dataset.view = 'viewer'
    empty.hidden = true
    viewer.el.hidden = false
    drawList()
    await viewer.show(id)
  }
  let timer
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = search.value.trim(); pref.set('art.q', state.q); load().catch((e) => toast(e.message, 'error')) }, 250) })
  typeSel.addEventListener('change', () => { state.type = typeSel.value; pref.set('art.type', state.type); load().catch((e) => toast(e.message, 'error')) })
  more.addEventListener('click', () => load(true).catch((e) => toast(e.message, 'error')))
  el.append(root)
  page = { destroy() { clearTimeout(timer); viewer.destroy() } }
  await load()
  if (selected) await open(selected)
}

export default [
  { id: 'artifacts', title: 'Artifacts', group: 'AI', order: 30, render: renderPage },
]
