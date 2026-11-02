// Chat: streaming conversations with branching, tools, attachments, search, artifacts side panel and the public share page.
// Backend: src/ai.js (docs/ai.md). Shared widgets live in /ui/artifacts.js. Replaces the built-in `chat` view (same id).
//
// Nothing here ever assigns HTML strings: user and model text reach the DOM through text nodes or renderMarkdown().
import { renderMarkdown, renderCode } from '/markdown.js'
import {
  artifactViewer, miniH, icon, iconButton, openDialog, openMenu, openShareDialog, highlighted, previewFrame, relTime, fmtSize, fmtTokens,
  copyText, pref, typeLabel,
} from '/ui/artifacts.js'

/* ================================================================================================ SSE client */

/**
 * POST a JSON body and read the Server-Sent-Events reply. onEvent(name, data) is called per event.
 * Resolves true when a `done` event was seen. A non-event-stream reply (validation error, 404, 429...) rejects with err.preflight = true.
 */
async function streamSse(url, token, body, { signal, onEvent }) {
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  })
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    let msg = res.statusText || `Request failed (${res.status})`
    try { const j = await res.json(); if (j?.error) msg = j.error } catch { /* not JSON */ }
    const err = new Error(msg)
    err.status = res.status
    err.preflight = true
    throw err
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let sawDone = false
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      let event = 'message'
      const data = []
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (!data.length) continue
      let payload
      try { payload = JSON.parse(data.join('\n')) } catch { continue }
      if (event === 'done') sawDone = true
      onEvent(event, payload)
    }
  }
  return sawDone
}

/* ================================================================================================ public share page */

