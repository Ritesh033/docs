// RD Cloude console shell: auth, navigation, command palette, theme, notifications, mobile drawer.
// Every view is a UI module (public/ui/*.js) that default-exports {id,title,group,order,render(el,arg,lib)} (or an array of them)
// and is discovered through GET /api/ui-modules; see docs/ui.md. The shell itself renders no service views.
import { lib, h, api, toast, state, getTheme, setTheme, fmtRelative } from '/lib.js'
import { icon } from '/icons.js'

const $ = (s) => document.querySelector(s)
const registry = new Map()
const GROUP_ORDER = ['Overview', 'AI', 'Cloud', 'Account']
const narrow = window.matchMedia('(max-width: 860px)')
let mode = 'login'
let challenge = null
let modulesLoaded = false
let booted = false

/* ================================================================================================ UI module loading */
async function loadUiModules() {
  if (modulesLoaded) return
  let names = []
  try {
    const r = await api('GET', '/api/ui-modules')
    names = r.modules
    for (const css of r.styles ?? []) document.head.append(h('link', { rel: 'stylesheet', href: '/ui/' + css }))
  } catch (e) { console.error('Could not list UI modules:', e); return }
  await Promise.all(names.map(async (n) => {
    try {
      const m = await import('/ui/' + n)
      for (const v of [m.default].flat().filter(Boolean)) registry.set(v.id, { order: 100, group: 'Cloud', ...v })
    } catch (e) { console.error('UI module failed:', n, e) }
  }))
  modulesLoaded = registry.size > 0
}

const visibleViews = () => [...registry.values()].filter((v) => !v.hidden)
const byOrder = (a, b) => a.order - b.order || a.title.localeCompare(b.title)

/* ================================================================================================ navigation */
function buildNav() {
  const nav = $('#nav')
  nav.replaceChildren()
  const views = visibleViews()
  const groups = [...new Set([...GROUP_ORDER, ...views.map((v) => v.group)])]
  for (const g of groups) {
    const items = views.filter((v) => v.group === g).sort(byOrder)
    if (!items.length) continue
    nav.append(h('small', { id: `nav-g-${g.toLowerCase()}` }, g))
    for (const v of items) nav.append(h('a', { href: `#${v.id}`, 'data-view': v.id, onclick: () => closeNav(false) }, icon(v.icon ?? v.id), h('span', {}, v.title)))
  }
}

let routeSeq = 0
async function route({ focus = true } = {}) {
  if (!state.token) return
  const seq = ++routeSeq
  const [rawName, ...rest] = (location.hash.slice(1) || 'home').split('/')
  const name = rawName || 'home'
  const arg = rest.join('/') || undefined
  const view = registry.get(name)
  document.title = `${view?.title ?? 'Not found'} · RD Cloude`
  for (const a of document.querySelectorAll('#nav a')) {
    const on = a.dataset.view === name
    a.classList.toggle('on', on)
    on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')
  }
  // A fresh <main> per navigation: a slow render from the previous page can only write into the detached old one,
  // and plugins that poll can stop themselves with `root.isConnected`.
  const el = h('main', { id: 'view', tabindex: '-1', 'aria-label': view?.title ?? 'Not found' })
  $('#view').replaceWith(el)
  if (focus) { el.focus({ preventScroll: true }); window.scrollTo(0, 0) }
  if (!view) {
    el.append(h('div', { class: 'empty' }, h('h3', {}, 'Page not found'), h('p', {}, registry.size ? `There is no page called “${name}”.` : 'The console modules did not load.'),
      h('a', { href: '#home' }, 'Go to the overview')))
    return
  }
  const loading = h('div', { class: 'view-loading', role: 'status' }, lib.spinner('Loading'), ' Loading…')
  const timer = setTimeout(() => seq === routeSeq && el.append(loading), 250)
  try { await view.render(el, arg, lib) } catch (e) {
    if (seq === routeSeq) el.append(h('div', { class: 'empty' }, h('h3', {}, 'Something went wrong'), h('p', { class: 'err' }, e.message), h('button', { class: 'sec', onclick: () => route({ focus: false }) }, 'Try again')))
    console.error(`View "${name}" failed:`, e)
  } finally { clearTimeout(timer); loading.remove() }
}
window.addEventListener('rd:rerender', () => route({ focus: false }))
addEventListener('hashchange', () => route())

