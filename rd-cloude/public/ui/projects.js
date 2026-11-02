// Projects (shared instructions + knowledge files for a group of chats) and the Prompt library (saved prompts with {{variables}}).
// Backend: src/ai.js (docs/ai.md). Replaces the built-in `projects` view (same id) and adds `prompts`.
// DOM is built with h() only: names, instructions and file contents are always text nodes or textarea values.
import { icon, iconButton, openDialog, openMenu, relTime, fmtSize, fmtTokens, copyText } from '/ui/artifacts.js'

let fieldSeq = 0
function field(h, label, input, hint) {
  const id = `ai-pf-${++fieldSeq}`
  input.id = id
  return h('div', { class: 'ai-field' }, h('label', { for: id }, label), input, hint ? h('small', { class: 'ai-muted' }, hint) : null)
}
const counter = (h, ta, max) => {
  const out = h('small', { class: 'ai-muted ai-counter' })
  const upd = () => { out.textContent = `${ta.value.length.toLocaleString()} / ${max.toLocaleString()} characters`; out.classList.toggle('ai-error', ta.value.length > max) }
  ta.addEventListener('input', upd)
  upd()
  return out
}
const errorBlock = (h, e) => h('div', { class: 'ai-page' }, h('p', { class: 'ai-error', role: 'alert' }, e.message), h('a', { class: 'ai-a', href: '#projects' }, 'Back to projects'))

/* ================================================================================================ projects */

async function renderProjects(el, arg, lib) {
  if (arg) return renderProject(el, decodeURIComponent(arg), lib)
  const { h, api, toast } = lib
  const state = { items: [], next: null }
  const list = h('div', { class: 'ai-cards' })
  const more = h('button', { type: 'button', class: 'ai-btn', hidden: true }, 'Load more')
  const empty = h('p', { class: 'ai-muted', hidden: true }, 'No projects yet. A project bundles instructions and reference files that every chat inside it can use.')

  const name = h('input', { class: 'ai-input', maxlength: '100', required: true, placeholder: 'e.g. Website redesign', autocomplete: 'off' })
  const desc = h('input', { class: 'ai-input', maxlength: '500', placeholder: 'What is this project about? (optional)', autocomplete: 'off' })
  const err = h('p', { class: 'ai-error', role: 'alert' })
  const form = h('form', { class: 'ai-card ai-form', onsubmit: async (e) => {
    e.preventDefault()
    err.textContent = ''
    try {
      const p = await api('POST', '/api/projects', { name: name.value, description: desc.value })
      location.hash = `#projects/${encodeURIComponent(p.id)}`
    } catch (ex) { err.textContent = ex.message }
  } }, h('h2', { class: 'ai-card-h' }, 'New project'), field(h, 'Name', name), field(h, 'Description', desc), err,
  h('div', { class: 'ai-row' }, h('button', { type: 'submit', class: 'ai-btn ai-btn-primary' }, icon('plus', 14), ' Create project')))

  const draw = () => {
    empty.hidden = state.items.length > 0
    more.hidden = !state.next
    list.replaceChildren(...state.items.map((p) => h('article', { class: 'ai-card ai-project' },
      h('h3', { class: 'ai-card-h' }, h('a', { href: `#projects/${encodeURIComponent(p.id)}`, class: 'ai-card-link' }, icon('folder', 16), ' ', p.name)),
      h('p', { class: 'ai-muted ai-card-desc' }, p.description || (p.instructions ? p.instructions.slice(0, 120) : 'No description')),
      h('p', { class: 'ai-muted ai-card-meta' }, `${p.fileCount} file${p.fileCount === 1 ? '' : 's'} · ${p.conversationCount} chat${p.conversationCount === 1 ? '' : 's'} · updated ${relTime(p.updatedAt)}`),
      h('div', { class: 'ai-row' },
        h('button', { type: 'button', class: 'ai-btn ai-btn-primary', onclick: () => newChatIn(lib, p.id).catch((e) => toast(e.message, 'error')) }, 'New chat'),
        h('a', { class: 'ai-btn', href: `#projects/${encodeURIComponent(p.id)}` }, 'Open'),
        iconButton(h, 'trash', `Delete project ${p.name}`, async () => {
          if (!(await lib.confirmDialog(`Delete project "${p.name}"? Its chats are kept but no longer use its instructions and files.`, 'Delete'))) return
          try { await api('DELETE', `/api/projects/${encodeURIComponent(p.id)}`); state.items = state.items.filter((x) => x.id !== p.id); draw(); toast('Project deleted') } catch (ex) { toast(ex.message, 'error') }
        })))))
  }
  async function load(append = false) {
    const r = await api('GET', `/api/projects?limit=50${append && state.next ? `&cursor=${encodeURIComponent(state.next)}` : ''}`)
    state.items = append ? [...state.items, ...r.projects] : r.projects
    state.next = r.nextCursor
    draw()
  }
  more.addEventListener('click', () => load(true).catch((e) => toast(e.message, 'error')))
  el.append(h('div', { class: 'ai-page ai-projects' },
    h('h1', { class: 'ai-page-title' }, 'Projects'),
    h('p', { class: 'ai-muted' }, 'Group related chats. Instructions and knowledge files you add to a project are included in the context of every chat inside it.'),
    form, h('h2', { class: 'ai-section-h' }, 'Your projects'), empty, list, more))
  await load()
}