async function renderSharePage(root) {
  const h = miniH
  const token = decodeURIComponent(location.pathname.replace(/^\/share\//, '').replace(/\/+$/, ''))
  const fail = (text) => root.replaceChildren(h('div', { class: 'ai-share-card' }, h('h1', { class: 'ai-share-title' }, 'Link unavailable'), h('p', {}, text), h('p', { class: 'ai-muted' }, 'RD Cloude')))
  let data
  try {
    const res = await fetch(`/api/shared/${encodeURIComponent(token)}`, { headers: { accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer' })
    if (res.status === 404) return fail('This link is invalid or has been revoked by its owner.')
    if (!res.ok) return fail('The shared content could not be loaded. Try again later.')
    data = await res.json()
  } catch { return fail('The shared content could not be loaded. Check your connection and try again.') }

  document.title = `${data.title} - RD Cloude`
  const foot = h('footer', { class: 'ai-share-foot ai-muted' }, 'Shared read-only from RD Cloude. AI-generated content can contain mistakes. ', h('a', { href: '/' }, 'Open RD Cloude'))
  if (data.kind === 'artifact') {
    const a = data.artifact
    let tab = ['html', 'svg', 'markdown'].includes(a.type) ? 'preview' : 'code'
    const body = h('div', { class: 'ai-share-body' })
    let svgUrl = null
    const draw = () => {
      if (svgUrl) { URL.revokeObjectURL(svgUrl); svgUrl = null }
      tabs.querySelectorAll('button').forEach((b) => { b.setAttribute('aria-selected', String(b.dataset.tab === tab)); b.classList.toggle('ai-tab-on', b.dataset.tab === tab) })
      body.replaceChildren()
      if (tab === 'code') body.append(renderCode(a.content, a.language === 'text' ? '' : a.language))
      else if (a.type === 'html') {
        body.append(previewFrame(h, {
          html: a.content, title: data.title,
          loadUrl: async () => { const r = await fetch(`/api/shared/${encodeURIComponent(token)}/preview`, { method: 'POST', credentials: 'omit' }); if (!r.ok) throw new Error('no preview'); return (await r.json()).url },
        }))
      } else if (a.type === 'svg') {
        svgUrl = URL.createObjectURL(new Blob([a.content], { type: 'image/svg+xml' }))
        body.append(h('div', { class: 'ai-svg-wrap' }, h('img', { class: 'ai-svg', src: svgUrl, alt: data.title })))
      } else if (a.type === 'markdown') body.append(h('div', { class: 'ai-md ai-md-doc' }, renderMarkdown(a.content)))
      else body.append(renderCode(a.content, a.language === 'text' ? '' : a.language))
    }
    const tabBtn = (id, label) => h('button', { type: 'button', role: 'tab', class: 'ai-tab', 'data-tab': id, onclick: () => { tab = id; draw() } }, label)
    const tabs = h('div', { class: 'ai-tabs', role: 'tablist', 'aria-label': 'View' }, tabBtn('preview', 'Preview'), tabBtn('code', 'Code'))
    root.replaceChildren(h('div', { class: 'ai-share-card' },
      h('header', { class: 'ai-share-head' }, h('h1', { class: 'ai-share-title' }, data.title), h('p', { class: 'ai-muted' }, `Shared ${typeLabel(a.type)} artifact, version ${a.version}, ${new Date(data.sharedAt).toLocaleDateString()}`)),
      tabs, body, foot))
    draw()
    return
  }
  root.replaceChildren(h('div', { class: 'ai-share-card' },
    h('header', { class: 'ai-share-head' }, h('h1', { class: 'ai-share-title' }, data.title), h('p', { class: 'ai-muted' }, `Shared conversation, ${new Date(data.sharedAt).toLocaleDateString()} · read-only snapshot`)),
    h('div', { class: 'ai-thread ai-share-thread' }, ...data.messages.map((m) => m.role === 'user'
      ? h('article', { class: 'ai-msg ai-msg-user' }, h('div', { class: 'ai-bubble' },
        m.attachments?.length ? h('ul', { class: 'ai-atts' }, ...m.attachments.map((a) => h('li', { class: 'ai-att' }, icon(a.type === 'image' ? 'image' : 'file', 14), h('span', { class: 'ai-att-name' }, a.name)))) : null,
        m.content ? h('div', { class: 'ai-user-text' }, m.content) : null))
      : h('article', { class: 'ai-msg ai-msg-assistant' }, h('header', { class: 'ai-msg-meta' }, h('span', { class: 'ai-avatar', 'aria-hidden': 'true' }, 'RD'), h('span', { class: 'ai-msg-who' }, 'RD Cloude'), m.model ? h('span', { class: 'ai-chip' }, m.model) : null),
        h('div', { class: 'ai-msg-body ai-md' }, renderMarkdown(m.content))))),
    foot))
}

const shareRoot = typeof document !== 'undefined' ? document.getElementById('ai-share-root') : null
if (shareRoot) renderSharePage(shareRoot)

/* ================================================================================================ chat view */

let modelsCache = null
async function getModels(api) {
  if (modelsCache && Date.now() - modelsCache.t < 60_000) return modelsCache.data
  const data = await api('GET', '/api/models')
  modelsCache = { t: Date.now(), data }
  return data
}

const SUGGESTIONS = [
  { icon: 'wrench', text: 'Calculate (23 * 7) + sqrt(144)' },
  { icon: 'history', text: 'What time is it in Europe/Paris?' },
  { icon: 'code', text: 'Make a small HTML demo page' },
  { icon: 'file', text: 'Write a Python example for Fibonacci numbers' },
]
const SHORTCUTS = [
  ['Enter', 'Send the message'], ['Shift + Enter', 'New line'], ['Esc', 'Stop the response, or close the open panel'],
  ['Ctrl/Cmd + K', 'Search your chats'], ['Ctrl/Cmd + Shift + O', 'Start a new chat'],
]
const DAY = 86_400_000
function bucketOf(iso) {
  const t = Date.parse(iso)
  const startToday = new Date().setHours(0, 0, 0, 0)
  if (t >= startToday) return 'Today'
  if (t >= startToday - DAY) return 'Yesterday'
  if (t >= startToday - 7 * DAY) return 'Previous 7 days'
  if (t >= startToday - 30 * DAY) return 'Previous 30 days'
  return 'Older'
}
const BUCKETS = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older']

let active = null

async function render(el, arg, lib) {
  active?.destroy()
  const chat = createChat(el, arg, lib)
  active = chat
  await chat.start()
}

function createChat(host, arg, lib) {
  const { h, api, toast, confirmDialog, promptDialog } = lib
  const S = {
    models: null, convos: [], next: null, archived: null, showArchived: false,
    conv: null, msgs: [], context: null, project: null, projects: null,
    arts: new Map(), panelId: null,
    draft: { model: null, system: '', temperature: null, tools: true, projectId: null },
    attachments: [], gen: null, bg: new Set(), lastError: null,
    q: '', results: null, searchSeq: 0, stick: true, loadSeq: 0, dead: false, pollTimer: null,
  }
  const D = {} // DOM references
  const disposers = []
  const listen = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); disposers.push(() => target.removeEventListener(type, fn, opts)) }
  const run = (fn) => async (...a) => { try { await fn(...a) } catch (e) { toast(e.message, 'error') } }
  const token = () => lib.state.token

  /* ------------------------------------------------------------------ layout */
  function build() {
    D.sr = h('div', { class: 'ai-offscreen', role: 'status', 'aria-live': 'polite' })
    D.search = h('input', { type: 'search', class: 'ai-input ai-side-search', placeholder: 'Search chats', 'aria-label': 'Search chats (Ctrl+K)', autocomplete: 'off', maxlength: '200' })
    D.convList = h('div', { class: 'ai-convs' })
    D.side = h('aside', { class: 'ai-side', id: 'ai-side', 'aria-label': 'Conversations' },
      h('div', { class: 'ai-side-head' },
        h('button', { type: 'button', class: 'ai-btn ai-btn-primary ai-new', onclick: () => newChat({ push: true }) }, icon('plus', 15), ' New chat'),
        iconButton(h, 'x', 'Close conversation list', () => setSide(false), { cls: 'ai-side-close' })),
      h('div', { class: 'ai-side-search-wrap' }, icon('search', 14), D.search),
      D.convList)
    D.scrim = h('div', { class: 'ai-scrim', onclick: () => { setSide(false); closePanel() } })

    D.title = h('h1', { class: 'ai-title' })
    D.titleBtn = h('button', { type: 'button', class: 'ai-title-btn', title: 'Rename chat', onclick: run(() => renameCurrent()) }, D.title)
    D.model = h('select', { class: 'ai-select ai-model', 'aria-label': 'Model', onchange: run(() => changeModel(D.model.value)) })
    D.projectLink = h('a', { class: 'ai-chip ai-chip-link', hidden: true })
    D.menuBtn = iconButton(h, 'more', 'Chat actions', (e) => headerMenu(e.currentTarget), { cls: 'ai-bar-btn' })
    D.bar = h('header', { class: 'ai-bar' },
      iconButton(h, 'menu', 'Show conversations', () => setSide(true), { cls: 'ai-side-toggle' }),
      h('div', { class: 'ai-bar-title' }, D.titleBtn, D.projectLink),
      D.model,
      iconButton(h, 'sliders', 'Chat settings', () => openSettings(), { cls: 'ai-bar-btn' }),
      D.menuBtn)

    D.banner = h('div', { class: 'ai-banner ai-banner-info', hidden: true, role: 'note' })
    D.thread = h('div', { class: 'ai-thread', role: 'log', 'aria-label': 'Conversation', 'aria-live': 'off' })
    D.jump = h('button', { type: 'button', class: 'ai-jump', hidden: true, onclick: () => { S.stick = true; scrollToEnd(true) } }, icon('down2', 14), ' Latest')

    D.input = h('textarea', { class: 'ai-input ai-textarea', rows: '1', placeholder: 'Message RD Cloude', 'aria-label': 'Message', maxlength: '100000', enterkeyhint: 'send' })
    D.file = h('input', { type: 'file', class: 'ai-offscreen', multiple: true, tabindex: '-1', 'aria-hidden': 'true', onchange: run(async () => { await addFiles([...D.file.files]); D.file.value = '' }) })
    D.attList = h('ul', { class: 'ai-atts ai-composer-atts', 'aria-label': 'Attachments' })
    D.send = h('button', { type: 'submit', class: 'ai-send', 'aria-label': 'Send message', title: 'Send (Enter)' }, icon('send', 18))
    D.meter = h('div', { class: 'ai-meter', hidden: true },
      h('span', { class: 'ai-meter-bar', 'aria-hidden': 'true' }, D.meterFill = h('span', { class: 'ai-meter-fill' })),
      D.meterText = h('span', { class: 'ai-meter-text' }))
    D.error = h('div', { class: 'ai-composer-error', role: 'alert', hidden: true })
    D.composer = h('form', { class: 'ai-composer', onsubmit: (e) => { e.preventDefault(); if (S.gen) stop(); else submit() } },
      D.error, D.attList,
      h('div', { class: 'ai-box' }, D.input,
        h('div', { class: 'ai-box-tools' },
          iconButton(h, 'clip', 'Attach files', (e) => attachMenu(e.currentTarget), { cls: 'ai-boxbtn' }),
          iconButton(h, 'spark', 'Insert a saved prompt', () => openPrompts(), { cls: 'ai-boxbtn' }),
          D.meter, D.send)),
      h('p', { class: 'ai-hint' }, 'Enter sends, Shift+Enter adds a line. ', D.hintStop = h('span', { hidden: true }, 'Esc stops the reply. '), 'AI can make mistakes.'),
      D.file)
    D.main = h('section', { class: 'ai-main', 'aria-label': 'Chat' }, D.bar, D.banner, D.thread, D.jump, D.composer)

    D.panel = h('aside', { class: 'ai-panel', 'aria-label': 'Artifact', hidden: true })
    D.viewer = artifactViewer(lib, {
      onClose: () => closePanel(),
      onChange: (a) => { S.arts.set(a.id, a); refreshCards() },
      onDelete: (id) => { S.arts.delete(id); closePanel(); refreshCards() },
    })
    D.panel.append(D.viewer.el)

    D.root = h('div', { class: 'ai-chat', 'data-side': 'closed', 'data-panel': 'closed', 'data-sidebar': 'inline', 'data-panelmode': 'inline' }, D.sr, D.scrim, D.side, D.main, D.panel)
    host.append(D.root)

    D.input.addEventListener('input', () => { autosize(); saveDraft(); D.error.hidden = true })
    D.input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return // an input method is choosing a candidate: Enter belongs to it
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !coarse()) { e.preventDefault(); if (!S.gen) submit() }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!S.gen) submit() }
    })
    D.input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files ?? [])]
      if (files.length) { e.preventDefault(); run(() => addFiles(files))() }
    })
    for (const t of [D.composer, D.thread]) {
      t.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); D.composer.classList.add('ai-drop') } })
      t.addEventListener('dragleave', () => D.composer.classList.remove('ai-drop'))
      t.addEventListener('drop', (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); D.composer.classList.remove('ai-drop'); run(() => addFiles([...e.dataTransfer.files]))() })
    }
    let st
    D.search.addEventListener('input', () => { clearTimeout(st); st = setTimeout(() => runSearch(D.search.value), 250) })
    disposers.push(() => clearTimeout(st))
    D.search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && D.search.value) { e.stopPropagation(); D.search.value = ''; runSearch('') } })

    // Esc stops a reply or closes the panel / drawer; the document-level keys self-remove when the view is replaced.
    const onKey = (e) => {
      if (!D.root.isConnected) return
      const k = typeof e.key === 'string' ? e.key.toLowerCase() : '' // browser autofill can dispatch key events without a key
      if (e.key === 'Escape' && !document.querySelector('dialog[open], .ai-menu')) {
        if (S.gen) { e.preventDefault(); stop() } else if (D.root.dataset.side === 'open' && D.root.dataset.sidebar === 'drawer') { setSide(false) } else if (D.root.dataset.panel === 'open') { closePanel() }
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'k') { e.preventDefault(); setSide(true); D.search.focus(); D.search.select() }
      else if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 'o') { e.preventDefault(); newChat({ push: true }) }
    }
    listen(document, 'keydown', onKey)
    listen(window, 'resize', layout)
    layout()
    listen(window, 'scroll', onScroll, { passive: true, capture: true })
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { D.root.style.setProperty('--ai-composer-h', `${D.composer.offsetHeight}px`); if (S.stick) scrollToEnd() }) : null
    ro?.observe(D.composer)
    disposers.push(() => ro?.disconnect())
  }

  const coarse = () => window.matchMedia?.('(pointer: coarse)').matches === true
  function autosize() {
    D.input.style.height = 'auto'
    D.input.style.height = `${Math.min(D.input.scrollHeight, Math.round(window.innerHeight * 0.4))}px`
  }
  const draftKey = () => `draft.${S.conv?.id ?? 'new'}`
  const saveDraft = () => pref.set(draftKey(), D.input.value)
  /**
   * Layout modes (the console's own nav takes 200px): below 960px the conversation list is a drawer, below 1040px the artifact panel is a
   * full-width sheet; up to 1480px the list also becomes a drawer while an artifact is open, so chat and artifact can sit side by side.
   */
  function layout() {
    const vw = window.innerWidth
    const panelOpen = D.root.dataset.panel === 'open'
    D.root.dataset.panelmode = vw >= 1040 ? 'inline' : 'overlay'
    D.root.dataset.sidebar = vw >= 960 && !(panelOpen && vw < 1480) ? 'inline' : 'drawer'
    syncScrim()
  }
  /** The scrim only exists while an overlay (the conversation drawer or the artifact sheet) covers the page. */
  function syncScrim() {
    const drawer = D.root.dataset.sidebar === 'drawer' && D.root.dataset.side === 'open'
    const sheet = D.root.dataset.panel === 'open' && D.root.dataset.panelmode === 'overlay'
    D.scrim.classList.toggle('ai-on', drawer || sheet)
  }
  function setSide(open) {
    D.root.dataset.side = open ? 'open' : 'closed'
    syncScrim()
    if (open) setTimeout(() => D.search.focus(), 0)
  }
  const announce = (text) => { D.sr.textContent = ''; setTimeout(() => { D.sr.textContent = text }, 30) }

  /* ------------------------------------------------------------------ scrolling */
  function scroller() {
    for (let p = host.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowY
      if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p
    }
    return document.scrollingElement
  }
  function distanceFromBottom() { const s = scroller(); return s.scrollHeight - s.scrollTop - (s === document.scrollingElement ? window.innerHeight : s.clientHeight) }
  function onScroll() {
    if (!D.root.isConnected) return
    const far = distanceFromBottom() > 140
    S.stick = !far
    D.jump.hidden = !far || !S.msgs.length
  }
  function scrollToEnd(smooth = false) {
    const s = scroller()
    s.scrollTo({ top: s.scrollHeight, behavior: smooth ? 'smooth' : 'instant' })
  }

  /* ------------------------------------------------------------------ data */
  async function start() {
    build()
    let models
    try { [models] = await Promise.all([getModels(api), loadConvos()]) } catch (e) { D.thread.replaceChildren(h('p', { class: 'ai-error' }, e.message)); return }
    S.models = models
    S.draft.model = models.models.some((m) => m.id === pref.get('model')) ? pref.get('model') : models.default
    drawModelSelect()
    D.banner.hidden = models.provider.live
    if (!models.provider.live) {
      D.banner.replaceChildren(icon('info', 15), h('span', {}, h('strong', {}, 'Offline demo mode. '), 'No AI model is connected to this server, so replies come from a built-in stub that echoes, calls tools and produces sample artifacts. Set ',
        h('code', {}, 'ANTHROPIC_API_KEY'), ' on the server to use real models.'))
    }
    drawSidebar()
    if (arg) await openConversation(arg, { first: true })
    else await newChat({ first: true })
  }
  async function loadConvos(more = false) {
    const params = new URLSearchParams({ limit: '100' })
    if (more && S.next) params.set('cursor', S.next)
    const r = await api('GET', `/api/conversations?${params}`)
    S.convos = more ? [...S.convos, ...r.conversations] : r.conversations
    S.next = r.nextCursor
  }
  async function loadArchived() {
    const r = await api('GET', '/api/conversations?archived=1&limit=100')
    S.archived = r.conversations
  }
  function upsertConv(cv) {
    if (!cv) return
    const inArch = S.archived?.findIndex((c) => c.id === cv.id) ?? -1
    const i = S.convos.findIndex((c) => c.id === cv.id)
    if (cv.archived) {
      if (i >= 0) S.convos.splice(i, 1)
      if (S.archived) { if (inArch >= 0) S.archived[inArch] = cv; else S.archived.unshift(cv) }
    } else {
      if (inArch >= 0) S.archived.splice(inArch, 1)
      if (i >= 0) S.convos[i] = cv; else S.convos.unshift(cv)
      S.convos.sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : a.lastMessageAt > b.lastMessageAt ? -1 : 0))
    }
    if (S.conv?.id === cv.id) S.conv = cv
    drawSidebar()
  }
  async function loadArtifacts(convId) {
    try {
      const r = await api('GET', `/api/artifacts?conversationId=${encodeURIComponent(convId)}&limit=200`)
      S.arts = new Map(r.artifacts.map((a) => [a.id, a]))
    } catch { S.arts = new Map() }
  }

  /* ------------------------------------------------------------------ sidebar */
  function convItem(c) {
    const cur = S.conv?.id === c.id
    return h('li', { class: 'ai-conv-li' },
      h('a', {
        class: `ai-conv${cur ? ' ai-conv-on' : ''}`, href: `#chat/${encodeURIComponent(c.id)}`, 'aria-current': cur ? 'page' : null,
        onclick: (e) => { if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return; e.preventDefault(); openConversation(c.id, { push: true }) },
      }, c.pinned ? icon('pin', 12) : null, S.bg.has(c.id) ? h('span', { class: 'ai-spinner', role: 'img', 'aria-label': 'Generating' }) : null, h('span', { class: 'ai-conv-title' }, c.title)),
      iconButton(h, 'more', `Actions for ${c.title}`, (e) => convMenu(e.currentTarget, c), { cls: 'ai-conv-more', size: 15 }))
  }
  function drawSidebar() {
    if (S.q) return drawResults()
    const kids = []
    const live = S.convos.filter((c) => !c.archived)
    const pinned = live.filter((c) => c.pinned)
    if (pinned.length) kids.push(h('section', { class: 'ai-group' }, h('h2', { class: 'ai-group-h' }, 'Pinned'), h('ul', { class: 'ai-conv-ul' }, ...pinned.map(convItem))))
    const rest = live.filter((c) => !c.pinned)
    for (const b of BUCKETS) {
      const items = rest.filter((c) => bucketOf(c.lastMessageAt) === b)
      if (items.length) kids.push(h('section', { class: 'ai-group' }, h('h2', { class: 'ai-group-h' }, b), h('ul', { class: 'ai-conv-ul' }, ...items.map(convItem))))
    }
    if (!live.length) kids.push(h('p', { class: 'ai-muted ai-side-empty' }, 'No chats yet. Start one!'))
    if (S.next) kids.push(h('button', { type: 'button', class: 'ai-btn ai-more', onclick: run(async () => { await loadConvos(true); drawSidebar() }) }, 'Load more'))
    kids.push(h('div', { class: 'ai-archived' },
      h('button', {
        type: 'button', class: 'ai-link', 'aria-expanded': String(S.showArchived),
        onclick: run(async () => { S.showArchived = !S.showArchived; if (S.showArchived && !S.archived) await loadArchived(); drawSidebar() }),
      }, icon(S.showArchived ? 'up2' : 'down2', 13), ' Archived'),
      S.showArchived ? (S.archived?.length ? h('ul', { class: 'ai-conv-ul' }, ...S.archived.map(convItem)) : h('p', { class: 'ai-muted ai-side-empty' }, 'Nothing archived.')) : null))
    D.convList.replaceChildren(...kids)
  }
  async function runSearch(raw) {
    const q = raw.trim()
    S.q = q
    const my = ++S.searchSeq
    if (!q) { S.results = null; drawSidebar(); return }
    S.results = { loading: true }
    drawResults()
    try {
      const r = await api('GET', `/api/search?q=${encodeURIComponent(q)}&limit=30`)
      if (my !== S.searchSeq) return
      S.results = r
    } catch (e) { if (my !== S.searchSeq) return; S.results = { error: e.message } }
    drawResults()
  }
  function drawResults() {
    const r = S.results
    if (!r || r.loading) return D.convList.replaceChildren(h('p', { class: 'ai-muted ai-side-empty', role: 'status' }, 'Searching...'))
    if (r.error) return D.convList.replaceChildren(h('p', { class: 'ai-muted ai-side-empty', role: 'status' }, r.error))
    if (!r.results.length) return D.convList.replaceChildren(h('p', { class: 'ai-muted ai-side-empty', role: 'status' }, `No chats match "${r.query}".`))
    D.convList.replaceChildren(h('p', { class: 'ai-muted ai-result-count', role: 'status' }, `${r.total} chat${r.total === 1 ? '' : 's'} found${r.partial ? ' (only your most recent chats are searched)' : ''}`),
      h('ul', { class: 'ai-conv-ul' }, ...r.results.map((x) => h('li', { class: 'ai-conv-li' }, h('a', {
        class: 'ai-result', href: `#chat/${encodeURIComponent(x.conversationId)}`,
        onclick: (e) => { if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return; e.preventDefault(); openConversation(x.conversationId, { push: true, focusMessage: x.messageId }) },
      }, h('span', { class: 'ai-result-title' }, x.title), h('span', { class: 'ai-result-snippet' }, ...highlighted(h, x.snippet, x.highlights)),
      h('span', { class: 'ai-muted ai-result-meta' }, `${x.role === 'user' ? 'You' : x.role === 'assistant' ? 'Assistant' : 'Title match'} · ${relTime(x.updatedAt)}${x.archived ? ' · archived' : ''}`))))))
  }
  function convMenu(anchor, c) {
    openMenu(h, anchor, [
      { label: c.pinned ? 'Unpin' : 'Pin', icon: 'pin', onclick: run(() => patchConv(c.id, { pinned: !c.pinned })) },
      { label: 'Rename', icon: 'edit', onclick: run(() => renameConv(c)) },
      { label: c.archived ? 'Unarchive' : 'Archive', icon: 'archive', onclick: run(() => patchConv(c.id, { archived: !c.archived })) },
      'sep',
      { label: 'Delete', icon: 'trash', danger: true, onclick: run(() => deleteConv(c)) },
    ], { align: 'start' })
  }
  async function patchConv(id, patch) {
    const cv = await api('PATCH', `/api/conversations/${encodeURIComponent(id)}`, patch)
    upsertConv(cv)
    if (S.conv?.id === id) drawHeader()
    return cv
  }
  async function renameConv(c) {
    const t = await promptDialog('Rename chat', c.title, { okLabel: 'Rename' })
    if (t === null || !t.trim() || t.trim() === c.title) return
    await patchConv(c.id, { title: t.trim() })
  }
  const renameCurrent = async () => { if (S.conv) await renameConv(S.conv) }
  async function deleteConv(c) {
    if (!(await confirmDialog(`Delete "${c.title}"? Its messages, artifacts and share links are removed permanently.`, 'Delete'))) return
    if (S.gen?.convId === c.id) await stop(true)
    await api('DELETE', `/api/conversations/${encodeURIComponent(c.id)}`)
    S.convos = S.convos.filter((x) => x.id !== c.id)
    if (S.archived) S.archived = S.archived.filter((x) => x.id !== c.id)
    pref.set(`draft.${c.id}`, '')
    if (S.conv?.id === c.id) await newChat({ push: true })
    else drawSidebar()
    toast('Chat deleted')
  }

  /* ------------------------------------------------------------------ header */
  function drawModelSelect() {
    const cur = S.conv?.model ?? S.draft.model ?? S.models.default
    D.model.replaceChildren(...S.models.models.map((m) => h('option', { value: m.id, selected: m.id === cur || null, title: m.description }, m.name)))
    if (!S.models.models.some((m) => m.id === cur)) D.model.prepend(h('option', { value: cur, selected: true }, cur))
    D.model.value = cur
  }
  function drawHeader() {
    const c = S.conv
    D.title.textContent = c ? c.title : 'New chat'
    D.titleBtn.disabled = !c
    document.title = c ? `${c.title} - RD Cloude` : 'RD Cloude'
    drawModelSelect()
    D.projectLink.hidden = !S.project
    if (S.project) { D.projectLink.textContent = S.project.name; D.projectLink.href = `#projects/${encodeURIComponent(S.project.id)}`; D.projectLink.title = 'Open project' }
    D.hintStop.hidden = !S.gen
  }
  async function changeModel(id) {
    if (S.conv) {
      try { await patchConv(S.conv.id, { model: id }) } catch (e) { drawModelSelect(); throw e } // keep the picker truthful when the server refuses
    } else S.draft.model = id
    pref.set('model', id)
    drawMeter()
  }
  function headerMenu(anchor) {
    const c = S.conv
    openMenu(h, anchor, [
      { label: c?.pinned ? 'Unpin chat' : 'Pin chat', icon: 'pin', disabled: !c, onclick: run(() => patchConv(c.id, { pinned: !c.pinned })) },
      { label: 'Rename chat', icon: 'edit', disabled: !c, onclick: run(renameCurrent) },
      { label: c?.archived ? 'Unarchive chat' : 'Archive chat', icon: 'archive', disabled: !c, onclick: run(() => patchConv(c.id, { archived: !c.archived })) },
      'sep',
      { label: 'Export as Markdown', icon: 'download', disabled: !c || !S.msgs.length, onclick: run(() => exportConv('markdown')) },
      { label: 'Export as JSON (all branches)', icon: 'download', disabled: !c || !S.msgs.length, onclick: run(() => exportConv('json')) },
      { label: 'Share a read-only link', icon: 'share', disabled: !c || !S.msgs.length || !!S.gen, onclick: () => openShareDialog(lib, { kind: 'conversation', targetId: c.id, title: c.title, what: 'conversation' }) },
      'sep',
      { label: 'Keyboard shortcuts', icon: 'keyboard', onclick: () => openShortcuts() },
      { label: 'Delete chat', icon: 'trash', danger: true, disabled: !c, onclick: run(() => deleteConv(c)) },
    ])
  }
  async function exportConv(format) {
    const c = S.conv
    const res = await api('GET', `/api/conversations/${encodeURIComponent(c.id)}/export?format=${format}${format === 'json' ? '&all=1' : ''}`, undefined, { response: true })
    if (!res.ok) throw new Error('Export failed')
    const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')
    lib.download(await res.blob(), m ? decodeURIComponent(m[1]) : `conversation.${format === 'json' ? 'json' : 'md'}`)
  }
  function openShortcuts() {
    openDialog(h, { title: 'Keyboard shortcuts', build: (body) => body.append(h('dl', { class: 'ai-keys' }, ...SHORTCUTS.flatMap(([k, d]) => [h('dt', {}, h('kbd', {}, k)), h('dd', {}, d)]))) })
  }

  /* ------------------------------------------------------------------ settings dialog */
  async function openSettings() {
    if (!S.projects) { try { S.projects = (await api('GET', '/api/projects?limit=200')).projects } catch { S.projects = [] } }
    const c = S.conv
    const cur = c ?? S.draft
    openDialog(h, {
      title: 'Chat settings',
      build(body, close) {
        const system = h('textarea', { class: 'ai-input ai-textarea', rows: '5', maxlength: '20000', 'aria-describedby': 'ai-set-sys-h' })
        system.value = cur.system ?? ''
        const useTemp = h('input', { type: 'checkbox', checked: cur.temperature !== null && cur.temperature !== undefined || null })
        const temp = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(cur.temperature ?? 1), 'aria-label': 'Temperature' })
        const tempOut = h('output', { class: 'ai-muted' })
        const syncTemp = () => { temp.disabled = !useTemp.checked; tempOut.textContent = useTemp.checked ? Number(temp.value).toFixed(2) : 'model default' }
        useTemp.addEventListener('change', syncTemp)
        temp.addEventListener('input', syncTemp)
        syncTemp()
        const tools = h('input', { type: 'checkbox', checked: cur.tools !== false || null })
        const proj = h('select', { class: 'ai-select' }, h('option', { value: '' }, 'No project'), ...S.projects.map((p) => h('option', { value: p.id, selected: cur.projectId === p.id || null }, p.name)))
        const err = h('p', { class: 'ai-error', role: 'alert' })
        body.append(
          h('div', { class: 'ai-field' }, h('label', { for: 'ai-set-sys' }, 'Instructions for this chat'), system,
            h('small', { id: 'ai-set-sys-h', class: 'ai-muted' }, 'Added to the system prompt, after any project instructions.')),
          h('div', { class: 'ai-field' }, h('label', {}, h('span', {}, 'Temperature '), tempOut),
            h('label', { class: 'ai-check' }, useTemp, ' Set a temperature (lower is more focused, higher more varied)'), temp),
          h('div', { class: 'ai-field' }, h('label', { class: 'ai-check' }, tools, ' Allow tools (calculator, date and time, Drive search)')),
          h('div', { class: 'ai-field' }, h('label', {}, 'Project'), proj, h('small', { class: 'ai-muted' }, 'Project instructions and knowledge files are added to the context.')),
          err,
          h('div', { class: 'ai-row ai-row-end' },
            h('button', { type: 'button', class: 'ai-btn', onclick: close }, 'Cancel'),
            h('button', { type: 'button', class: 'ai-btn ai-btn-primary', onclick: async (e) => {
              const patch = { system: system.value, temperature: useTemp.checked ? Number(temp.value) : null, tools: tools.checked, projectId: proj.value || null }
              const btn = e.currentTarget; btn.disabled = true
              try {
                if (c) { const cv = await patchConv(c.id, patch); S.project = cv.projectId ? (S.projects.find((p) => p.id === cv.projectId) ?? null) : null; drawHeader() }
                else { Object.assign(S.draft, patch); S.project = patch.projectId ? (S.projects.find((p) => p.id === patch.projectId) ?? null) : null; drawHeader() }
                close()
                toast('Settings saved')
              } catch (ex) { err.textContent = ex.message; btn.disabled = false }
            } }, 'Save')))
        system.id = 'ai-set-sys'
      },
    })
  }

  /* ------------------------------------------------------------------ conversation lifecycle */
  async function newChat({ push = false, first = false } = {}) {
    if (!first && S.conv) saveDraft()
    S.loadSeq++
    detachGen()
    clearTimeout(S.pollTimer)
    S.conv = null; S.msgs = []; S.context = null; S.project = null; S.lastError = null; S.arts = new Map()
    S.draft = { model: pref.get('model') && S.models?.models.some((m) => m.id === pref.get('model')) ? pref.get('model') : S.models?.default ?? null, system: '', temperature: null, tools: true, projectId: null }
    S.attachments = []
    closePanel()
    setUrl(null, push)
    D.input.value = pref.get('draft.new', '') ?? ''
    consumePendingDraft()
    autosize()
    drawAttachments(); drawHeader(); drawThread(); drawMeter(); drawSidebar(); setSide(false)
    if (!coarse()) D.input.focus()
  }
  function consumePendingDraft() {
    try {
      const t = sessionStorage.getItem('rd.ai.pendingPrompt')
      if (t) { sessionStorage.removeItem('rd.ai.pendingPrompt'); D.input.value = t }
    } catch { /* storage blocked */ }
  }
  function setUrl(id, push) {
    const next = id ? `#chat/${encodeURIComponent(id)}` : '#chat'
    if (location.hash === next) return
    try { push ? history.pushState(null, '', next) : history.replaceState(null, '', next) } catch { /* ignore */ }
  }

  async function openConversation(id, { push = false, first = false, focusMessage = null } = {}) {
    if (!first && S.conv) saveDraft()
    const seq = ++S.loadSeq
    detachGen()
    clearTimeout(S.pollTimer)
    let r
    try { r = await api('GET', `/api/conversations/${encodeURIComponent(id)}`) } catch (e) {
      if (seq !== S.loadSeq) return
      S.conv = null; S.msgs = []
      D.thread.replaceChildren(h('div', { class: 'ai-empty' }, h('h2', {}, 'Conversation not found'), h('p', { class: 'ai-muted' }, e.message), h('button', { type: 'button', class: 'ai-btn ai-btn-primary', onclick: () => newChat({ push: true }) }, 'Start a new chat')))
      drawHeader(); return
    }
    if (seq !== S.loadSeq) return
    await loadArtifacts(id)
    if (seq !== S.loadSeq) return
    applyConversation(r)
    if (r.generating) S.bg.add(id)
    S.lastError = null
    S.attachments = []
    closePanel()
    setUrl(id, push)
    D.input.value = pref.get(`draft.${id}`, '') ?? ''
    autosize()
    drawAttachments(); drawHeader(); drawThread(); drawMeter(); drawSidebar(); setSide(false)
    if (focusMessage) {
      const target = D.thread.querySelector(`[data-id="${CSS.escape(focusMessage)}"]`)
      if (target) { target.scrollIntoView({ block: 'center' }); target.classList.add('ai-flash'); setTimeout(() => target.classList.remove('ai-flash'), 1800) } else scrollToEnd()
    } else scrollToEnd()
    if (r.generating) watchBackground(id)
    else if (!coarse() && !first) D.input.focus()
  }
  function applyConversation(r) {
    S.conv = r.conversation
    S.msgs = r.messages
    S.context = r.context
    S.project = r.project
    upsertConvQuiet(r.conversation)
  }
  function upsertConvQuiet(cv) {
    const i = S.convos.findIndex((c) => c.id === cv.id)
    if (i >= 0 && !cv.archived) S.convos[i] = cv
  }
  async function reloadActive({ scroll = true } = {}) {
    const id = S.conv?.id
    if (!id) return
    const seq = ++S.loadSeq
    const r = await api('GET', `/api/conversations/${encodeURIComponent(id)}`)
    if (seq !== S.loadSeq) return
    await loadArtifacts(id)
    applyConversation(r)
    upsertConv(r.conversation)
    drawHeader(); drawThread(); drawMeter()
    if (scroll && S.stick) scrollToEnd()
    if (r.generating) watchBackground(id)
  }
  /** A reply is being produced for a chat this view does not stream (opened while generating): poll until it settles. */
  function watchBackground(id) {
    S.bg.add(id)
    drawSidebar()
    D.thread.append(h('div', { class: 'ai-note ai-note-live', 'data-bg': '1' }, h('span', { class: 'ai-spinner' }), ' A reply is still being generated for this chat...'))
    const tick = async () => {
      if (S.dead || S.conv?.id !== id) { S.bg.delete(id); return }
      try {
        const r = await api('GET', `/api/conversations/${encodeURIComponent(id)}`)
        if (r.generating) { S.pollTimer = setTimeout(tick, 1200); return }
        S.bg.delete(id)
        await loadArtifacts(id)
        applyConversation(r); upsertConv(r.conversation)
        drawHeader(); drawThread(); drawMeter(); scrollToEnd()
      } catch { S.bg.delete(id) }
    }
    S.pollTimer = setTimeout(tick, 900)
  }

  /* ------------------------------------------------------------------ thread rendering */
  function drawThread() {
    D.thread.classList.toggle('ai-thread-empty', !S.msgs.length)
    if (!S.msgs.length) { D.thread.replaceChildren(emptyState()); D.jump.hidden = true; return }
    const kids = S.msgs.map((m) => msgEl(m))
    if (S.lastError) kids.push(errorRow(S.lastError))
    else if (S.msgs.at(-1).role === 'user' && !S.gen && !S.bg.has(S.conv?.id)) kids.push(errorRow({ message: 'No reply was generated for this message.' }))
    D.thread.replaceChildren(...kids)
  }
  function errorRow(err) {
    const last = S.msgs.at(-1)
    return h('div', { class: 'ai-note ai-note-bad', role: 'alert' }, icon('info', 15), h('span', {}, err.message),
      last && last.role === 'user' ? h('button', { type: 'button', class: 'ai-btn', onclick: run(() => regenerate(last.id)) }, icon('refresh', 14), ' Try again') : null)
  }
  function emptyState() {
    return h('div', { class: 'ai-empty' },
      h('div', { class: 'ai-empty-logo', 'aria-hidden': 'true' }, 'RD'),
      h('h2', { class: 'ai-empty-title' }, 'How can I help you today?'),
      S.project ? h('p', { class: 'ai-muted' }, `Project "${S.project.name}": its instructions and knowledge files are part of this chat.`) : null,
      h('ul', { class: 'ai-suggest' }, ...SUGGESTIONS.map((s) => h('li', {}, h('button', { type: 'button', class: 'ai-suggest-btn', onclick: () => { D.input.value = s.text; autosize(); D.input.focus() } }, icon(s.icon, 16), h('span', {}, s.text))))))
  }

  function attChip(m, a) {
    return h('li', { class: 'ai-att' }, h('button', { type: 'button', class: 'ai-att-btn', title: `${a.name} (${fmtSize(a.size)})`, disabled: String(m.id).startsWith('pending') || null, onclick: run(() => openAttachment(m, a)) },
      icon(a.type === 'image' ? 'image' : a.source === 'drive' ? 'drive' : 'file', 14), h('span', { class: 'ai-att-name' }, a.name), h('span', { class: 'ai-muted ai-att-size' }, fmtSize(a.size)), a.truncated ? h('span', { class: 'ai-chip' }, 'truncated') : null))
  }
  async function openAttachment(m, a) {
    const res = await api('GET', `/api/conversations/${encodeURIComponent(S.conv.id)}/messages/${encodeURIComponent(m.id)}/attachments/${encodeURIComponent(a.id)}`, undefined, { response: true })
    if (!res.ok) throw new Error('Attachment unavailable')
    if (a.type === 'image') {
      const url = URL.createObjectURL(await res.blob())
      openDialog(h, { title: a.name, wide: true, onClose: () => URL.revokeObjectURL(url), build: (b) => b.append(h('img', { class: 'ai-att-img', src: url, alt: a.name })) })
    } else {
      const text = await res.text()
      openDialog(h, { title: a.name, wide: true, build: (b) => b.append(renderCode(text.slice(0, 200_000), '', {})) })
    }
  }

  function branchSwitcher(m) {
    const s = m.siblings
    if (!s || s.count < 2) return null
    const go = (d) => run(() => switchBranch(s.ids[s.index + d]))
    const prev = iconButton(h, 'left', 'Previous version', go(-1), { size: 14, cls: 'ai-branch-btn' })
    const next = iconButton(h, 'right', 'Next version', go(1), { size: 14, cls: 'ai-branch-btn' })
    prev.disabled = s.index === 0
    next.disabled = s.index === s.count - 1
    return h('div', { class: 'ai-branch', role: 'group', 'aria-label': m.role === 'user' ? 'Edited versions of this message' : 'Alternative replies' }, prev, h('span', { class: 'ai-branch-n' }, `${s.index + 1} / ${s.count}`), next)
  }
  async function switchBranch(messageId) {
    if (!messageId || S.gen) return
    const r = await api('POST', `/api/conversations/${encodeURIComponent(S.conv.id)}/branch`, { messageId })
    S.conv = r.conversation; S.msgs = r.messages; S.lastError = null
    upsertConv(r.conversation)
    await loadArtifacts(S.conv.id)
    drawThread(); drawHeader()
  }

  function toolsBlock(calls) {
    if (!calls?.length) return null
    return h('div', { class: 'ai-tools' }, ...calls.map((t) => {
      const state = t.pending ? 'running' : t.isError ? 'failed' : 'done'
      const argText = (() => { try { const s = JSON.stringify(t.input ?? {}); return s.length > 60 ? `${s.slice(0, 57)}...` : s } catch { return '' } })()
      return h('details', { class: `ai-tool ai-tool-${state}` },
        h('summary', {}, icon('wrench', 14), h('span', { class: 'ai-tool-name' }, t.name), h('code', { class: 'ai-tool-arg' }, argText),
          h('span', { class: 'ai-tool-state' }, t.pending ? h('span', { class: 'ai-spinner', role: 'img', 'aria-label': 'running' }) : null, t.pending ? 'running' : t.isError ? 'failed' : `${t.ms ?? 0} ms`)),
        h('div', { class: 'ai-tool-body' },
          h('h3', { class: 'ai-tool-h' }, 'Input'), h('pre', { class: 'ai-tool-pre' }, JSON.stringify(t.input ?? {}, null, 2)),
          t.pending ? null : [h('h3', { class: 'ai-tool-h' }, t.isError ? 'Error' : 'Output'), h('pre', { class: 'ai-tool-pre' }, String(t.output ?? ''))]))
    }))
  }
  function artCards(ids) {
    const cards = (ids ?? []).map((id) => S.arts.get(id)).filter(Boolean)
    if (!cards.length) return null
    return h('div', { class: 'ai-arts' }, ...cards.map((a) => h('button', {
      type: 'button', class: `ai-art-card${S.panelId === a.id ? ' ai-art-card-on' : ''}`, 'data-art': a.id, onclick: () => openArtifact(a.id), 'aria-label': `Open artifact ${a.title}`,
    }, icon(a.type === 'html' ? 'eye' : a.type === 'svg' ? 'image' : a.type === 'markdown' ? 'file' : 'code', 18),
    h('span', { class: 'ai-art-card-t' }, h('strong', {}, a.title), h('small', { class: 'ai-muted' }, `${typeLabel(a.type)} · v${a.version}`)), icon('right', 14))))
  }
  function refreshCards() {
    for (const holder of D.thread.querySelectorAll('.ai-arts-slot')) {
      const m = S.msgs.find((x) => x.id === holder.dataset.mid)
      holder.replaceChildren(...[artCards(m?.artifactIds)].filter(Boolean))
    }
  }

  function usageLine(m) {
    const bits = []
    if (m.model) bits.push(m.model)
    if (m.usage) bits.push(`${fmtTokens(m.usage.inputTokens)} in / ${fmtTokens(m.usage.outputTokens)} out tokens`)
    return bits.join(' · ')
  }

  function msgEl(m) {
    const isUser = m.role === 'user'
    const el = h('article', { class: `ai-msg ai-msg-${m.role}`, 'data-id': m.id, 'data-status': m.status })
    if (isUser) {
      el.append(
        h('div', { class: 'ai-bubble' },
          m.attachments?.length ? h('ul', { class: 'ai-atts' }, ...m.attachments.map((a) => attChip(m, a))) : null,
          m.content ? h('div', { class: 'ai-user-text' }, m.content) : null),
        h('footer', { class: 'ai-msg-actions' }, branchSwitcher(m),
          S.gen ? null : iconButton(h, 'edit', 'Edit message', run(() => editMessage(m.id)), { size: 15 }),
          iconButton(h, 'copy', 'Copy message', run(async () => { toast((await copyText(m.content)) ? 'Copied' : 'Copy failed', 'info') }), { size: 15 })))
      return el
    }
    const body = h('div', { class: 'ai-msg-body ai-md' })
    if (m.content) body.append(renderMarkdown(m.content))
    const notes = []
    if (m.status === 'stopped') notes.push(h('p', { class: 'ai-note' }, icon('stop', 13), ' You stopped this reply.'))
    if (m.status === 'error') notes.push(h('div', { class: 'ai-note ai-note-bad', role: 'alert' }, icon('info', 15), h('span', {}, m.error || 'The reply failed.'), h('button', { type: 'button', class: 'ai-btn', onclick: run(() => regenerate(m.id)) }, icon('refresh', 14), ' Try again')))
    if (m.status === 'interrupted') notes.push(h('div', { class: 'ai-note ai-note-bad' }, icon('info', 15), h('span', {}, 'This reply was interrupted (the connection dropped or the server restarted).'), h('button', { type: 'button', class: 'ai-btn', onclick: run(() => regenerate(m.id)) }, icon('refresh', 14), ' Regenerate')))
    if (m.stopReason === 'max_tokens') notes.push(h('p', { class: 'ai-note' }, icon('info', 13), ' The reply reached the output length limit.'))
    if (m.stopReason === 'tool_limit') notes.push(h('p', { class: 'ai-note' }, icon('info', 13), ' Stopped after the maximum number of tool steps.'))
    const slot = h('div', { class: 'ai-arts-slot', 'data-mid': m.id }, ...[artCards(m.artifactIds)].filter(Boolean))
    const up = m.feedback?.rating === 'up'
    const down = m.feedback?.rating === 'down'
    const actions = h('footer', { class: 'ai-msg-actions' },
      iconButton(h, 'copy', 'Copy reply', run(async () => { toast((await copyText(m.content)) ? 'Copied' : 'Copy failed', 'info') }), { size: 15 }),
      iconButton(h, 'refresh', 'Regenerate reply', run(() => regenerate(m.id)), { size: 15 }),
      iconButton(h, 'up', 'Good reply', run(() => feedback(m, up ? null : 'up')), { size: 15, pressed: up, cls: up ? 'ai-on' : '' }),
      iconButton(h, 'down', 'Bad reply', run(() => feedback(m, down ? null : 'down')), { size: 15, pressed: down, cls: down ? 'ai-on' : '' }),
      iconButton(h, 'trash', 'Delete this reply', run(() => deleteMessage(m)), { size: 15 }),
      branchSwitcher(m),
      h('span', { class: 'ai-muted ai-usage', title: new Date(m.createdAt).toLocaleString() }, usageLine(m)))
    el.append(
      h('header', { class: 'ai-msg-meta' }, h('span', { class: 'ai-avatar', 'aria-hidden': 'true' }, 'RD'), h('span', { class: 'ai-msg-who' }, 'RD Cloude')),
      h('div', { class: 'ai-tools-slot' }, ...[toolsBlock(m.toolCalls)].filter(Boolean)), body, ...notes, slot, actions)
    return el
  }

  async function feedback(m, rating) {
    const updated = await api('POST', `/api/conversations/${encodeURIComponent(S.conv.id)}/messages/${encodeURIComponent(m.id)}/feedback`, { rating })
    const i = S.msgs.findIndex((x) => x.id === m.id)
    if (i >= 0) S.msgs[i] = { ...S.msgs[i], feedback: updated.feedback }
    const old = D.thread.querySelector(`[data-id="${CSS.escape(m.id)}"]`)
    if (old) old.replaceWith(msgEl(S.msgs[i]))
    if (rating) toast(rating === 'up' ? 'Thanks for the feedback' : 'Thanks, noted')
  }
  async function deleteMessage(m) {
    if (S.gen) return
    const what = m.role === 'user' ? 'this message and every reply below it' : 'this reply and anything that follows it on this branch'
    if (!(await confirmDialog(`Delete ${what}?`, 'Delete'))) return
    const r = await api('DELETE', `/api/conversations/${encodeURIComponent(S.conv.id)}/messages/${encodeURIComponent(m.id)}`)
    S.conv = r.conversation; S.msgs = r.messages; S.lastError = null
    upsertConv(r.conversation)
    await loadArtifacts(S.conv.id)
    drawThread(); drawMeter()
  }

  /* ------------------------------------------------------------------ artifacts panel */
  function openArtifact(id) {
    S.panelId = id
    D.panel.hidden = false
    D.root.dataset.panel = 'open'
    layout()
    D.viewer.show(id).catch((e) => toast(e.message, 'error'))
    D.thread.querySelectorAll('.ai-art-card').forEach((c) => c.classList.toggle('ai-art-card-on', c.dataset.art === id))
    if (S.stick) requestAnimationFrame(() => scrollToEnd())
  }
  function closePanel() {
    S.panelId = null
    D.panel.hidden = true
    D.root.dataset.panel = 'closed'
    layout()
    D.thread?.querySelectorAll('.ai-art-card-on').forEach((c) => c.classList.remove('ai-art-card-on'))
  }

  /* ------------------------------------------------------------------ attachments */
  function drawAttachments() {
    D.attList.hidden = !S.attachments.length
    D.attList.replaceChildren(...S.attachments.map((a, i) => h('li', { class: 'ai-att ai-att-pending' },
      icon(a.kind === 'image' ? 'image' : a.kind === 'drive' ? 'drive' : 'file', 14), h('span', { class: 'ai-att-name' }, a.name), h('span', { class: 'ai-muted ai-att-size' }, fmtSize(a.size)),
      iconButton(h, 'x', `Remove ${a.name}`, () => { S.attachments.splice(i, 1); drawAttachments() }, { size: 12, cls: 'ai-att-x' }))))
  }
  function limits() { return S.models?.limits ?? { attachmentsPerMessage: 8, imagesPerMessage: 4, textAttachmentBytes: 200000, imageBytes: 3500000, imageTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] } }
  async function addFiles(files) {
    const L = limits()
    for (const f of files) {
      if (S.attachments.length >= L.attachmentsPerMessage) { toast(`At most ${L.attachmentsPerMessage} attachments per message`, 'error'); break }
      if (L.imageTypes.includes(f.type)) {
        if (S.attachments.filter((a) => a.kind === 'image').length >= L.imagesPerMessage) { toast(`At most ${L.imagesPerMessage} images per message`, 'error'); continue }
        if (f.size > L.imageBytes) { toast(`"${f.name}" is too large (max ${fmtSize(L.imageBytes)} per image)`, 'error'); continue }
        const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = () => rej(new Error(`Could not read ${f.name}`)); r.readAsDataURL(f) })
        S.attachments.push({ kind: 'image', name: f.name || 'image', size: f.size, data })
      } else {
        if (f.size > L.textAttachmentBytes) { toast(`"${f.name}" is too large (text files up to ${fmtSize(L.textAttachmentBytes)})`, 'error'); continue }
        const text = await f.text()
        if (text.slice(0, 8192).includes('\u0000') || text.slice(0, 20000).includes('�')) { toast(`"${f.name}" is not a text or image file`, 'error'); continue }
        S.attachments.push({ kind: 'text', name: f.name || 'pasted.txt', size: f.size, content: text })
      }
    }
    drawAttachments()
  }
  function attachMenu(anchor) {
    openMenu(h, anchor, [
      { label: 'Upload from device', icon: 'clip', onclick: () => D.file.click() },
      { label: 'Add from Drive', icon: 'drive', onclick: run(openDrivePicker) },
    ], { align: 'start' })
  }
  async function openDrivePicker() {
    const { files } = await api('GET', '/api/drive/files')
    openDialog(h, {
      title: 'Attach from Drive', wide: true,
      build(body, close) {
        const picked = new Set()
        const filter = h('input', { type: 'search', class: 'ai-input', placeholder: 'Filter files', 'aria-label': 'Filter files' })
        const list = h('ul', { class: 'ai-pick' })
        const draw = () => {
          const q = filter.value.trim().toLowerCase()
          const rows = files.filter((f) => !q || f.name.toLowerCase().includes(q))
          list.replaceChildren(...(rows.length ? rows.map((f) => h('li', {}, h('label', { class: 'ai-pick-row' },
            h('input', { type: 'checkbox', checked: picked.has(f.id) || null, onchange: (e) => { e.target.checked ? picked.add(f.id) : picked.delete(f.id) } }),
            h('span', { class: 'ai-pick-name' }, f.name), h('span', { class: 'ai-muted' }, fmtSize(f.size))))) : [h('li', { class: 'ai-muted' }, files.length ? 'No files match.' : 'Your Drive is empty.')]))
        }
        filter.addEventListener('input', draw)
        draw()
        body.append(h('p', { class: 'ai-muted' }, 'Text files and images are sent to the model. Only your own files are listed.'), filter, list,
          h('div', { class: 'ai-row ai-row-end' }, h('button', { type: 'button', class: 'ai-btn', onclick: close }, 'Cancel'),
            h('button', { type: 'button', class: 'ai-btn ai-btn-primary', onclick: () => {
              for (const f of files.filter((x) => picked.has(x.id))) if (!S.attachments.some((a) => a.driveFileId === f.id) && S.attachments.length < limits().attachmentsPerMessage) S.attachments.push({ kind: 'drive', name: f.name, size: f.size, driveFileId: f.id })
              drawAttachments(); close()
            } }, 'Attach')))
      },
    })
  }

  /* ------------------------------------------------------------------ prompt library */
  async function openPrompts() {
    const { prompts } = await api('GET', '/api/prompts?limit=200')
    openDialog(h, {
      title: 'Prompt library', wide: true,
      build(body, close) {
        const filter = h('input', { type: 'search', class: 'ai-input', placeholder: 'Filter prompts', 'aria-label': 'Filter prompts' })
        const list = h('ul', { class: 'ai-pick' })
        const form = h('div', { class: 'ai-prompt-form', hidden: true })
        const draw = () => {
          const q = filter.value.trim().toLowerCase()
          const rows = prompts.filter((p) => !q || `${p.title} ${p.description} ${p.content}`.toLowerCase().includes(q))
          list.replaceChildren(...(rows.length ? rows.map((p) => h('li', {}, h('button', { type: 'button', class: 'ai-pick-btn', onclick: () => choose(p) },
            h('strong', {}, p.title), h('span', { class: 'ai-muted ai-pick-desc' }, p.description || p.content.slice(0, 100)), p.variables.length ? h('span', { class: 'ai-chip' }, `${p.variables.length} variable${p.variables.length === 1 ? '' : 's'}`) : null)))
            : [h('li', { class: 'ai-muted' }, prompts.length ? 'No prompts match.' : 'No saved prompts yet. Create some in the Prompts page.')]))
        }
        const choose = (p) => {
          list.hidden = true; filter.hidden = true; form.hidden = false
          const inputs = p.variables.map((v) => h('input', { class: 'ai-input', placeholder: v.default ?? '', 'aria-label': v.name, 'data-var': v.name }))
          const err = h('p', { class: 'ai-error', role: 'alert' })
          const insert = async () => {
            const variables = {}
            for (const i of inputs) if (i.value) variables[i.dataset.var] = i.value
            try {
              const out = await api('POST', `/api/prompts/${encodeURIComponent(p.id)}/render`, { variables })
              D.input.value = D.input.value.trim() ? `${D.input.value.trimEnd()}\n\n${out.prompt}` : out.prompt
              autosize(); saveDraft(); close(); D.input.focus()
            } catch (e) { err.textContent = e.message }
          }
          form.replaceChildren(h('h3', {}, p.title), h('pre', { class: 'ai-prompt-preview' }, p.content),
            ...p.variables.map((v, i) => h('div', { class: 'ai-field' }, h('label', {}, v.name, v.default !== undefined ? h('small', { class: 'ai-muted' }, ` (default: ${v.default || 'empty'})`) : null), inputs[i])), err,
            h('div', { class: 'ai-row ai-row-end' }, h('button', { type: 'button', class: 'ai-btn', onclick: () => { form.hidden = true; list.hidden = false; filter.hidden = false } }, 'Back'),
              h('button', { type: 'button', class: 'ai-btn ai-btn-primary', onclick: insert }, 'Insert into message')))
          inputs[0]?.focus()
        }
        filter.addEventListener('input', draw)
        draw()
        body.append(filter, list, form, h('p', { class: 'ai-muted' }, h('a', { class: 'ai-a', href: '#prompts', onclick: close }, 'Manage prompts')))
      },
    })
  }

  /* ------------------------------------------------------------------ context meter */
  function drawMeter() {
    const c = S.context
    D.meter.hidden = !c
    if (!c) return
    const pct = Math.min(100, Math.round((c.estimatedTokens / c.contextWindow) * 100))
    D.meterFill.style.width = `${Math.max(2, pct)}%`
    D.meter.classList.toggle('ai-meter-hot', pct >= 85)
    D.meterText.textContent = `${fmtTokens(c.estimatedTokens)} / ${fmtTokens(c.contextWindow)}`
    D.meter.title = `Estimated context used: about ${c.estimatedTokens.toLocaleString()} of ${c.contextWindow.toLocaleString()} tokens. Older messages are summarised automatically when the window fills up.`
  }

  /* ------------------------------------------------------------------ sending */
  function payloadAttachments() {
    return S.attachments.map((a) => (a.kind === 'text' ? { type: 'text', name: a.name, content: a.content } : a.kind === 'image' ? { type: 'image', name: a.name, data: a.data } : { type: 'drive', driveFileId: a.driveFileId, name: a.name }))
  }
  async function ensureConversation() {
    if (S.conv) return S.conv
    const d = S.draft
    const cv = await api('POST', '/api/conversations', { model: d.model, system: d.system, temperature: d.temperature, tools: d.tools, ...(d.projectId ? { projectId: d.projectId } : {}) })
    S.conv = cv
    S.convos.unshift(cv)
    pref.set('draft.new', '')
    setUrl(cv.id, false)
    return cv
  }
  async function submit() {
    const text = D.input.value
    if (!text.trim() && !S.attachments.length) return
    const attachments = payloadAttachments()
    // The server refuses bodies over 16 MiB by closing the connection (no readable error), so check the size here first.
    const approx = text.length + attachments.reduce((n, a) => n + (a.data?.length ?? a.content?.length ?? 0) + 200, 0)
    if (approx > 15 * 1024 * 1024) { showComposerError('The attachments are too large to send together (about 15 MB at most). Remove some and try again.'); return }
    const snapshot = { text, atts: S.attachments }
    D.input.value = ''
    pref.set(draftKey(), '')
    S.attachments = []
    autosize(); drawAttachments()
    try {
      await ensureConversation()
      await turn('send', { content: text, attachments, localAtts: snapshot.atts })
    } catch (e) {
      // Nothing was sent: put the message back so it is not lost.
      D.input.value = snapshot.text; S.attachments = snapshot.atts; autosize(); drawAttachments()
      showComposerError(e.message)
    }
  }
  function showComposerError(msg) { D.error.textContent = msg; D.error.hidden = false }
  async function regenerate(messageId) {
    if (S.gen) return
    const m = S.msgs.find((x) => x.id === messageId)
    if (!m) return
    const user = m.role === 'user' ? m : S.msgs.find((x) => x.id === m.parentId)
    if (!user) return
    try { await turn('regenerate', { messageId: user.id, keepThrough: user.id }) } catch (e) { toast(e.message, 'error') }
  }
  async function editMessage(messageId) {
    if (S.gen) return
    const m = S.msgs.find((x) => x.id === messageId)
    const node = D.thread.querySelector(`[data-id="${CSS.escape(messageId)}"]`)
    if (!m || !node) return
    const ta = h('textarea', { class: 'ai-input ai-textarea ai-edit-ta', rows: '3', maxlength: '100000', 'aria-label': 'Edit message' })
    ta.value = m.content
    const save = () => { const t = ta.value; if (!t.trim() && !m.attachments?.length) return; turn('edit', { messageId, content: t, keepBefore: messageId }).catch((e) => { toast(e.message, 'error'); drawThread() }) }
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save() } else if (e.key === 'Escape') { e.stopPropagation(); drawThread() } })
    node.replaceChildren(h('div', { class: 'ai-edit' }, ta,
      h('div', { class: 'ai-row ai-row-end' }, h('small', { class: 'ai-muted' }, 'Saving creates a new branch; the original stays available.'),
        h('button', { type: 'button', class: 'ai-btn', onclick: () => drawThread() }, 'Cancel'), h('button', { type: 'button', class: 'ai-btn ai-btn-primary', onclick: save }, 'Save and submit'))))
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length)
  }

  /**
   * One generation. kind: send | regenerate | edit. Streams SSE into a live assistant message, then re-syncs from the server.
   * Errors thrown before the stream starts (validation, 404, 429...) propagate so the caller can restore the draft.
   */
  async function turn(kind, o) {
    const conv = S.conv
    const base = `/api/conversations/${encodeURIComponent(conv.id)}`
    let url; let body
    const before = S.msgs
    let shown = S.msgs
    if (kind === 'send') {
      url = `${base}/messages?stream=1`
      body = { content: o.content, attachments: o.attachments?.length ? o.attachments : undefined }
      const parent = S.msgs.at(-1)
      if (parent) body.parentId = parent.id
      shown = [...S.msgs, { id: 'pending-user', role: 'user', content: o.content, attachments: (o.localAtts ?? []).map((a, i) => ({ id: `p${i}`, type: a.kind === 'image' ? 'image' : 'text', name: a.name, size: a.size, source: a.kind === 'drive' ? 'drive' : 'upload' })), status: 'complete', createdAt: new Date().toISOString() }]
    } else if (kind === 'regenerate') {
      url = `${base}/regenerate`
      body = { messageId: o.messageId }
      const i = S.msgs.findIndex((x) => x.id === o.keepThrough)
      shown = S.msgs.slice(0, i + 1)
    } else {
      url = `${base}/messages/${encodeURIComponent(o.messageId)}/edit`
      body = { content: o.content }
      const i = S.msgs.findIndex((x) => x.id === o.keepBefore)
      shown = [...S.msgs.slice(0, i), { id: 'pending-user', role: 'user', content: o.content, attachments: S.msgs[i].attachments ?? [], status: 'complete', createdAt: new Date().toISOString() }]
    }
    const gen = { convId: conv.id, ctl: new AbortController(), text: '', tools: [], detached: false, started: false, error: null, sawArtifact: false, assistantEl: null, raf: 0, lastPaint: 0, bodyEl: null, toolSlot: null, result: null }
    S.gen = gen
    S.lastError = null
    S.stick = true
    S.msgs = shown
    drawThread()
    const pending = { id: 'pending-assistant', role: 'assistant', content: '', status: 'streaming', toolCalls: [], artifactIds: [], createdAt: new Date().toISOString() }
    gen.assistantEl = msgElLive(pending)
    D.thread.append(gen.assistantEl)
    setBusy(true)
    scrollToEnd()
    announce('Assistant is responding')
    const paint = () => {
      gen.raf = 0
      if (gen.detached || !gen.bodyEl?.isConnected) return
      gen.lastPaint = performance.now()
      gen.bodyEl.replaceChildren(renderMarkdown(gen.text))
      gen.toolSlot.replaceChildren(...[toolsBlock(gen.tools)].filter(Boolean))
      if (S.stick) scrollToEnd()
    }
    const schedule = () => { if (gen.raf || gen.detached) return; const wait = Math.max(0, 50 - (performance.now() - gen.lastPaint)); gen.raf = setTimeout(() => requestAnimationFrame(paint), wait) }
    let finished = false
    try {
      finished = await streamSse(url, token(), body, {
        signal: gen.ctl.signal,
        onEvent(name, d) {
          gen.started = true
          if (name === 'message_start') {
            if (d.conversation) { S.conv = d.conversation; upsertConv(d.conversation) }
            if (d.context) { S.context = { estimatedTokens: d.context.estimatedTokens, contextWindow: d.context.contextWindow, model: S.conv?.model }; if (!gen.detached) drawMeter() }
            if (d.userMessage && !gen.detached) gen.assistantEl.previousElementSibling?.setAttribute('data-id', d.userMessage.id)
            if (!gen.detached) drawHeader()
          } else if (name === 'delta') { gen.text += d.text; schedule() }
          else if (name === 'tool_use') { gen.tools.push({ id: d.id, name: d.name, input: d.input, pending: true }); schedule() }
          else if (name === 'tool_result') { const t = gen.tools.find((x) => x.id === d.id); if (t) Object.assign(t, { output: d.output, isError: d.isError, ms: d.ms, pending: false }); schedule() }
          else if (name === 'retry') { if (!gen.detached) gen.assistantEl.querySelector('.ai-live-note')?.replaceChildren(`The model is busy, retrying (attempt ${d.attempt})...`) }
          else if (name === 'artifact') {
            S.arts.set(d.artifact.id, d.artifact)
            if (!gen.detached && !gen.sawArtifact && window.innerWidth >= 1040) { gen.sawArtifact = true; openArtifact(d.artifact.id) }
            else if (!gen.detached && S.panelId === d.artifact.id) D.viewer.show(d.artifact.id, { keepTab: true }).catch(() => {})
          } else if (name === 'title') { if (S.conv) { S.conv = { ...S.conv, title: d.title }; upsertConv(S.conv); drawHeader() } }
          else if (name === 'error') gen.error = d
          else if (name === 'done') gen.result = d
        },
      })
    } catch (e) {
      if (!gen.started && e.name !== 'AbortError') { // nothing came back (validation error, 429, or the network failed before the first event)
        clearTimeout(gen.raf)
        if (S.gen === gen) S.gen = null
        setBusy(false)
        if (!gen.detached) { S.msgs = before; drawThread() } // nothing reached the server: show the thread as it was
        throw e
      }
      if (e.name !== 'AbortError') gen.error = gen.error ?? { message: 'The connection to the server was lost.' }
    }
    clearTimeout(gen.raf)
    clearTimeout(gen.stopTimer)
    const wasDetached = gen.detached
    if (S.gen === gen) S.gen = null
    S.bg.delete(conv.id)
    setBusy(false)
    if (!finished && !gen.result && !gen.error) gen.error = { message: 'The reply was cut off.' }
    if (gen.result?.conversation) { upsertConv(gen.result.conversation) }
    if (gen.error && !gen.result?.assistantMessage) S.lastError = { message: gen.error.message }
    announce(gen.error ? 'The reply failed' : 'Response complete')
    if (wasDetached || S.conv?.id !== conv.id) { drawSidebar(); return }
    try { await reloadActive() } catch { S.lastError = S.lastError ?? { message: 'Could not refresh the conversation.' }; drawThread() }
    if (gen.result?.context) { S.context = { estimatedTokens: gen.result.context.estimatedTokens, contextWindow: gen.result.context.contextWindow }; drawMeter() }
    if (!coarse()) D.input.focus()
  }
  function msgElLive(m) {
    const el = msgEl(m)
    el.setAttribute('data-status', 'streaming')
    S.gen.assistantEl = el
    const bodyEl = el.querySelector('.ai-msg-body')
    bodyEl.setAttribute('aria-busy', 'true')
    bodyEl.classList.add('ai-streaming')
    S.gen.bodyEl = bodyEl
    S.gen.toolSlot = el.querySelector('.ai-tools-slot')
    el.querySelector('.ai-msg-actions')?.remove()
    el.append(h('p', { class: 'ai-note ai-live-note' }))
    bodyEl.append(h('span', { class: 'ai-typing', role: 'img', 'aria-label': 'Thinking' }, h('i', {}), h('i', {}), h('i', {})))
    return el
  }
  function setBusy(busy) {
    D.send.replaceChildren(icon(busy ? 'stop' : 'send', 18))
    D.send.setAttribute('aria-label', busy ? 'Stop generating' : 'Send message')
    D.send.title = busy ? 'Stop (Esc)' : 'Send (Enter)'
    D.send.classList.toggle('ai-send-stop', busy)
    D.composer.classList.toggle('ai-busy', busy)
    D.hintStop.hidden = !busy
  }
  /** Stop the reply: ask the server (it finishes with a `done` event and keeps the partial text); abort the request if it does not. */
  async function stop(wait = false) {
    const g = S.gen
    if (!g) return
    api('POST', `/api/conversations/${encodeURIComponent(g.convId)}/stop`).catch(() => {})
    g.stopTimer = setTimeout(() => g.ctl.abort(), 4000)
    if (wait) { for (let i = 0; i < 40 && S.gen === g; i++) await new Promise((r) => setTimeout(r, 100)) }
  }
  /** Leaving a chat while it streams: keep the request alive (the server finishes and saves the reply), but stop touching the DOM. */
  function detachGen() {
    const g = S.gen
    if (!g) return
    g.detached = true
    S.bg.add(g.convId)
    S.gen = null
    setBusy(false)
  }

  /* ------------------------------------------------------------------ teardown */
  function destroy() {
    S.dead = true
    clearTimeout(S.pollTimer)
    detachGen()
    for (const d of disposers) { try { d() } catch { /* ignore */ } }
    D.viewer?.destroy()
    D.root?.remove()
    document.querySelectorAll('.ai-menu').forEach((m) => m.remove())
  }

  return { start, destroy }
}

export default [
  { id: 'chat', title: 'Chat', group: 'AI', order: 10, render },
]
