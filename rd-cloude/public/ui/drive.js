const put = (el, ...kids) => el.append(...kids.flat(Infinity).filter((x) => x != null && x !== false))
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((x) => x != null && x !== false))
const CHUNK = 8 * 1024 * 1024
const CHUNK_THRESHOLD = 20 * 1024 * 1024
const ICON = (f) => (/^image\//.test(f.contentType) ? '🖼️' : /pdf/.test(f.contentType) ? '📕' : /^(audio|video)\//.test(f.contentType) ? '🎞️' : /zip|tar|gzip/.test(f.contentType) ? '🗜️' : '📄')
const TEXTISH = /^text\/|json|xml|javascript|yaml|csv|markdown/

function dlg(lib, title, build) {
  const { h } = lib
  const d = h('dialog', { class: 'dr-dlg', 'aria-label': title })
  const close = () => { d.close(); d.remove() }
  d.addEventListener('cancel', close)
  put(d, h('h3', {}, title), build(d, close), h('div', { class: 'dr-field' }, h('button', { class: 'sec', onclick: close }, 'Close')))
  document.body.append(d)
  d.showModal()
  return { d, close }
}

function xhrPut(token, url, body, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open('PUT', url)
    x.setRequestHeader('authorization', `Bearer ${token}`)
    if (contentType) x.setRequestHeader('content-type', contentType)
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total)
    x.onload = () => { let j = null; try { j = JSON.parse(x.responseText) } catch { /* not json */ } x.status < 300 ? resolve(j) : reject(new Error(j?.error || `Upload failed (${x.status})`)) }
    x.onerror = () => reject(new Error('Network error during upload'))
    x.send(body)
  })
}