/* ================================================================================================ mobile drawer */
let navReturnFocus = null
function openNav() {
  if (!narrow.matches) return
  navReturnFocus = document.activeElement
  document.body.classList.add('nav-open')
  $('#scrim').hidden = false
  $('#menuBtn').setAttribute('aria-expanded', 'true')
  $('#nav a')?.focus()
}
function closeNav(restoreFocus = true) {
  if (!document.body.classList.contains('nav-open')) return
  document.body.classList.remove('nav-open')
  $('#scrim').hidden = true
  $('#menuBtn').setAttribute('aria-expanded', 'false')
  if (restoreFocus) (navReturnFocus ?? $('#menuBtn')).focus?.()
}
narrow.addEventListener('change', () => { if (!narrow.matches) closeNav(false) })

/* ================================================================================================ popovers (notifications, account) */
const popovers = []
function closePopovers(except) {
  for (const p of popovers) if (p !== except && !p.panel.hidden) { p.panel.hidden = true; p.btn.setAttribute('aria-expanded', 'false') }
}
function makePopover(btn, panel, onOpen) {
  const p = { btn, panel }
  popovers.push(p)
  btn.addEventListener('click', () => {
    const open = panel.hidden
    closePopovers(p)
    panel.hidden = !open
    btn.setAttribute('aria-expanded', String(open))
    if (open) onOpen?.()
  })
  btn.parentElement.addEventListener('focusout', (e) => { if (e.relatedTarget && !btn.parentElement.contains(e.relatedTarget)) closePopovers() })
  return p
}
document.addEventListener('click', (e) => { if (!e.target.closest?.('.menu-wrap')) closePopovers() })

/* ================================================================================================ theme */
const THEME_NEXT = { auto: 'light', light: 'dark', dark: 'auto' }
const THEME_LABEL = { auto: 'System', light: 'Light', dark: 'Dark' }
function paintThemeButton() {
  const t = getTheme()
  $('#themeBtn').replaceChildren(icon(t === 'auto' ? 'auto' : t === 'light' ? 'sun' : 'moon'))
  $('#themeBtn').setAttribute('aria-label', `Theme: ${THEME_LABEL[t]}. Activate to switch to ${THEME_LABEL[THEME_NEXT[t]]}.`)
  $('#themeBtn').title = `Theme: ${THEME_LABEL[t]}`
}
window.addEventListener('rd:theme', paintThemeButton)

