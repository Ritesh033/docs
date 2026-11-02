const put = (el, ...kids) => el.append(...kids.flat(Infinity).filter((x) => x != null && x !== false))
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((x) => x != null && x !== false))
const TABS = [['query', 'Query'], ['schema', 'Schema'], ['data', 'Table data'], ['history', 'History & saved'], ['io', 'Import / export'], ['snapshots', 'Snapshots'], ['migrations', 'Migrations']]
const q = (id) => `"${String(id).replaceAll('"', '""')}"`

export default {
  id: 'sql', title: 'SQL', group: 'Cloud', order: 35,
  async render(el, arg, lib) {
    const { h, api, act, toast, rerender, confirmDialog, promptDialog, download, fmtBytes, fmtDate } = lib
    const [dbId, tabArg, extra] = (arg ?? '').split('/')
    const tab = TABS.some(([id]) => id === tabArg) ? tabArg : 'query'
    const { databases, limits } = await api('GET', '/api/sql')
    const side = h('aside', { class: 'sq-side', 'aria-label': 'Databases' }, h('h3', {}, `Databases (${databases.length}/${limits.maxDatabases})`))
    for (const d of databases) side.append(h('button', { class: 'sq-db', 'aria-current': d.id === dbId ? 'true' : null, onclick: () => (location.hash = `#sql/${d.id}`) }, d.name, h('small', {}, fmtBytes(d.sizeBytes))))
    const nameBox = h('input', { placeholder: 'new-database', 'aria-label': 'New database name', maxlength: 48 })
    put(side, h('div', { class: 'sq-row' }, nameBox, h('button', { onclick: act(async () => { const d = await api('POST', '/api/sql', { name: nameBox.value.trim() }); location.hash = `#sql/${d.id}` }) }, 'Create')))
    const main = h('div')
    put(el, h('h1', {}, 'SQL databases'), h('div', { class: 'sq-layout' }, side, main))
    const db = databases.find((d) => d.id === dbId)
    if (!db) { put(main, h('p', { class: 'muted' }, databases.length ? 'Choose a database on the left.' : 'No databases yet. Create one to get a private SQLite database you can query with SQL.'), h('p', { class: 'muted' }, `Each database is a SQLite file (max ${fmtBytes(limits.maxDbBytes)}). Queries run in an isolated worker and are cancelled after ${limits.timeoutMs / 1000} s.`)); return }

    const base = `/api/sql/${db.id}`
    put(main, h('div', { class: 'sq-row' }, h('h2', { style: { margin: 0 } }, db.name), h('span', { class: 'muted' }, `${fmtBytes(db.sizeBytes)} of ${fmtBytes(db.maxBytes)}`),
      h('button', { class: 'sec', onclick: act(async () => { if (await confirmDialog(`Delete database "${db.name}" and all its data? This cannot be undone.`, 'Delete database')) { await api('DELETE', base); location.hash = '#sql' } }) }, 'Delete')),
      h('div', { class: 'sq-tabs', role: 'tablist' }, TABS.map(([id, label]) => h('button', { role: 'tab', 'aria-selected': id === tab ? 'true' : 'false', onclick: () => (location.hash = `#sql/${db.id}/${id}`) }, label))))
    const body = h('div')
    main.append(body)

    const cellNode = (v) => {
      if (v === null) return h('td', { class: 'null' }, 'NULL')
      if (typeof v === 'object') return h('td', { class: 'null' }, `<blob ${v.bytes} bytes>`)
      return h('td', { class: typeof v === 'number' ? 'num' : '', title: String(v).slice(0, 500) }, String(v))
    }
    const grid = (r) => h('div', { class: 'sq-grid-wrap' }, h('table', { class: 'sq-grid' }, h('thead', {}, h('tr', {}, r.columns.map((c) => h('th', {}, c)))), h('tbody', {}, r.rows.map((row) => h('tr', {}, row.map(cellNode))))))
    const errBox = (e) => h('div', { class: 'sq-err', role: 'alert' }, e.message)
    const showResults = (target, out) => fill(target, h('div', { class: 'sq-meta' }, `${out.results.length} statement(s) in ${out.ms} ms`),
      out.results.map((r, i) => h('div', {}, h('div', { class: 'sq-meta' }, `#${i + 1} ${r.kind}${r.columns.length ? ` · ${r.rowCount} row(s)${r.truncated ? ' (truncated)' : ''}` : r.kind === 'write' ? ` · ${r.changes} row(s) changed` : ''} · ${r.ms} ms`), r.columns.length ? grid(r) : null)))

    /* ---------------------------------------------------------------- query */
    if (tab === 'query') {
      const ed = h('textarea', { class: 'sq-code', spellcheck: 'false', 'aria-label': 'SQL', placeholder: 'select * from sqlite_master;' }); ed.value = sessionStorage.getItem(`rd_sql_${db.id}`) ?? ''
      const tx = h('input', { type: 'checkbox', id: 'sq-tx' }), ro = h('input', { type: 'checkbox', id: 'sq-ro' })
      const out = h('div', { 'aria-live': 'polite' })
      const run = act(async () => {
        sessionStorage.setItem(`rd_sql_${db.id}`, ed.value)
        fill(out, h('p', { class: 'muted' }, 'Running…'))
        try { showResults(out, await api('POST', `${base}/query`, { sql: ed.value, transaction: tx.checked, readOnly: ro.checked })) } catch (e) { fill(out, errBox(e)) }
      })
      ed.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run() }
        else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); const s = ed.selectionStart; ed.setRangeText('  ', s, ed.selectionEnd, 'end') }
      })
      const saveName = h('input', { placeholder: 'name to save as', 'aria-label': 'Saved query name', maxlength: 80 })
      put(body, ed, h('div', { class: 'sq-row' }, h('button', { onclick: run }, 'Run (Ctrl/⌘+Enter)'), h('label', {}, tx, ' atomic transaction'), h('label', {}, ro, ' read-only'),
        h('button', { class: 'sec', onclick: act(async () => { const r = await api('POST', `${base}/explain`, { sql: ed.value }); showResults(out, r) }) }, 'Explain'),
        saveName, h('button', { class: 'sec', onclick: act(async () => { await api('POST', `${base}/saved`, { name: saveName.value, sql: ed.value }); toast('Saved', 'info'); saveName.value = '' }) }, 'Save query')), out)
      if (extra) { ed.value = decodeURIComponent(extra) }
    }

    /* ---------------------------------------------------------------- schema */
    if (tab === 'schema') {
      const sc = await api('GET', `${base}/schema`)
      const tree = h('div', { class: 'sq-tree' })
      for (const t of sc.tables) tree.append(h('details', {}, h('summary', {}, h('b', {}, t.name), ' ', h('code', {}, `${t.type}${t.rowCount != null ? ` · ${t.rowCount.toLocaleString()} rows` : ''}`), ' ',
        h('a', { href: `#sql/${db.id}/data/${encodeURIComponent(t.name)}` }, 'browse')),
        h('ul', {}, t.columns.map((c) => h('li', {}, h('code', {}, c.name), ` ${c.type || ''}${c.primaryKey ? ' · PK' : ''}${c.notNull ? ' · NOT NULL' : ''}${c.default != null ? ` · default ${c.default}` : ''}`)), t.foreignKeys.map((f) => h('li', {}, h('code', {}, `${f.from} → ${f.table}.${f.to}`)))), h('pre', { class: 'muted' }, t.sql ?? '')))
      put(body, sc.tables.length ? tree : h('p', { class: 'muted' }, 'No tables yet.'), sc.indexes.length ? [h('h4', {}, 'Indexes'), h('ul', {}, sc.indexes.map((i) => h('li', {}, h('code', {}, i.name), ` on ${i.table}`)))] : null, sc.triggers.length ? [h('h4', {}, 'Triggers'), h('ul', {}, sc.triggers.map((i) => h('li', {}, h('code', {}, i.name), ` on ${i.table}`)))] : null)
    }

    /* ---------------------------------------------------------------- table data */
    if (tab === 'data') {
      const sc = await api('GET', `${base}/schema`)
      const name = extra ? decodeURIComponent(extra) : sc.tables[0]?.name
      const sel = h('select', { 'aria-label': 'Table', onchange: () => (location.hash = `#sql/${db.id}/data/${encodeURIComponent(sel.value)}`) }, sc.tables.map((t) => h('option', { value: t.name, selected: t.name === name ? true : null }, t.name)))
      const out = h('div')
      let offset = 0
      const load = async () => {
        if (!name) return fill(out, h('p', { class: 'muted' }, 'No tables yet.'))
        try {
          const r = await api('GET', `${base}/tables/${encodeURIComponent(name)}?limit=50&offset=${offset}`)
          fill(out, h('div', { class: 'sq-meta' }, `${r.total ?? '?'} rows · showing ${offset + 1}–${offset + r.rowCount}`), r.columns.length ? grid(r) : null,
            h('div', { class: 'sq-row' }, h('button', { class: 'sec', disabled: offset === 0 ? true : null, onclick: () => { offset = Math.max(0, offset - 50); load() } }, 'Previous'), h('button', { class: 'sec', disabled: r.total != null && offset + 50 >= r.total ? true : null, onclick: () => { offset += 50; load() } }, 'Next'),
              h('a', { href: `#sql/${db.id}/query/${encodeURIComponent(`select * from ${q(name)} limit 100;`)}` }, 'Open in editor')))
        } catch (e) { fill(out, errBox(e)) }
      }
      put(body, h('div', { class: 'sq-row' }, sel), out); await load()
    }

    /* ---------------------------------------------------------------- history & saved */
    if (tab === 'history') {
      const [{ history }, { saved }] = await Promise.all([api('GET', `${base}/history`), api('GET', `${base}/saved`)])
      const open = (sql) => { sessionStorage.setItem(`rd_sql_${db.id}`, sql); location.hash = `#sql/${db.id}/query` }
      put(body, h('h3', {}, 'Saved queries'), saved.length ? saved.map((s) => h('div', { class: 'sq-row' }, h('button', { class: 'sec', onclick: () => open(s.sql) }, s.name), h('code', { class: 'muted' }, s.sql.slice(0, 80)), h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `${base}/saved/${s.id}`); rerender() }) }, 'Delete'))) : h('p', { class: 'muted' }, 'None yet.'),
        h('h3', {}, 'History'), h('div', { class: 'sq-row' }, h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `${base}/history`); rerender() }) }, 'Clear history')),
        h('div', { class: 'sq-hist' }, history.map((e) => h('button', { onclick: () => open(e.sql), title: e.error ?? '' }, h('span', { class: e.ok ? 'sq-ok' : 'sq-bad' }, e.ok ? '✓ ' : '✗ '), `${e.sql.replace(/\s+/g, ' ')}  — ${e.ms} ms${e.ok ? `, ${e.rows} rows` : `, ${e.error}`}`))))
    }

    /* ---------------------------------------------------------------- import / export */
    if (tab === 'io') {
      const table = h('input', { placeholder: 'table_name', 'aria-label': 'Target table name', maxlength: 64 })
      const file = h('input', { type: 'file', accept: '.csv,.json,text/csv,application/json' })
      put(body, h('h3', {}, 'Import'), h('p', { class: 'muted' }, 'CSV (first row = header) or a JSON array of objects, up to 5 MB. Columns and types are inferred; the table is created if needed.'),
        h('div', { class: 'sq-row' }, table, file, h('button', { onclick: act(async () => {
          const f = file.files[0]; if (!f) throw new Error('Choose a file'); const fmt = /\.json$/i.test(f.name) ? 'json' : 'csv'
          const r = await api('POST', `${base}/import?table=${encodeURIComponent(table.value)}&format=${fmt}`, f, { raw: true }); toast(`Imported ${r.inserted} rows`, 'info'); rerender()
        }) }, 'Import')),
        h('h3', {}, 'Export'), h('div', { class: 'sq-row' }, h('button', { class: 'sec', onclick: act(async () => download(await api('GET', `${base}/export?format=sql`), `${db.name}.sql`)) }, 'Full SQL dump'),
          h('span', { class: 'muted' }, 'Tables as CSV: use “Table data” → pick a table, or:'), h('input', { id: 'sq-exp', placeholder: 'table name', 'aria-label': 'Table to export' }),
          h('button', { class: 'sec', onclick: act(async () => { const t = document.querySelector('#sq-exp').value.trim(); download(await api('GET', `${base}/export?format=csv&table=${encodeURIComponent(t)}`), `${t}.csv`) }) }, 'CSV')),
        h('p', { class: 'muted' }, 'Restore a dump by pasting it in the Query tab with “atomic transaction” checked.'))
    }

    /* ---------------------------------------------------------------- snapshots */
    if (tab === 'snapshots') {
      const { snapshots } = await api('GET', `${base}/snapshots`)
      const label = h('input', { placeholder: 'label (optional)', 'aria-label': 'Snapshot label', maxlength: 80 })
      put(body, h('p', { class: 'muted' }, 'Point-in-time copies of the whole database. Restoring keeps a safety snapshot of the current state first.'), h('div', { class: 'sq-row' }, label, h('button', { onclick: act(async () => { await api('POST', `${base}/snapshots`, { label: label.value }); toast('Snapshot created', 'info'); rerender() }) }, 'Create snapshot')),
        snapshots.length ? h('table', { class: 'sq-grid' }, h('tbody', {}, snapshots.map((s) => h('tr', {}, h('td', {}, s.label || s.id), h('td', {}, fmtBytes(s.sizeBytes)), h('td', {}, fmtDate(s.createdAt)),
          h('td', {}, h('button', { class: 'sec', onclick: act(async () => { if (await confirmDialog(`Replace the current data with "${s.label || s.id}"?`, 'Restore')) { await api('POST', `${base}/snapshots/${s.id}/restore`, { confirm: true }); toast('Restored', 'info'); rerender() } }) }, 'Restore'), ' ',
            h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `${base}/snapshots/${s.id}`); rerender() }) }, 'Delete')))))) : h('p', { class: 'muted' }, 'No snapshots.'))
    }

    /* ---------------------------------------------------------------- migrations */
    if (tab === 'migrations') {
      const { migrations } = await api('GET', `${base}/migrations`)
      const next = (migrations.at(-1)?.version ?? 0) + 1
      const ver = h('input', { type: 'number', min: '1', value: String(next), 'aria-label': 'Version', style: { width: '90px' } }), nm = h('input', { placeholder: 'name, e.g. add_users', 'aria-label': 'Migration name', maxlength: 120 })
      const sql = h('textarea', { class: 'sq-code', spellcheck: 'false', 'aria-label': 'Migration SQL', placeholder: 'create table users(id integer primary key, email text unique);' })
      const err = h('div')
      put(body, h('p', { class: 'muted' }, 'Versioned, ordered, atomic. A migration runs once; re-sending the same version with different SQL is rejected (checksum drift).'),
        migrations.length ? h('table', { class: 'sq-grid' }, h('tbody', {}, migrations.map((m) => h('tr', {}, h('td', {}, `v${m.version}`), h('td', {}, m.name), h('td', {}, h('code', {}, m.checksum.slice(0, 12))), h('td', {}, fmtDate(m.appliedAt)))))) : h('p', { class: 'muted' }, 'No migrations applied.'),
        h('h4', {}, 'Apply a migration'), h('div', { class: 'sq-row' }, ver, nm), sql, h('div', { class: 'sq-row' }, h('button', { onclick: async () => { try { await api('POST', `${base}/migrations`, { version: Number(ver.value), name: nm.value, sql: sql.value }); toast('Applied', 'info'); rerender() } catch (e) { fill(err, errBox(e)) } } }, 'Apply')), err)
    }
  },
}