export default {
  id: 'drive', title: 'Drive', group: 'Cloud', order: 40,
  async render(el, arg, lib) {
    const { h, api, act, toast, rerender, download, confirmDialog, promptDialog, fmtBytes, fmtDate, state } = lib
    const [mode, ...rest] = (arg ?? '').split('/')
    const view = mode === 'trash' ? 'trash' : mode === 'shared' ? 'shared' : mode === 'search' ? 'search' : 'files'
    const folderId = mode === 'f' ? rest[0] : null
    const query = mode === 'search' ? decodeURIComponent(rest.join('/')) : ''
    const layout = localStorage.getItem('rd_drive_layout') === 'grid' ? 'grid' : 'list'
    const selected = new Set()

    const usage = await api('GET', '/api/drive/usage')
    const pct = Math.min(100, (usage.used / usage.quota) * 100)
    const meter = h('div', { class: 'dr-meter', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pct), 'aria-label': 'Storage used' }, h('i'))
    meter.firstChild.style.setProperty('--w', `${pct}%`)

    const searchBox = h('input', { type: 'search', class: 'grow', placeholder: 'Search names and text…', 'aria-label': 'Search files', value: query })
    searchBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && searchBox.value.trim()) location.hash = `#drive/search/${encodeURIComponent(searchBox.value.trim())}`; })
    put(el, h('h1', {}, 'Drive'),
      h('nav', { class: 'dr-tabs', 'aria-label': 'Drive sections' }, [['', 'My files', 'files'], ['shared', 'Shared with me', 'shared'], ['trash', 'Trash', 'trash']].map(([a, l, v]) => h('a', { href: `#drive${a ? '/' + a : ''}`, 'aria-current': v === view ? 'page' : null }, l))),
      h('div', { class: 'dr-bar' }, searchBox, h('span', { class: 'muted' }, `${fmtBytes(usage.used)} of ${fmtBytes(usage.quota)}`), meter))

    /* ----------------------------------------------------------- dialogs */
    async function preview(f) {
      const { d, close } = dlg(lib, f.name, () => h('div', { class: 'dr-preview' }, h('p', { class: 'muted' }, 'Loading…')))
      const box = d.querySelector('.dr-preview'); box.replaceChildren()
      try {
        if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(f.contentType)) {
          const blob = await api('GET', `/api/drive/files/${f.id}?inline=1`)
          const url = URL.createObjectURL(blob)
          const img = h('img', { src: url, alt: f.name }); img.onload = () => setTimeout(() => URL.revokeObjectURL(url), 5000); box.append(img)
        } else if (TEXTISH.test(f.contentType) && f.size <= 1024 * 1024) {
          const blob = await api('GET', `/api/drive/files/${f.id}`)
          box.append(h('pre', {}, await blob.text()))
        } else box.append(h('p', {}, 'No inline preview for this type.'), h('button', { onclick: act(async () => download(await api('GET', `/api/drive/files/${f.id}`), f.name)) }, 'Download'))
      } catch (e) { box.append(h('p', { class: 'err' }, e.message)) }
      void close
    }

    function moveDialog(items) {
      dlg(lib, `Move ${items.length} item${items.length === 1 ? '' : 's'}`, (d, close) => {
        const tree = h('div', { class: 'dr-tree' }, h('p', { class: 'muted' }, 'Loading folders…'))
        api('GET', '/api/drive/folders').then(({ folders }) => {
          const kids = (pid) => folders.filter((x) => (x.parentId ?? null) === pid)
          const blocked = new Set(items.filter((i) => i.isFolder).map((i) => i.id))
          const out = []
          const walk = (pid, depth) => { for (const f of kids(pid)) { if (blocked.has(f.id)) continue; out.push(h('button', { 'aria-pressed': 'false', onclick: act(() => moveTo(f.id)) }, `${'  '.repeat(depth)}📁 ${f.name}`)); walk(f.id, depth + 1) } }
          out.push(h('button', { onclick: act(() => moveTo(null)) }, '🏠 My files (root)'))
          walk(null, 1)
          tree.replaceChildren(...out)
        }).catch((e) => tree.replaceChildren(h('p', { class: 'err' }, e.message)))
        async function moveTo(target) {
          for (const it of items) await api('PATCH', it.isFolder ? `/api/drive/folders/${it.id}` : `/api/drive/files/${it.id}`, it.isFolder ? { parentId: target } : { folderId: target })
          close(); toast('Moved', 'info'); rerender()
        }
        return tree
      })
    }

    function versionsDialog(f) {
      dlg(lib, `Versions of ${f.name}`, () => {
        const box = h('div', {}, h('p', { class: 'muted' }, 'Loading…'))
        const load = async () => {
          const { versions } = await api('GET', `/api/drive/files/${f.id}/versions`)
          box.replaceChildren(h('table', { class: 'dr-list' }, h('tbody', {}, versions.slice().reverse().map((v, i) => h('tr', {}, h('td', {}, `v${v.version}${i === 0 ? ' (current)' : ''}`, v.label ? h('div', { class: 'muted' }, v.label) : null), h('td', {}, fmtBytes(v.size)), h('td', { class: 'hide-sm' }, fmtDate(v.at)),
            h('td', { class: 'dr-actions' },
              h('button', { class: 'sec', onclick: act(async () => download(await api('GET', `/api/drive/files/${f.id}?version=${v.version}`), f.name)) }, 'Download'),
              h('button', { class: 'sec', onclick: act(async () => { const l = await promptDialog('Label for this version (empty to clear)', v.label ?? ''); if (l !== null) { await api('PATCH', `/api/drive/files/${f.id}/versions/${v.version}`, { label: l || null }); load() } }) }, 'Label'),
              i > 0 ? h('button', { class: 'sec', onclick: act(async () => { if (await confirmDialog(`Make v${v.version} the current version? A new version is created.`, 'Restore')) { await api('POST', `/api/drive/files/${f.id}/versions/${v.version}/restore`); toast('Restored', 'info'); rerender() } }) }, 'Restore') : null))))))
        }
        load().catch((e) => box.replaceChildren(h('p', { class: 'err' }, e.message)))
        return box
      })
    }

    function shareDialog(f) {
      dlg(lib, `Share “${f.name}”`, () => {
        const box = h('div')
        const perm = h('select', { 'aria-label': 'Link permission' }, h('option', { value: 'download' }, 'Can download'), h('option', { value: 'view' }, 'View in browser'))
        const exp = h('input', { type: 'number', min: '1', placeholder: 'Expires in hours', 'aria-label': 'Expires in hours' })
        const maxd = h('input', { type: 'number', min: '1', placeholder: 'Max downloads', 'aria-label': 'Maximum downloads' })
        const pw = h('input', { type: 'password', placeholder: 'Password (optional)', autocomplete: 'new-password', 'aria-label': 'Link password' })
        const mail = h('input', { type: 'email', placeholder: 'person@example.com', 'aria-label': 'Share with email' })
        const role = h('select', { 'aria-label': 'Role' }, h('option', { value: 'viewer' }, 'Viewer'), h('option', { value: 'editor' }, 'Editor'))
        const list = h('div')
        const load = async () => {
          const [{ shares }, { acl }] = await Promise.all([api('GET', `/api/drive/files/${f.id}/shares`), api('GET', `/api/drive/files/${f.id}/acl`)])
          fill(list, h('h4', {}, 'Links'), shares.length ? shares.map((s) => h('div', { class: 'dr-field' }, h('code', {}, `${location.origin}${s.url}`), h('span', { class: 'muted' }, `${s.permission}${s.passwordProtected ? ', password' : ''}${s.expiresAt ? `, expires ${fmtDate(s.expiresAt)}` : ''}, ${s.downloads} downloads`),
            h('button', { class: 'sec', onclick: act(async () => { await navigator.clipboard?.writeText(location.origin + s.url); toast('Link copied', 'info') }) }, 'Copy'),
            h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/drive/shares/${s.token}`); load() }) }, 'Revoke'))) : h('p', { class: 'muted' }, 'No links yet.'),
          h('h4', {}, 'People'), acl.length ? acl.map((e) => h('div', { class: 'dr-field' }, h('span', {}, e.email ?? `Organization ${e.orgId}`), h('span', { class: 'muted' }, e.role), h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/drive/files/${f.id}/acl/${e.id}`); load() }) }, 'Remove'))) : h('p', { class: 'muted' }, 'Not shared with anyone.'))
        }
        put(box, h('h4', {}, 'Create a link'), h('div', { class: 'dr-field' }, perm, exp, maxd, pw, h('button', { onclick: act(async () => {
          const body = { permission: perm.value }
          if (exp.value) body.expiresInHours = Number(exp.value)
          if (maxd.value) body.maxDownloads = Number(maxd.value)
          if (pw.value) body.password = pw.value
          const s = await api('POST', `/api/drive/files/${f.id}/share`, body)
          try { await navigator.clipboard?.writeText(location.origin + s.url); toast('Link created and copied', 'info') } catch { toast('Link created', 'info') }
          exp.value = maxd.value = pw.value = ''; load()
        }) }, 'Create link')),
        h('h4', {}, 'Share with a person'), h('div', { class: 'dr-field' }, mail, role, h('button', { onclick: act(async () => { const r = await api('POST', `/api/drive/files/${f.id}/acl`, { email: mail.value, role: role.value }); toast(r.note ?? 'Shared', 'info'); mail.value = ''; load() }) }, 'Share')), list)
        load().catch((e) => list.replaceChildren(h('p', { class: 'err' }, e.message)))
        return box
      })
    }

    /* ----------------------------------------------------------- uploads */
    const uploads = h('div', { class: 'dr-uploads', 'aria-live': 'polite' })
    async function uploadFile(file) {
      const row = h('div', { class: 'dr-up' }, h('span', {}, file.name), h('div', { class: 'dr-prog' }, h('i')))
      const bar = row.querySelector('i')
      uploads.append(row)
      const prog = (done, total) => bar.style.setProperty('--w', `${Math.min(100, (done / total) * 100)}%`)
      try {
        if (file.size > CHUNK_THRESHOLD) {
          const { uploadId } = await api('POST', '/api/drive/uploads', { name: file.name, size: file.size, folderId, contentType: file.type || 'application/octet-stream' })
          let sent = 0
          for (let n = 1, off = 0; off < file.size; n++, off += CHUNK) {
            const part = file.slice(off, off + CHUNK)
            await xhrPut(state.token, `/api/drive/uploads/${uploadId}/parts/${n}`, part, 'application/octet-stream', (l) => prog(sent + l, file.size))
            sent += part.size
          }
          await api('POST', `/api/drive/uploads/${uploadId}/complete`, {})
        } else {
          await xhrPut(state.token, `/api/drive/files?name=${encodeURIComponent(file.name)}${folderId ? `&folder=${folderId}` : ''}`, file, file.type || 'application/octet-stream', prog)
        }
        prog(1, 1)
      } catch (e) { toast(`${file.name}: ${e.message}`, 'error'); row.append(h('span', { class: 'err' }, 'failed')) }
    }
    async function uploadMany(files) {
      for (const f of files) await uploadFile(f)
      rerender()
    }

    /* ----------------------------------------------------------- data */
    let folders = [], files = [], crumbs = []
    let note = ''
    if (view === 'files') {
      const b = await api('GET', `/api/drive/browse${folderId ? `?folder=${folderId}` : ''}`)
      folders = b.folders; files = b.files; crumbs = b.breadcrumbs
    } else if (view === 'trash') {
      const t = await api('GET', '/api/drive/trash'); folders = t.folders; files = t.files
      note = usage.trashRetentionDays ? `Items are deleted permanently after ${usage.trashRetentionDays} days.` : ''
    } else if (view === 'shared') files = (await api('GET', '/api/drive/shared')).files
    else if (view === 'search') files = (await api('GET', `/api/drive/search?q=${encodeURIComponent(query)}`)).files

    const items = [...folders.map((f) => ({ ...f, isFolder: true })), ...files]
    const bulkBar = h('div', { class: 'dr-bar', role: 'toolbar', 'aria-label': 'Selection actions' })
    const refreshBar = () => {
      bulkBar.replaceChildren()
      if (!selected.size) return
      const chosen = items.filter((i) => selected.has(i.id))
      const fIds = chosen.filter((i) => !i.isFolder).map((i) => i.id), dIds = chosen.filter((i) => i.isFolder).map((i) => i.id)
      put(bulkBar, h('b', {}, `${selected.size} selected`),
        view !== 'trash' && view !== 'shared' ? [
          h('button', { class: 'sec', onclick: act(async () => download(await api('POST', '/api/drive/zip', { fileIds: fIds, folderIds: dIds }), 'drive.zip')) }, 'Download .zip'),
          h('button', { class: 'sec', onclick: () => moveDialog(chosen) }, 'Move…'),
          h('button', { class: 'sec', onclick: act(async () => { if (await confirmDialog(`Move ${selected.size} item(s) to the trash?`, 'Move to trash')) { for (const i of chosen) await api('DELETE', i.isFolder ? `/api/drive/folders/${i.id}` : `/api/drive/files/${i.id}`); rerender() } }) }, 'Trash')] : null,
        h('button', { class: 'sec', onclick: () => { selected.clear(); paint() } }, 'Clear'))
    }

    const rowActions = (it) => {
      const b = (label, fn, cls = 'sec') => h('button', { class: cls, onclick: act(fn) }, label)
      if (view === 'trash') return [b('Restore', async () => { await api('POST', it.isFolder ? `/api/drive/folders/${it.id}/restore` : `/api/drive/files/${it.id}/restore`); rerender() }), b('Delete forever', async () => { if (await confirmDialog(`Permanently delete “${it.name}”? This cannot be undone.`, 'Delete forever')) { await api('DELETE', `${it.isFolder ? '/api/drive/folders/' : '/api/drive/files/'}${it.id}?permanent=1`); rerender() } })]
      if (it.isFolder) return [b('Rename', async () => { const n = await promptDialog('Folder name', it.name); if (n) { await api('PATCH', `/api/drive/folders/${it.id}`, { name: n }); rerender() } }), b('Move', () => moveDialog([it])), b('Trash', async () => { await api('DELETE', `/api/drive/folders/${it.id}`); rerender() })]
      const owner = !it.role || it.role === 'owner'
      return [b('Preview', () => preview(it)), b('Download', async () => download(await api('GET', `/api/drive/files/${it.id}`), it.name)),
        owner ? [b(it.starred ? '★' : '☆', async () => { await api('PATCH', `/api/drive/files/${it.id}`, { starred: !it.starred }); rerender() }), b('Share', () => shareDialog(it)), b('Versions', () => versionsDialog(it)), b('Rename', async () => { const n = await promptDialog('File name', it.name); if (n) { await api('PATCH', `/api/drive/files/${it.id}`, { name: n }); rerender() } }), b('Move', () => moveDialog([it])), b('Trash', async () => { await api('DELETE', `/api/drive/files/${it.id}`); rerender() })] : null]
    }
    const open = (it) => (it.isFolder ? (location.hash = `#drive/f/${it.id}`) : preview(it))
    const check = (it) => h('input', { type: 'checkbox', 'aria-label': `Select ${it.name}`, checked: selected.has(it.id) ? true : null, onchange: (e) => { e.target.checked ? selected.add(it.id) : selected.delete(it.id); refreshBar(); e.target.closest('tr,.dr-card')?.classList.toggle('sel', e.target.checked) } })

    const listing = h('div')
    function paint() {
      listing.replaceChildren()
      if (!items.length) { put(listing, h('p', { class: 'muted' }, view === 'files' ? 'This folder is empty. Drop files here or use Upload.' : view === 'search' ? 'No matches.' : view === 'trash' ? 'The trash is empty.' : 'Nothing has been shared with you.')); refreshBar(); return }
      if (layout === 'grid') {
        put(listing, h('div', { class: 'dr-grid' }, items.map((it) => h('div', { class: `dr-card ${selected.has(it.id) ? 'sel' : ''}` }, h('div', {}, check(it), ' ', h('button', { class: 'dr-name', onclick: () => open(it) }, h('span', { class: 'dr-ico', 'aria-hidden': 'true' }, it.isFolder ? '📁' : ICON(it)), it.name)), h('small', {}, it.isFolder ? 'Folder' : `${fmtBytes(it.size)} · v${it.versionCount}`), h('div', { class: 'dr-actions' }, rowActions(it))))))
      } else {
        put(listing, h('table', { class: 'dr-list' }, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Name'), h('th', { class: 'hide-sm' }, 'Size'), h('th', { class: 'hide-sm' }, 'Modified'), h('th', {}, ''))),
          h('tbody', {}, items.map((it) => {
            const tr = h('tr', { tabindex: 0, class: selected.has(it.id) ? 'sel' : '', 'data-id': it.id },
              h('td', {}, check(it)), h('td', {}, h('button', { class: 'dr-name', onclick: () => open(it) }, h('span', { class: 'dr-ico', 'aria-hidden': 'true' }, it.isFolder ? '📁' : ICON(it)), it.name, it.starred ? ' ★' : '', it.owner ? h('span', { class: 'muted' }, ` — ${it.owner}`) : null)),
              h('td', { class: 'hide-sm' }, it.isFolder ? '—' : fmtBytes(it.size)), h('td', { class: 'hide-sm' }, fmtDate(it.updatedAt ?? it.createdAt)), h('td', { class: 'dr-actions' }, rowActions(it)))
            tr.addEventListener('keydown', (e) => { if (e.target !== tr) return; if (e.key === 'Enter') open(it); else if (e.key === ' ') { e.preventDefault(); tr.querySelector('input[type=checkbox]').click() } else if (e.key === 'Delete' && view === 'files') act(async () => { await api('DELETE', it.isFolder ? `/api/drive/folders/${it.id}` : `/api/drive/files/${it.id}`); rerender() })() })
            return tr
          }))))
      }
      refreshBar()
    }

    /* ----------------------------------------------------------- toolbar */
    if (view === 'files') {
      const picker = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => uploadMany([...picker.files]) })
      put(el, h('div', { class: 'dr-crumbs', role: 'navigation', 'aria-label': 'Breadcrumbs' }, h('a', { href: '#drive' }, 'My files'), crumbs.map((c) => [' / ', h('a', { href: `#drive/f/${c.id}` }, c.name)])),
        h('div', { class: 'dr-bar' }, picker, h('button', { onclick: () => picker.click() }, 'Upload'),
          h('button', { class: 'sec', onclick: act(async () => { const n = await promptDialog('Folder name'); if (n) { await api('POST', '/api/drive/folders', { name: n, parentId: folderId }); rerender() } }) }, 'New folder'),
          h('button', { class: 'sec', 'aria-pressed': layout === 'grid' ? 'true' : 'false', onclick: () => { localStorage.setItem('rd_drive_layout', layout === 'grid' ? 'list' : 'grid'); rerender() } }, layout === 'grid' ? 'List view' : 'Grid view')))
    }
    if (view === 'trash') put(el, h('div', { class: 'dr-bar' }, h('span', { class: 'muted' }, note), h('button', { class: 'sec', onclick: act(async () => { if (await confirmDialog('Permanently delete everything in the trash?', 'Empty trash')) { await api('DELETE', '/api/drive/trash'); rerender() } }) }, 'Empty trash')))
    if (view === 'search') put(el, h('p', { class: 'muted' }, `Results for “${query}”`))

    const zone = h('div', { class: view === 'files' ? 'dr-drop' : '' }, uploads, bulkBar, listing)
    if (view === 'files') {
      zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over') })
      zone.addEventListener('dragleave', () => zone.classList.remove('over'))
      zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer?.files?.length) uploadMany([...e.dataTransfer.files]) })
    }
    put(el, zone)
    paint()
  },
}