/* ================================================================================================ notifications bell */
let notePoll = null
async function loadNotes({ render = false } = {}) {
  if (!state.token) return
  try {
    const r = await api('GET', '/api/notifications?limit=10')
    const dot = $('#bellDot')
    if (dot) { dot.hidden = !r.unread; dot.textContent = r.unread > 99 ? '99+' : String(r.unread) }
    $('#bellBtn').setAttribute('aria-label', r.unread ? `Notifications, ${r.unread} unread` : 'Notifications')
    if (render || !$('#bellPanel').hidden) paintNotes(r)
  } catch { /* the offline banner covers connectivity; auth errors reload the page */ }
}
function paintNotes(r) {
  const panel = $('#bellPanel')
  const safeLink = (l) => (typeof l === 'string' && /^#[\w/-]*$/.test(l) ? l : null)
  panel.replaceChildren(
    h('h3', {}, 'Notifications'),
    r.notifications.length
      ? h('div', { class: 'notes' }, ...r.notifications.map((n) => {
        const link = safeLink(n.link)
        const body = [h('b', {}, n.title), n.body ? h('span', {}, n.body) : null, h('span', {}, fmtRelative(n.createdAt))]
        const open = () => { closePopovers(); if (!n.read) api('POST', '/api/notifications/read', { ids: [n.id] }).then(() => loadNotes()).catch(() => {}) }
        return link ? h('a', { class: `note-item${n.read ? '' : ' unread'}`, href: link, onclick: open }, ...body)
          : h('div', { class: `note-item${n.read ? '' : ' unread'}`, tabindex: '0', onclick: open, onkeydown: (e) => e.key === 'Enter' && open() }, ...body)
      }))
      : h('p', { class: 'muted pmeta' }, 'You are all caught up.'),
    h('div', { class: 'pfoot' },
      h('button', { class: 'link', disabled: r.unread ? null : true, onclick: async () => { await api('POST', '/api/notifications/read', { all: true }).catch((e) => toast(e.message, 'error')); loadNotes({ render: true }) } }, 'Mark all read'),
      h('a', { href: '#usage', onclick: () => closePopovers() }, 'Billing')),
  )
}
function startPolling() {
  stopPolling()
  loadNotes()
  notePoll = setInterval(() => { if (!document.hidden) loadNotes() }, 60000)
}
function stopPolling() { clearInterval(notePoll); notePoll = null }
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.token && booted) loadNotes() })

/* ================================================================================================ account menu */
async function loadMe() {
  try {
    const { user } = await api('GET', '/api/me')
    state.me = user
    const label = user.name || user.email || '?'
    $('#userBtn').replaceChildren(h('span', { class: 'avatar' }, label.trim().charAt(0) || '?'))
    $('#userBtn').setAttribute('aria-label', `Account menu for ${user.email}`)
    $('#userPanel').replaceChildren(
      h('div', { class: 'pmeta' }, h('b', {}, user.name || user.email), h('br'), user.name ? user.email : ''),
      h('a', { class: 'pitem', role: 'menuitem', href: '#settings', onclick: () => closePopovers() }, 'Settings'),
      h('a', { class: 'pitem', role: 'menuitem', href: '#security', onclick: () => closePopovers() }, 'Security'),
      h('button', { class: 'pitem', role: 'menuitem', id: 'logout', onclick: () => signOut() }, 'Sign out'))
    window.dispatchEvent(new CustomEvent('rd:me', { detail: user }))
  } catch { /* shell still works without it */ }
}

async function signOut() {
  closePopovers(); closeNav(false); closePalette()
  try { await api('POST', '/api/auth/logout') } catch { /* token may already be invalid */ }
  try { localStorage.removeItem('rd_token') } catch { /* ignore */ }
  state.token = null; state.me = null
  stopPolling()
  $('#view').replaceChildren()   // do not leave account data in the hidden DOM
  history.replaceState(null, '', location.pathname)
  boot()
}

