const put = (el, ...kids) => el.append(...kids.flat(Infinity).filter((x) => x != null && x !== false))
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((x) => x != null && x !== false))
const TABS = [['docs', 'Documents'], ['indexes', 'Indexes'], ['schema', 'Schema'], ['live', 'Live'], ['settings', 'Settings']]
const pretty = (v) => JSON.stringify(v, null, 2)
const snippet = (v) => { const s = JSON.stringify(v); return s.length > 160 ? `${s.slice(0, 160)}…` : s }

export default {
  id: 'database', title: 'Database', group: 'Cloud', order: 30,
  async render(el, arg, lib) {
    const { h, api, act, toast, rerender, confirmDialog, promptDialog, download, state } = lib
    const [coll, tabArg] = (arg ?? '').split('/')
    const tab = TABS.some(([id]) => id === tabArg) ? tabArg : 'docs'
    const { collections, totalDocuments, limits } = await api('GET', '/api/db')
    const known = new Set(collections.map((c) => c.name))

    const side = h('aside', { class: 'db-side', 'aria-label': 'Collections' }, h('h3', {}, `Collections (${totalDocuments.toLocaleString()} docs)`))
    for (const c of collections) side.append(h('button', { class: 'db-coll', 'aria-current': c.name === coll ? 'true' : null, onclick: () => (location.hash = `#database/${c.name}`) }, h('span', {}, c.name), h('span', { class: 'cnt' }, c.count.toLocaleString())))
    const nameBox = h('input', { placeholder: 'new-collection', 'aria-label': 'New collection name', maxlength: 64 })
    put(side, h('div', { class: 'db-row' }, nameBox, h('button', { class: 'sec', onclick: () => { if (nameBox.value.trim()) location.hash = `#database/${nameBox.value.trim()}` } }, 'Open')))

    const main = h('div', {})
    put(el, h('h1', {}, 'Database'), h('div', { class: 'db-layout' }, side, main))
    if (!coll) { put(main, h('p', { class: 'muted' }, collections.length ? 'Choose a collection, or type a new name to create one on first insert.' : 'No collections yet. Type a name on the left and add your first document.'), h('p', { class: 'muted' }, `Limits: ${limits.documents.toLocaleString()} documents, ${(limits.documentBytes / 1024).toFixed(0)} KB per document.`)); return }
    const info = collections.find((c) => c.name === coll)

    put(main, h('h2', {}, coll), h('div', { class: 'db-tabs', role: 'tablist' }, TABS.map(([id, label]) => h('button', { role: 'tab', 'aria-selected': id === tab ? 'true' : 'false', onclick: () => (location.hash = `#database/${coll}/${id}`) }, label))))
    const body = h('div', {})
    main.append(body)
    const base = `/api/db/${encodeURIComponent(coll)}`

    function errorBox(e) {
      const box = h('div', { class: 'db-errors', role: 'alert' }, h('b', {}, e.message))
      if (e.data?.errors?.length) box.append(h('ul', {}, e.data.errors.map((x) => h('li', {}, `${x.path}: ${x.message}`))))
      return box
    }
    function editor(title, initial, onSave) {
      const d = h('dialog', { class: 'db-dlg', 'aria-label': title })
      const ta = h('textarea', { class: 'db-code', spellcheck: 'false', 'aria-label': 'JSON document', style: { minHeight: '260px' } }); ta.value = pretty(initial)
      const err = h('div')
      const close = () => { d.close(); d.remove() }
      d.addEventListener('cancel', close)
      put(d, h('h3', {}, title), ta, err, h('div', { class: 'db-row' }, h('button', { class: 'sec', onclick: close }, 'Cancel'), h('button', { onclick: async () => {
        let v; try { v = JSON.parse(ta.value) } catch (e) { fill(err, errorBox(new Error(`Invalid JSON: ${e.message}`))); return }
        try { await onSave(v); close(); rerender() } catch (e) { fill(err, errorBox(e)) }
      } }, 'Save')))
      document.body.append(d); d.showModal(); ta.focus()
    }

    /* ------------------------------------------------------------ documents */
    if (tab === 'docs') {
      const where = h('textarea', { class: 'db-code', spellcheck: 'false', 'aria-label': 'Query (where) as JSON', placeholder: '{"age": {"$gt": 21}, "city": "Oslo"}' }); where.value = sessionStorage.getItem(`rd_dbq_${coll}`) ?? '{}'
      const sort = h('input', { placeholder: 'sort: -age,name', 'aria-label': 'Sort' })
      const limit = h('input', { type: 'number', min: '1', max: '1000', value: '25', 'aria-label': 'Limit', style: { width: '80px' } })
      const out = h('div'), meta = h('div', { class: 'db-plan', 'aria-live': 'polite' })
      let cursor = null
      const run = async (append = false) => {
        let w; try { w = JSON.parse(where.value || '{}') } catch (e) { fill(out, errorBox(new Error(`Invalid JSON in query: ${e.message}`))); return }
        sessionStorage.setItem(`rd_dbq_${coll}`, where.value)
        try {
          const r = await api('POST', `${base}/query`, { where: w, sort: sort.value || undefined, limit: Number(limit.value) || 25, cursor: append ? cursor : undefined })
          cursor = r.nextCursor
          const rows = r.documents.map((d) => h('tr', {}, h('td', { class: 'db-id' }, d.id, h('div', {}, `v${d.version}`)), h('td', { class: 'json', title: snippet(d.data) }, snippet(d.data)),
            h('td', {}, h('button', { class: 'sec', onclick: () => editor(`Edit ${d.id}`, d.data, async (v) => { await api('PUT', `${base}/${d.id}`, v, { headers: { 'if-match': String(d.version) } }); toast('Saved', 'info') }) }, 'Edit'), ' ',
              h('button', { class: 'sec', onclick: act(async () => { if (await confirmDialog(`Delete ${d.id}?`, 'Delete')) { await api('DELETE', `${base}/${d.id}`); run() } }) }, 'Delete'))))
          if (append) put(out.querySelector('tbody'), rows)
          else fill(out, r.documents.length ? h('table', { class: 'db-table' }, h('thead', {}, h('tr', {}, ['ID', 'Document', ''].map((x) => h('th', {}, x)))), h('tbody', {}, rows)) : h('p', { class: 'muted' }, 'No documents match.'))
          meta.textContent = `${r.total.toLocaleString()} match · plan: ${r.plan.type}${r.plan.index ? ` (${r.plan.index})` : ''}, scanned ${r.plan.scanned.toLocaleString()}`
          out.querySelector('.more')?.remove()
          if (cursor) out.append(h('button', { class: 'sec more', onclick: act(() => run(true)) }, 'Load more'))
        } catch (e) { fill(out, errorBox(e)) }
      }
      put(body, where, h('div', { class: 'db-row' }, sort, limit, h('button', { onclick: act(() => run()) }, 'Run query'),
        h('button', { class: 'sec', onclick: act(async () => { let w = {}; try { w = JSON.parse(where.value || '{}') } catch { /* explain reports */ } const r = await api('POST', `${base}/explain`, { where: w }); toast(`Plan: ${r.plan.type}${r.plan.index ? ' via ' + r.plan.index : ''} (${r.plan.scanned} scanned)`, 'info') }) }, 'Explain'),
        h('button', { class: 'sec', onclick: () => editor('New document', {}, async (v) => { await api('POST', base, v) }) }, 'New document')), meta, out)
      await run()
    }

    /* ------------------------------------------------------------ indexes */
    if (tab === 'indexes') {
      const { indexes } = await api('GET', `${base}/indexes`)
      const field = h('input', { placeholder: 'field.path', 'aria-label': 'Field path' }), uniq = h('input', { type: 'checkbox', id: 'db-uniq' })
      put(body, h('p', { class: 'muted' }, 'Indexes speed up equality and $in queries on one field (arrays are indexed per element). Unique indexes reject duplicates.'),
        h('div', { class: 'db-row' }, field, h('label', {}, uniq, ' unique'), h('button', { onclick: act(async () => { await api('POST', `${base}/indexes`, { field: field.value, unique: uniq.checked }); rerender() }) }, 'Create index')),
        indexes.length ? h('table', { class: 'db-table' }, h('tbody', {}, indexes.map((i) => h('tr', {}, h('td', {}, i.field), h('td', {}, i.unique ? 'unique' : ''), h('td', {}, `${i.keys} keys`), h('td', {}, h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `${base}/indexes/${encodeURIComponent(i.field)}`); rerender() }) }, 'Drop')))))) : h('p', { class: 'muted' }, 'No indexes.'))
    }

    /* ------------------------------------------------------------ schema */
    if (tab === 'schema') {
      const { schema } = await api('GET', `${base}/schema`)
      const ta = h('textarea', { class: 'db-code', spellcheck: 'false', 'aria-label': 'JSON schema', style: { minHeight: '260px' } }); ta.value = schema ? pretty(schema) : '{\n  "type": "object",\n  "required": [],\n  "properties": {}\n}'
      const err = h('div')
      put(body, h('p', { class: 'muted' }, 'A JSON-Schema subset: type, required, properties, additionalProperties, items, enum, const, min/max, minLength/maxLength, pattern, minItems/maxItems, uniqueItems. Writes that do not match are rejected with 422.'), ta, err,
        h('div', { class: 'db-row' }, h('button', { onclick: async () => { let s; try { s = JSON.parse(ta.value) } catch (e) { fill(err, errorBox(new Error(`Invalid JSON: ${e.message}`))); return } try { const r = await api('PUT', `${base}/schema`, { schema: s }); fill(err, h('p', {}, r.invalidExisting ? `Saved. ${r.invalidExisting} existing document(s) do not match.` : 'Saved.')) } catch (e) { fill(err, errorBox(e)) } } }, 'Save schema'),
          schema ? h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `${base}/schema`); rerender() }) }, 'Remove schema') : null))
    }

    /* ------------------------------------------------------------ live */
    if (tab === 'live') {
      const log = h('div', { class: 'db-log', 'aria-live': 'polite', role: 'log' })
      let ctrl = null
      const btn = h('button', {}, 'Start watching')
      const stop = () => { ctrl?.abort(); ctrl = null; btn.textContent = 'Start watching' }
      btn.onclick = act(async () => {
        if (ctrl) { stop(); return }
        ctrl = new AbortController(); btn.textContent = 'Stop watching'
        const res = await fetch(`${base}/watch`, { headers: { authorization: `Bearer ${state.token}` }, signal: ctrl.signal })
        if (!res.ok) { stop(); throw new Error((await res.json().catch(() => ({}))).error || 'Cannot watch') }
        const reader = res.body.getReader(), dec = new TextDecoder()
        let buf = ''
        ;(async () => {
          try {
            for (;;) {
              const { value, done } = await reader.read(); if (done) break
              buf += dec.decode(value, { stream: true })
              let i
              while ((i = buf.indexOf('\n\n')) >= 0) {
                const block = buf.slice(0, i); buf = buf.slice(i + 2)
                const ev = Object.fromEntries(block.split('\n').map((l) => l.split(/: ?(.*)/s).slice(0, 2)))
                if (!ev.event) continue
                let data = {}; try { data = JSON.parse(ev.data) } catch { /* keep empty */ }
                const cls = { insert: 'db-ins', update: 'db-upd', delete: 'db-del' }[ev.event] ?? ''
                log.prepend(h('div', {}, h('b', { class: cls }, ev.event), ' ', data.id ?? '', data.data ? ` ${snippet(data.data)}` : ''))
                while (log.children.length > 200) log.lastChild.remove()
              }
            }
          } catch { /* aborted */ }
        })()
      })
      put(body, h('p', { class: 'muted' }, 'Server-sent events: inserts, updates and deletes in this collection appear as they happen.'), h('div', { class: 'db-row' }, btn), log)
      window.addEventListener('hashchange', stop, { once: true })
    }

    /* ------------------------------------------------------------ settings */
    if (tab === 'settings') {
      const ttl = h('input', { value: info?.ttlField ?? '', placeholder: 'expiresAt', 'aria-label': 'TTL field' })
      const pub = h('input', { type: 'checkbox', id: 'db-pub', checked: info?.publicRead ? true : null })
      const file = h('input', { type: 'file', accept: '.ndjson,.jsonl,.json,.txt', hidden: true })
      file.onchange = act(async () => { const f = file.files[0]; if (!f) return; const r = await api('POST', `${base}/import`, f, { raw: true }); toast(`Imported ${r.imported} documents`, 'info'); rerender() })
      const pubUrl = `${location.origin}/api/public/db/`
      put(body,
        h('h3', {}, 'Expiry (TTL)'), h('p', { class: 'muted' }, 'Documents whose field holds a past timestamp (ISO string or epoch ms) disappear immediately and are deleted shortly after.'),
        h('div', { class: 'db-row' }, ttl, h('button', { onclick: act(async () => { await api('PATCH', `${base}/settings`, { ttlField: ttl.value.trim() || null }); toast('Saved', 'info') }) }, 'Save')),
        h('h3', {}, 'Public read access'), h('p', { class: 'muted' }, 'When enabled anyone can read (never write) this collection through the public endpoint.'),
        h('div', { class: 'db-row' }, h('label', {}, pub, ' Allow public reads'), h('button', { onclick: act(async () => { const r = await api('PATCH', `${base}/settings`, { publicRead: pub.checked }); toast(r.publicRead ? 'Collection is now public (read-only)' : 'Collection is private', 'info') }) }, 'Save')),
        h('p', { class: 'db-id' }, `${pubUrl}<your-user-id>/${coll}`),
        h('h3', {}, 'Data'),
        h('div', { class: 'db-row' }, file, h('button', { class: 'sec', onclick: act(async () => download(await api('GET', `${base}/export`), `${coll}.ndjson`)) }, 'Export NDJSON'), h('button', { class: 'sec', onclick: () => file.click() }, 'Import NDJSON'),
          h('button', { class: 'sec', onclick: act(async () => { const n = await promptDialog('New collection name', coll); if (n && n !== coll) { await api('POST', `${base}/rename`, { name: n }); location.hash = `#database/${n}/settings` } }) }, 'Rename'),
          h('button', { class: 'sec', onclick: act(async () => { if (await confirmDialog(`Delete collection "${coll}" and all its documents? This cannot be undone.`, 'Delete collection')) { await api('DELETE', base); location.hash = '#database' } }) }, 'Drop collection')))
    }
    void known
  },
}