async function newChatIn(lib, projectId) {
  const c = await lib.api('POST', '/api/conversations', { projectId })
  location.hash = `#chat/${encodeURIComponent(c.id)}`
}

async function renderProject(el, id, lib) {
  const { h, api, toast } = lib
  let p
  try { p = await api('GET', `/api/projects/${encodeURIComponent(id)}`) } catch (e) { el.append(errorBlock(h, e)); return }
  const root = h('div', { class: 'ai-page ai-project-page' })
  el.append(root)

  async function refresh() {
    p = await api('GET', `/api/projects/${encodeURIComponent(id)}`)
    await draw()
  }

  function detailsCard() {
    const name = h('input', { class: 'ai-input', maxlength: '100', required: true, value: p.name })
    const desc = h('input', { class: 'ai-input', maxlength: '500', value: p.description })
    const ins = h('textarea', { class: 'ai-input ai-textarea', rows: '8', maxlength: '20000', placeholder: 'How should the assistant behave in this project? Tone, audience, rules, output format...' })
    ins.value = p.instructions
    const notes = h('textarea', { class: 'ai-input ai-textarea', rows: '5', maxlength: '100000', placeholder: 'Background facts the assistant should always know (optional). For longer material add knowledge files below.' })
    notes.value = p.knowledge ?? ''
    const msg = h('p', { class: 'ai-muted', role: 'status' })
    return h('form', { class: 'ai-card ai-form', onsubmit: async (e) => {
      e.preventDefault()
      msg.textContent = 'Saving...'
      try {
        p = { ...p, ...(await api('PATCH', `/api/projects/${encodeURIComponent(id)}`, { name: name.value, description: desc.value, instructions: ins.value, knowledge: notes.value })) }
        msg.textContent = 'Saved.'
        toast('Project saved')
        title.textContent = p.name
      } catch (ex) { msg.textContent = ''; msg.classList.add('ai-error'); msg.textContent = ex.message; setTimeout(() => msg.classList.remove('ai-error'), 6000) }
    } },
    h('h2', { class: 'ai-card-h' }, 'Instructions'),
    field(h, 'Name', name), field(h, 'Description', desc),
    field(h, 'Custom instructions', ins, 'Added to the system prompt of every chat in this project.'), counter(h, ins, 20000),
    field(h, 'Project notes', notes), counter(h, notes, 100000),
    h('div', { class: 'ai-row' }, h('button', { type: 'submit', class: 'ai-btn ai-btn-primary' }, 'Save changes'), msg))
  }

  function filesCard() {
    const total = p.files.reduce((s, f) => s + f.size, 0)
    const tokens = p.files.reduce((s, f) => s + (f.tokens ?? 0), 0)
    const picker = h('input', { type: 'file', class: 'ai-offscreen', multiple: true, tabindex: '-1', 'aria-hidden': 'true', accept: 'text/*,.md,.txt,.json,.csv,.js,.ts,.py,.html,.css,.yml,.yaml,.xml,.sql,.log,.sh,.go,.rs,.java,.c,.cpp,.h', onchange: async () => {
      const files = [...picker.files]
      picker.value = ''
      let ok = 0
      for (const f of files) {
        try {
          if (f.size > 200_000) throw new Error(`${f.name} is larger than 200 KB`)
          const content = await f.text()
          if (content.slice(0, 8192).includes('\u0000')) throw new Error(`${f.name} is not a text file`)
          await api('POST', `/api/projects/${encodeURIComponent(id)}/files`, { name: f.name, content })
          ok++
        } catch (ex) { toast(ex.message, 'error') }
      }
      if (ok) toast(`${ok} file${ok === 1 ? '' : 's'} added`)
      await refresh()
    } })
    const rows = p.files.map((f) => h('li', { class: 'ai-file' },
      icon(f.source === 'drive' ? 'drive' : 'file', 16),
      h('span', { class: 'ai-file-name' }, h('strong', {}, f.name), h('small', { class: 'ai-muted' }, ` ${fmtSize(f.size)} · ~${fmtTokens(f.tokens ?? 0)} tokens${f.source === 'drive' ? ' · from Drive' : ''}${f.truncated ? ' · truncated' : ''}`)),
      iconButton(h, 'eye', `View ${f.name}`, async () => {
        try {
          const full = await api('GET', `/api/projects/${encodeURIComponent(id)}/files/${encodeURIComponent(f.id)}`)
          openDialog(h, { title: f.name, wide: true, build: (b) => b.append(h('pre', { class: 'ai-file-pre', tabindex: '0' }, full.content)) })
        } catch (ex) { toast(ex.message, 'error') }
      }),
      iconButton(h, 'trash', `Remove ${f.name}`, async () => {
        if (!(await lib.confirmDialog(`Remove "${f.name}" from this project?`, 'Remove'))) return
        try { await api('DELETE', `/api/projects/${encodeURIComponent(id)}/files/${encodeURIComponent(f.id)}`); await refresh() } catch (ex) { toast(ex.message, 'error') }
      })))
    return h('section', { class: 'ai-card' },
      h('h2', { class: 'ai-card-h' }, 'Knowledge files'),
      h('p', { class: 'ai-muted' }, 'Text files the assistant can draw on in every chat of this project. They are sent as reference material (not as instructions), cut to fit the model context, and count towards token usage.'),
      p.files.length ? h('ul', { class: 'ai-files' }, ...rows) : h('p', { class: 'ai-muted' }, 'No files yet.'),
      h('p', { class: 'ai-muted ai-card-meta' }, `${p.files.length} of 50 files · ${fmtSize(total)} · about ${fmtTokens(tokens)} tokens`),
      h('div', { class: 'ai-row' },
        h('button', { type: 'button', class: 'ai-btn', onclick: () => picker.click() }, icon('plus', 14), ' Upload text files'),
        h('button', { type: 'button', class: 'ai-btn', onclick: () => pasteDialog() }, icon('edit', 14), ' Paste text'),
        h('button', { type: 'button', class: 'ai-btn', onclick: () => driveDialog().catch((e) => toast(e.message, 'error')) }, icon('drive', 14), ' Add from Drive')),
      picker)
  }

  function pasteDialog() {
    openDialog(h, {
      title: 'Add text to the project',
      build(body, close) {
        const name = h('input', { class: 'ai-input', maxlength: '100', placeholder: 'notes.md', required: true })
        const content = h('textarea', { class: 'ai-input ai-textarea', rows: '10', placeholder: 'Paste text here' })
        const err = h('p', { class: 'ai-error', role: 'alert' })
        body.append(field(h, 'File name', name), field(h, 'Content', content), err,
          h('div', { class: 'ai-row ai-row-end' }, h('button', { type: 'button', class: 'ai-btn', onclick: close }, 'Cancel'),
            h('button', { type: 'button', class: 'ai-btn ai-btn-primary', onclick: async (e) => {
              const btn = e.currentTarget; btn.disabled = true
              try { await api('POST', `/api/projects/${encodeURIComponent(id)}/files`, { name: name.value, content: content.value }); close(); await refresh() } catch (ex) { err.textContent = ex.message; btn.disabled = false }
            } }, 'Add')))
      },
    })
  }
  async function driveDialog() {
    const { files } = await api('GET', '/api/drive/files')
    openDialog(h, {
      title: 'Add from Drive', wide: true,
      build(body, close) {
        const have = new Set(p.files.map((f) => f.name))
        const err = h('p', { class: 'ai-error', role: 'alert' })
        body.append(h('p', { class: 'ai-muted' }, 'Only text files (up to 200 KB) can be used as knowledge. Your own Drive files only.'),
          files.length ? h('ul', { class: 'ai-pick' }, ...files.map((f) => h('li', {}, h('button', { type: 'button', class: 'ai-pick-btn', onclick: async (e) => {
            const btn = e.currentTarget; btn.disabled = true
            try { await api('POST', `/api/projects/${encodeURIComponent(id)}/files`, { driveFileId: f.id }); close(); await refresh(); toast(`${f.name} added`) } catch (ex) { err.textContent = ex.message; btn.disabled = false }
          } }, h('strong', {}, f.name), h('span', { class: 'ai-muted' }, `${fmtSize(f.size)}${have.has(f.name) ? ' · already added' : ''}`))))) : h('p', { class: 'ai-muted' }, 'Your Drive is empty.'), err)
      },
    })
  }

  async function chatsCard() {
    let convs = []
    try { convs = (await api('GET', `/api/conversations?projectId=${encodeURIComponent(id)}&archived=all&limit=50`)).conversations } catch { /* shown as empty */ }
    return h('section', { class: 'ai-card' },
      h('h2', { class: 'ai-card-h' }, 'Chats in this project'),
      h('div', { class: 'ai-row' }, h('button', { type: 'button', class: 'ai-btn ai-btn-primary', onclick: () => newChatIn(lib, id).catch((e) => toast(e.message, 'error')) }, icon('plus', 14), ' New chat in this project')),
      convs.length ? h('ul', { class: 'ai-files' }, ...convs.map((c) => h('li', { class: 'ai-file' }, icon('file', 16),
        h('a', { class: 'ai-file-name', href: `#chat/${encodeURIComponent(c.id)}` }, c.title, c.archived ? h('small', { class: 'ai-muted' }, ' (archived)') : null), h('small', { class: 'ai-muted' }, relTime(c.lastMessageAt))))) : h('p', { class: 'ai-muted' }, 'No chats yet.'))
  }

  const title = h('h1', { class: 'ai-page-title' }, p.name)
  async function draw() {
    const chats = await chatsCard()
    root.replaceChildren(
      h('a', { href: '#projects', class: 'ai-back' }, icon('left', 14), ' All projects'),
      title,
      h('p', { class: 'ai-muted' }, `Created ${relTime(p.createdAt)} · ${p.conversationCount} chat${p.conversationCount === 1 ? '' : 's'}`),
      detailsCard(), filesCard(), chats,
      h('section', { class: 'ai-card ai-danger-zone' }, h('h2', { class: 'ai-card-h' }, 'Delete project'),
        h('p', { class: 'ai-muted' }, 'Chats are kept but stop using this project’s instructions and files. Knowledge files are deleted.'),
        h('button', { type: 'button', class: 'ai-btn ai-btn-danger', onclick: async () => {
          if (!(await lib.confirmDialog(`Delete project "${p.name}"?`, 'Delete'))) return
          try { await api('DELETE', `/api/projects/${encodeURIComponent(id)}`); toast('Project deleted'); location.hash = '#projects' } catch (ex) { toast(ex.message, 'error') }
        } }, icon('trash', 14), ' Delete project')))
  }
  await draw()
}