/* ================================================================================================ command palette */
const fuzzy = (q, text) => {
  if (!q) return 1
  const t = text.toLowerCase()
  let qi = 0, score = 0, last = -2
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) { score += i === 0 || t[i - 1] === ' ' ? 8 : last === i - 1 ? 5 : 1; last = i; qi++ }
  }
  return qi === q.length ? score - t.length * 0.01 : 0
}
function paletteItems() {
  const go = (id) => () => { location.hash = `#${id}` }
  const items = visibleViews().sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || byOrder(a, b))
    .map((v) => ({ label: v.title, kind: v.group, icon: v.icon ?? v.id, keywords: v.keywords ?? '', run: go(v.id) }))
  const cur = getTheme()
  for (const t of ['auto', 'light', 'dark']) if (t !== cur) items.push({ label: `Theme: ${THEME_LABEL[t]}`, kind: 'Action', icon: t === 'auto' ? 'auto' : t === 'light' ? 'sun' : 'moon', keywords: 'appearance dark light mode', run: () => setTheme(t) })
  items.push(
    { label: 'Notifications', kind: 'Action', icon: 'bell', keywords: 'inbox alerts', run: () => { $('#bellBtn').click(); $('#bellBtn').focus() } },
    { label: 'Refresh this page', kind: 'Action', icon: 'action', keywords: 'reload', run: () => route({ focus: false }) },
    { label: 'Sign out', kind: 'Action', icon: 'logout', keywords: 'log out', run: signOut },
  )
  return items
}
let palette = null
function openPalette() {
  if (palette || !state.token || $('#app').hidden) return
  closePopovers(); closeNav(false)
  const items = paletteItems()
  let shown = [], sel = 0
  const input = h('input', { class: 'pal-in', type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pal-list', 'aria-autocomplete': 'list', 'aria-label': 'Search pages and actions', placeholder: 'Jump to a page or run an action…', autocomplete: 'off', spellcheck: 'false' })
  const list = h('ul', { class: 'pal-list', id: 'pal-list', role: 'listbox', 'aria-label': 'Results' })
  const dlg = h('dialog', { class: 'palette', 'aria-label': 'Command palette' }, input, list,
    h('div', { class: 'pal-foot' }, h('span', {}, h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), ' navigate'), h('span', {}, h('kbd', {}, 'Enter'), ' open'), h('span', {}, h('kbd', {}, 'Esc'), ' close')))
  const run = (it) => { closePalette(); it.run() }
  const paint = () => {
    list.replaceChildren(...(shown.length ? shown.map((it, i) => h('li', { class: 'pal-item', id: `pal-${i}`, role: 'option', 'aria-selected': String(i === sel), onclick: () => run(it), onmousemove: () => { if (sel !== i) { sel = i; paint() } } },
      icon(it.icon), h('span', {}, it.label), h('span', { class: 'kind' }, it.kind))) : [h('li', { class: 'pal-empty', role: 'presentation' }, 'No matches')]))
    input.setAttribute('aria-activedescendant', shown.length ? `pal-${sel}` : '')
    list.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' })
  }
  const filter = () => {
    const q = input.value.trim().toLowerCase()
    shown = (q ? items.map((it) => ({ it, s: Math.max(fuzzy(q, it.label), fuzzy(q, `${it.kind} ${it.label}`) * 0.6, fuzzy(q, it.keywords) * 0.5) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.it) : items).slice(0, 40)
    sel = 0; paint()
  }
  input.addEventListener('input', filter)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); paint() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paint() }
    else if (e.key === 'Home') { e.preventDefault(); sel = 0; paint() }
    else if (e.key === 'End') { e.preventDefault(); sel = Math.max(0, shown.length - 1); paint() }
    else if (e.key === 'Enter' && shown[sel]) { e.preventDefault(); run(shown[sel]) }
  })
  dlg.addEventListener('close', closePalette)
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closePalette() })
  const prev = document.activeElement
  palette = { dlg, prev }
  document.body.append(dlg)
  dlg.showModal()
  filter()
  input.focus()
}
function closePalette() {
  if (!palette) return
  const { dlg, prev } = palette
  palette = null
  if (dlg.open) dlg.close()
  dlg.remove()
  if (prev && document.contains(prev) && !prev.closest?.('#view')) prev.focus?.()
}
addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
    if (!state.token || $('#app').hidden) return
    e.preventDefault()
    palette ? closePalette() : openPalette()
  } else if (e.key === 'Escape' && !palette && popovers.some((p) => !p.panel.hidden)) {
    const open = popovers.find((p) => !p.panel.hidden)
    closePopovers(); open.btn.focus()
  } else if (e.key === 'Escape' && document.body.classList.contains('nav-open') && !palette) closeNav()
  else if (e.key === 'Tab' && document.body.classList.contains('nav-open')) {   // focus trap while the drawer is open
    const f = [...document.querySelectorAll('#nav a, #menuBtn')].filter((x) => x.offsetParent !== null)
    if (!f.length) return
    const first = f[0], last = f.at(-1)
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }
})

/* ================================================================================================ connectivity */
function paintOffline(down) { $('#offline').hidden = !down }
window.addEventListener('rd:network', (e) => paintOffline(!e.detail.ok))
window.addEventListener('offline', () => paintOffline(true))
window.addEventListener('online', () => paintOffline(false))

/* ================================================================================================ sign-in / register */
function paintAuthMode() {
  const login = mode === 'login'
  $('#authTitle').textContent = login ? 'Sign in' : 'Create your account'
  $('#authForm button[type=submit]').textContent = login ? 'Sign in' : 'Create account'
  $('#toggleMode').textContent = login ? 'Create an account' : 'Have an account? Sign in'
  $('#authForm [name=password]').setAttribute('autocomplete', login ? 'current-password' : 'new-password')
  $('#pwHint').hidden = login
}
function resetChallenge() { challenge = null; $('#codeLabel').hidden = true; $('#codeField').hidden = true; $('#codeField').value = '' }
$('#toggleMode').onclick = () => { mode = mode === 'login' ? 'register' : 'login'; resetChallenge(); $('#authErr').textContent = ''; paintAuthMode() }
$('#authForm').onsubmit = async (e) => {
  e.preventDefault()
  const f = new FormData(e.target)
  const btn = e.target.querySelector('button[type=submit]')
  $('#authErr').textContent = ''
  btn.disabled = true
  try {
    const r = challenge
      ? await api('POST', '/api/auth/login/2fa', { challenge, code: String(f.get('code') ?? '').trim() })
      : await api('POST', `/api/auth/${mode}`, { email: f.get('email'), password: f.get('password') })
    resetChallenge()
    e.target.reset()
    state.token = r.token
    try { localStorage.setItem('rd_token', r.token) } catch { /* private mode: session lasts for this tab only */ }
    if (r.warnings?.length) toast(r.warnings.join(' '), 'info')
    await boot()
  } catch (err) {
    if (err.data?.twoFactorRequired) {
      challenge = err.data.challenge
      $('#codeLabel').hidden = false; $('#codeField').hidden = false; $('#codeField').focus()
      $('#authErr').textContent = 'Enter the code from your authenticator app (or a recovery code).'
    } else $('#authErr').textContent = err.message
  } finally { btn.disabled = false }
}

/* ================================================================================================ boot */
async function boot() {
  const authed = !!state.token
  $('#auth').hidden = authed
  $('#app').hidden = !authed
  if (!authed) { document.title = 'Sign in · RD Cloude'; booted = false; $('#authForm [name=email]').focus(); return }
  await loadUiModules()
  buildNav()
  if (!location.hash) history.replaceState(null, '', '#home')
  booted = true
  route({ focus: false })
  loadMe()
  startPolling()
}

function initChrome() {
  $('#menuBtn').append(icon('menu'))
  $('#menuBtn').addEventListener('click', () => (document.body.classList.contains('nav-open') ? closeNav() : openNav()))
  $('#scrim').addEventListener('click', () => closeNav())
  $('#paletteBtn').append(h('span', { class: 'l' }, icon('search'), h('span', {}, 'Search')), h('kbd', {}, /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'))
  $('#paletteBtn').addEventListener('click', openPalette)
  $('#bellBtn').append(icon('bell'), h('span', { class: 'dot', id: 'bellDot', hidden: true }))
  makePopover($('#bellBtn'), $('#bellPanel'), () => loadNotes({ render: true }))
  makePopover($('#userBtn'), $('#userPanel'))
  $('#userBtn').append(h('span', { class: 'avatar' }, '?'))
  $('#themeBtn').addEventListener('click', () => setTheme(THEME_NEXT[getTheme()]))
  paintThemeButton()
  $('#skip').addEventListener('click', (e) => { e.preventDefault(); $('#view').focus() })
  paintAuthMode()
  if (!navigator.onLine) paintOffline(true)
}
initChrome()
boot()