/* ================================================================================================ prompt library */

const VAR_RE = /\{\{\s*([A-Za-z_][\w-]{0,31})\s*(?:\|([^}]{0,200}))?\}\}/g
const variablesOf = (text) => {
  const seen = new Map()
  for (const m of text.matchAll(VAR_RE)) if (!seen.has(m[1])) seen.set(m[1], m[2]?.trim())
  return [...seen].map(([name, dflt]) => ({ name, default: dflt }))
}

async function renderPrompts(el, _arg, lib) {
  const { h, api, toast } = lib
  const state = { items: [], next: null, q: '' }
  const list = h('div', { class: 'ai-cards' })
  const more = h('button', { type: 'button', class: 'ai-btn', hidden: true }, 'Load more')
  const status = h('p', { class: 'ai-muted', role: 'status' })
  const search = h('input', { type: 'search', class: 'ai-input', placeholder: 'Search prompts', 'aria-label': 'Search prompts' })

  function editDialog(p) {
    openDialog(h, {
      title: p ? 'Edit prompt' : 'New prompt', wide: true,
      build(body, close) {
        const title = h('input', { class: 'ai-input', maxlength: '100', required: true, value: p?.title ?? '' })
        const description = h('input', { class: 'ai-input', maxlength: '500', value: p?.description ?? '' })
        const content = h('textarea', { class: 'ai-input ai-textarea', rows: '9', maxlength: '20000', placeholder: 'Summarise {{topic}} for {{audience|a general reader}} in {{words|150}} words.' })
        content.value = p?.content ?? ''
        const tags = h('input', { class: 'ai-input', value: (p?.tags ?? []).join(', '), placeholder: 'writing, summaries' })
        const vars = h('p', { class: 'ai-muted ai-vars' })
        const upd = () => { const v = variablesOf(content.value); vars.replaceChildren(v.length ? 'Variables: ' : 'No variables yet. ', ...v.map((x) => h('span', { class: 'ai-chip' }, x.default !== undefined ? `${x.name} = ${x.default || '""'}` : x.name))) }
        content.addEventListener('input', upd)
        upd()
        const err = h('p', { class: 'ai-error', role: 'alert' })
        body.append(field(h, 'Title', title), field(h, 'Description', description),
          field(h, 'Prompt', content, 'Use {{name}} for a variable you fill in each time, or {{name|default}} to give it a default value.'), vars,
          field(h, 'Tags', tags, 'Comma separated, up to 10.'), err,
          h('div', { class: 'ai-row ai-row-end' }, h('button', { type: 'button', class: 'ai-btn', onclick: close }, 'Cancel'),
            h('button', { type: 'button', class: 'ai-btn ai-btn-primary', onclick: async (e) => {
              const btn = e.currentTarget; btn.disabled = true
              const payload = { title: title.value, description: description.value, content: content.value, tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean) }
              try {
                if (p) await api('PUT', `/api/prompts/${encodeURIComponent(p.id)}`, payload); else await api('POST', '/api/prompts', payload)
                close(); toast('Prompt saved'); await load()
              } catch (ex) { err.textContent = ex.message; btn.disabled = false }
            } }, 'Save prompt')))
        setTimeout(() => title.focus(), 0)
      },
    })
  }

  function useDialog(p) {
    openDialog(h, {
      title: p.title, wide: true,
      build(body, close) {
        const inputs = p.variables.map((v) => h('input', { class: 'ai-input', placeholder: v.default ?? '', 'data-var': v.name }))
        const preview = h('pre', { class: 'ai-prompt-preview', 'aria-live': 'polite' })
        const err = h('p', { class: 'ai-error', role: 'alert' })
        let current = ''
        const render = async () => {
          const variables = {}
          for (const i of inputs) if (i.value) variables[i.dataset.var] = i.value
          try { const r = await api('POST', `/api/prompts/${encodeURIComponent(p.id)}/render`, { variables }); current = r.prompt; preview.textContent = r.prompt; err.textContent = '' } catch (ex) { current = ''; err.textContent = ex.message }
        }
        body.append(p.description ? h('p', { class: 'ai-muted' }, p.description) : null,
          ...p.variables.map((v, i) => field(h, v.name, inputs[i], v.default !== undefined ? `Default: ${v.default || '(empty)'}` : 'Required')),
          h('div', { class: 'ai-row' }, h('button', { type: 'button', class: 'ai-btn', onclick: render }, icon('refresh', 14), ' Fill in variables')), preview, err,
          h('div', { class: 'ai-row ai-row-end' },
            h('button', { type: 'button', class: 'ai-btn', onclick: async () => { if (!current) await render(); if (current) toast((await copyText(current)) ? 'Copied' : 'Copy failed') } }, icon('copy', 14), ' Copy'),
            h('button', { type: 'button', class: 'ai-btn ai-btn-primary', onclick: async () => {
              if (!current) await render()
              if (!current) return
              try { sessionStorage.setItem('rd.ai.pendingPrompt', current) } catch { toast('Could not hand the prompt to the chat; copy it instead', 'error'); return }
              close()
              location.hash = '#chat'
            } }, 'Start a chat with this')))
        if (!p.variables.length) render()
        inputs[0]?.focus()
      },
    })
  }

  const draw = () => {
    more.hidden = !state.next
    status.textContent = state.items.length ? '' : (state.q ? 'No prompts match.' : 'No saved prompts yet. Create your first one.')
    list.replaceChildren(...state.items.map((p) => h('article', { class: 'ai-card ai-prompt' },
      h('h3', { class: 'ai-card-h' }, p.title),
      p.description ? h('p', { class: 'ai-muted ai-card-desc' }, p.description) : null,
      h('p', { class: 'ai-prompt-text' }, p.content.length > 220 ? `${p.content.slice(0, 220)}...` : p.content),
      h('div', { class: 'ai-chips' }, ...p.variables.map((v) => h('span', { class: 'ai-chip' }, v.name)), ...p.tags.map((t) => h('span', { class: 'ai-chip ai-chip-tag' }, `#${t}`))),
      h('p', { class: 'ai-muted ai-card-meta' }, `Used ${p.uses} time${p.uses === 1 ? '' : 's'} · updated ${relTime(p.updatedAt)}`),
      h('div', { class: 'ai-row' },
        h('button', { type: 'button', class: 'ai-btn ai-btn-primary', onclick: () => useDialog(p) }, 'Use'),
        iconButton(h, 'more', `Actions for ${p.title}`, (e) => openMenu(h, e.currentTarget, [
          { label: 'Edit', icon: 'edit', onclick: () => editDialog(p) },
          { label: 'Duplicate', icon: 'copy', onclick: async () => { try { await api('POST', '/api/prompts', { title: `${p.title} copy`.slice(0, 100), description: p.description, content: p.content, tags: p.tags }); toast('Duplicated'); await load() } catch (ex) { toast(ex.message, 'error') } } },
          'sep',
          { label: 'Delete', icon: 'trash', danger: true, onclick: async () => {
            if (!(await lib.confirmDialog(`Delete the prompt "${p.title}"?`, 'Delete'))) return
            try { await api('DELETE', `/api/prompts/${encodeURIComponent(p.id)}`); toast('Prompt deleted'); await load() } catch (ex) { toast(ex.message, 'error') }
          } },
        ]))))))
  }
  async function load(append = false) {
    const params = new URLSearchParams({ limit: '50' })
    if (state.q) params.set('q', state.q)
    if (append && state.next) params.set('cursor', state.next)
    const r = await api('GET', `/api/prompts?${params}`)
    state.items = append ? [...state.items, ...r.prompts] : r.prompts
    state.next = r.nextCursor
    draw()
  }
  let timer
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = search.value.trim(); load().catch((e) => toast(e.message, 'error')) }, 250) })
  more.addEventListener('click', () => load(true).catch((e) => toast(e.message, 'error')))
  el.append(h('div', { class: 'ai-page ai-prompts' },
    h('h1', { class: 'ai-page-title' }, 'Prompt library'),
    h('p', { class: 'ai-muted' }, 'Save prompts you reuse. Put variables in double braces, like {{topic}} or {{tone|friendly}}, and fill them in when you use the prompt. In a chat, the sparkle button next to the message box inserts a saved prompt.'),
    h('div', { class: 'ai-row' }, search, h('button', { type: 'button', class: 'ai-btn ai-btn-primary', onclick: () => editDialog(null) }, icon('plus', 14), ' New prompt')),
    status, list, more))
  await load()
}

export default [
  { id: 'projects', title: 'Projects', group: 'AI', order: 20, render: renderProjects },
  { id: 'prompts', title: 'Prompts', group: 'AI', order: 25, render: renderPrompts },
]
