import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startTestApp } from './helpers.js'

async function withApp(fn) {
  const app = await startTestApp()
  try { await fn(app) } finally { await app.close() }
}
const put = (u, name, body, { folder, type = 'text/plain' } = {}) =>
  u.call('PUT', `/api/drive/files?name=${encodeURIComponent(name)}${folder ? `&folder=${folder}` : ''}`, { raw: body, headers: { 'content-type': type } })
const mkdir = async (u, name, parentId) => (await u.call('POST', '/api/drive/folders', { body: { name, parentId } })).data
const text = (r) => r.data.toString()

test('folders: nesting, uniqueness, depth, cycles, breadcrumbs, isolation', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const a = await mkdir(u, 'a'), b = await mkdir(u, 'b', a.id)
    assert.equal((await u.call('POST', '/api/drive/folders', { body: { name: 'a' } })).status, 409)
    for (const bad of ['', '.', '..', 'x/y', 'x\\y', 'a\u0000b', 'x'.repeat(256), 5, null]) assert.equal((await u.call('POST', '/api/drive/folders', { body: { name: bad } })).status, 400, JSON.stringify(bad))
    assert.equal((await u.call('POST', '/api/drive/folders', { body: { name: 'z', parentId: 'nope' } })).status, 404)
    assert.equal((await v.call('POST', '/api/drive/folders', { body: { name: 'z', parentId: a.id } })).status, 404, "cannot nest under someone else's folder")
    assert.equal((await u.call('PATCH', `/api/drive/folders/${a.id}`, { body: { parentId: b.id } })).status, 400, 'no cycles')
    assert.equal((await u.call('PATCH', `/api/drive/folders/${a.id}`, { body: { parentId: a.id } })).status, 400)
    const br = (await u.call('GET', `/api/drive/browse?folder=${b.id}`)).data
    assert.deepEqual(br.breadcrumbs.map((x) => x.name), ['a', 'b'])
    assert.equal((await v.call('GET', `/api/drive/browse?folder=${b.id}`)).status, 404)
    let parent = null
    let last
    for (let i = 0; i < 25; i++) { last = await u.call('POST', '/api/drive/folders', { body: { name: `d${i}`, parentId: parent } }); if (last.status !== 201) break; parent = last.data.id }
    assert.equal(last.status, 400, 'depth is capped')
  })
})

test('upload: names, versions, unchanged content, content types, folders', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const f = await mkdir(u, 'docs')
    for (const bad of ['../etc/passwd', 'a/b', '', '..', 'x\u0007y']) assert.equal((await put(u, bad, 'x')).status, 400, JSON.stringify(bad))
    assert.equal((await u.call('PUT', '/api/drive/files', { raw: 'x' })).status, 400, 'name required')
    assert.equal((await put(u, 'n.txt', 'x', { folder: 'bogus' })).status, 404)
    const r1 = await put(u, 'n.txt', 'one', { folder: f.id })
    assert.equal(r1.status, 201); assert.equal(r1.data.folderId, f.id)
    const same = await put(u, 'n.txt', 'one', { folder: f.id })
    assert.equal(same.status, 200); assert.equal(same.data.unchanged, true); assert.equal(same.data.versionCount, 1)
    const r2 = await put(u, 'n.txt', 'two', { folder: f.id })
    assert.equal(r2.data.versionCount, 2)
    const rootSame = await put(u, 'n.txt', 'root copy')
    assert.equal(rootSame.status, 201, 'same name in another folder is a different file')
    assert.equal((await u.call('GET', '/api/drive/files?folder=root')).data.files.length, 1)
    assert.equal((await u.call('GET', `/api/drive/files?folder=${f.id}`)).data.files.length, 1)
    const weird = (await put(u, 'w.bin', 'x', { type: 'not a type;;<script>' })).data
    assert.equal(weird.contentType, 'application/octet-stream')
  })
})

test('download: ranges, etag, safe inline, disposition, missing blobs', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const f = (await put(u, 'ünï "q".txt', '0123456789', { type: 'text/plain' })).data
    const full = await u.call('GET', `/api/drive/files/${f.id}`)
    assert.equal(text(full), '0123456789')
    assert.match(full.headers.get('content-disposition'), /^attachment; filename="[^"\\]*"; filename\*=UTF-8''/)
    assert.equal(full.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(full.headers.get('content-type'), 'application/octet-stream', 'attachment mode never advertises a renderable type')
    const part = await u.call('GET', `/api/drive/files/${f.id}`, { headers: { range: 'bytes=2-4' } })
    assert.equal(part.status, 206); assert.equal(text(part), '234'); assert.equal(part.headers.get('content-range'), 'bytes 2-4/10')
    assert.equal(text(await u.call('GET', `/api/drive/files/${f.id}`, { headers: { range: 'bytes=-3' } })), '789')
    assert.equal(text(await u.call('GET', `/api/drive/files/${f.id}`, { headers: { range: 'bytes=7-' } })), '789')
    assert.equal((await u.call('GET', `/api/drive/files/${f.id}`, { headers: { range: 'bytes=50-60' } })).status, 416)
    assert.equal((await u.call('GET', `/api/drive/files/${f.id}`, { headers: { range: 'bytes=5-2' } })).status, 416)
    const etag = full.headers.get('etag')
    assert.equal((await u.call('GET', `/api/drive/files/${f.id}`, { headers: { 'if-none-match': etag } })).status, 304)
    // inline: whitelist only
    const inl = await u.call('GET', `/api/drive/files/${f.id}?inline=1`)
    assert.match(inl.headers.get('content-disposition'), /^inline/); assert.match(inl.headers.get('content-type'), /^text\/plain/)
    const html = (await put(u, 'x.html', '<script>alert(1)</script>', { type: 'text/html' })).data
    const hr = await u.call('GET', `/api/drive/files/${html.id}?inline=1`)
    assert.match(hr.headers.get('content-disposition'), /^attachment/, 'HTML is never rendered inline')
    assert.match(hr.headers.get('content-security-policy'), /sandbox/)
    const svg = (await put(u, 'x.svg', '<svg onload=alert(1)/>', { type: 'image/svg+xml' })).data
    assert.match((await u.call('GET', `/api/drive/files/${svg.id}?inline=1`)).headers.get('content-disposition'), /^attachment/)
    const png = (await put(u, 'x.png', Buffer.from('89504e47', 'hex'), { type: 'image/png' })).data
    assert.match((await u.call('GET', `/api/drive/files/${png.id}?inline=1`)).headers.get('content-disposition'), /^inline/)
    assert.equal((await v.call('GET', `/api/drive/files/${f.id}`)).status, 404)
    assert.equal((await u.call('GET', `/api/drive/files/${f.id}?version=9`)).status, 404)
    // data missing on disk -> 410, not a 200 with an empty body
    const ver = app.db.get('files', f.id).versions[0]
    app.db.deleteBlob(ver.blobId)
    assert.equal((await u.call('GET', `/api/drive/files/${f.id}`)).status, 410)
  })
})

test('trash: soft delete, restore with name collisions, purge, retention sweep, folders', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const f = (await put(u, 'a.txt', 'aaa')).data
    assert.equal((await u.call('DELETE', `/api/drive/files/${f.id}`)).data.trashed, true)
    assert.equal((await u.call('GET', '/api/drive/files')).data.files.length, 0)
    assert.equal((await u.call('GET', `/api/drive/files/${f.id}`)).status, 404, 'trashed files cannot be downloaded')
    assert.equal((await u.call('GET', '/api/drive/trash')).data.files.length, 1)
    await put(u, 'a.txt', 'new file with same name')
    const restored = (await u.call('POST', `/api/drive/files/${f.id}/restore`)).data
    assert.match(restored.name, /restored/)
    assert.equal((await u.call('POST', `/api/drive/files/${f.id}/restore`)).status, 409)
    assert.equal((await v.call('POST', `/api/drive/files/${f.id}/restore`)).status, 404)
    await u.call('DELETE', `/api/drive/files/${f.id}`)
    assert.equal((await u.call('DELETE', `/api/drive/files/${f.id}?permanent=1`)).data.purged, true)
    assert.equal(app.db.get('files', f.id), null)
    // folder trash cascades and restores together
    const d = await mkdir(u, 'proj'), sub = await mkdir(u, 'sub', d.id)
    const in1 = (await put(u, 'in1.txt', 'x', { folder: d.id })).data, in2 = (await put(u, 'in2.txt', 'y', { folder: sub.id })).data
    await u.call('DELETE', `/api/drive/folders/${d.id}`)
    assert.equal((await u.call('GET', '/api/drive/folders')).data.folders.length, 0)
    assert.equal((await u.call('GET', `/api/drive/files/${in2.id}`)).status, 404)
    assert.equal((await u.call('GET', '/api/drive/trash')).data.folders.length, 1)
    await u.call('POST', `/api/drive/folders/${d.id}/restore`)
    assert.equal(text(await u.call('GET', `/api/drive/files/${in2.id}`)), 'y')
    assert.equal((await u.call('GET', `/api/drive/browse?folder=${d.id}`)).data.files[0].id, in1.id)
    // retention sweep
    await u.call('DELETE', `/api/drive/files/${in1.id}`)
    assert.equal(app.ctx.driveSweep.trash(Date.now() + 29 * 86_400_000), 0)
    assert.equal(app.ctx.driveSweep.trash(Date.now() + 31 * 86_400_000), 1)
    assert.equal(app.db.get('files', in1.id), null)
    // empty trash
    const t = (await put(u, 't.txt', 'tt')).data
    await u.call('DELETE', `/api/drive/files/${t.id}`)
    assert.equal((await u.call('DELETE', '/api/drive/trash')).data.purged, 1)
  })
})

test('versions: labels, restore as new version, retention cap keeps labelled versions', async () => {
  process.env.RD_DRIVE_MAX_VERSIONS = '3'
  try {
    await withApp(async (app) => {
      const u = await app.register()
      let f = (await put(u, 'v.txt', 'v1')).data
      assert.equal((await u.call('PATCH', `/api/drive/files/${f.id}/versions/1`, { body: { label: 'first release' } })).data.label, 'first release')
      assert.equal((await u.call('PATCH', `/api/drive/files/${f.id}/versions/1`, { body: { label: 'x'.repeat(200) } })).status, 400)
      for (const n of [2, 3, 4, 5]) f = (await put(u, 'v.txt', `v${n}`)).data
      const vers = (await u.call('GET', `/api/drive/files/${f.id}/versions`)).data.versions
      assert.deepEqual(vers.map((x) => x.version), [1, 4, 5], 'labelled v1 survives; the oldest unlabelled versions are pruned')
      assert.equal(text(await u.call('GET', `/api/drive/files/${f.id}?version=1`)), 'v1')
      assert.equal((await u.call('GET', `/api/drive/files/${f.id}?version=2`)).status, 404)
      const restored = (await u.call('POST', `/api/drive/files/${f.id}/versions/1/restore`)).data
      assert.equal(text(await u.call('GET', `/api/drive/files/${f.id}`)), 'v1')
      assert.equal(restored.versionCount, 3)
      assert.equal(app.db.get('files', f.id).versions.at(-1).n, 6, 'version numbers never repeat')
    })
  } finally { delete process.env.RD_DRIVE_MAX_VERSIONS }
})

test('metadata: rename, move, star, tags, copy, name collisions', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const d = await mkdir(u, 'd')
    const a = (await put(u, 'a.txt', 'aa')).data
    const b = (await put(u, 'b.txt', 'bb')).data
    assert.equal((await u.call('PATCH', `/api/drive/files/${a.id}`, { body: { name: 'b.txt' } })).status, 409)
    assert.equal((await u.call('PATCH', `/api/drive/files/${a.id}`, { body: { name: '../x' } })).status, 400)
    const m = (await u.call('PATCH', `/api/drive/files/${a.id}`, { body: { folderId: d.id, starred: true, tags: ['x', 'x', 'y'] } })).data
    assert.equal(m.folderId, d.id); assert.equal(m.starred, true); assert.deepEqual(m.tags, ['x', 'y'])
    assert.equal((await u.call('PATCH', `/api/drive/files/${a.id}`, { body: { tags: 'nope' } })).status, 400)
    assert.equal((await u.call('GET', '/api/drive/files?starred=1')).data.files.length, 1)
    const c1 = (await u.call('POST', `/api/drive/files/${b.id}/copy`, { body: {} })).data
    const c2 = (await u.call('POST', `/api/drive/files/${b.id}/copy`, { body: {} })).data
    assert.notEqual(c1.name, c2.name)
    await u.call('DELETE', `/api/drive/files/${b.id}?permanent=1`)
    assert.equal(text(await u.call('GET', `/api/drive/files/${c1.id}`)), 'bb', 'copies own their data')
  })
})

test('search: names, content, prefixes, trash, isolation', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    await put(u, 'quarterly-report.txt', 'revenue grew strongly in the northern region')
    await put(u, 'notes.md', 'meeting about pineapple logistics', { type: 'text/markdown' })
    await put(u, 'page.html', '<html><body><script>hidden()</script><p>visible zebra</p></body></html>', { type: 'text/html' })
    await put(u, 'blob.bin', Buffer.from('pineapple'), { type: 'application/octet-stream' })
    await put(v, 'theirs.txt', 'pineapple of another user')
    const q = async (s) => (await u.call('GET', `/api/drive/search?q=${encodeURIComponent(s)}`)).data.files.map((f) => f.name).sort()
    assert.deepEqual(await q('pineapple'), ['notes.md'], 'binary content is not indexed, other users are invisible')
    assert.deepEqual(await q('quarterly'), ['quarterly-report.txt'])
    assert.deepEqual(await q('northern region'), ['quarterly-report.txt'])
    assert.deepEqual(await q('pinea'), ['notes.md'], 'prefix match')
    assert.deepEqual(await q('zebra'), ['page.html'])
    assert.deepEqual(await q('hidden'), [], 'script bodies are not indexed')
    assert.deepEqual(await q('PINEAPPLE'), ['notes.md'])
    assert.equal((await u.call('GET', '/api/drive/search')).status, 400)
    const n = (await u.call('GET', '/api/drive/files')).data.files.find((f) => f.name === 'notes.md')
    await u.call('DELETE', `/api/drive/files/${n.id}`)
    assert.deepEqual(await q('pineapple'), [])
    await u.call('POST', `/api/drive/files/${n.id}/restore`)
    assert.deepEqual(await q('pineapple'), ['notes.md'])
    await u.call('PATCH', `/api/drive/files/${n.id}`, { body: { name: 'renamed-gizmo.md' } })
    assert.deepEqual(await q('gizmo'), ['renamed-gizmo.md'])
  })
})

test('link shares: permissions, expiry, download limits, password, revoke, access log', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const f = (await put(u, 's.txt', 'secret text')).data
    assert.equal((await v.call('POST', `/api/drive/files/${f.id}/share`, { body: {} })).status, 404)
    for (const body of [{ expiresInHours: -1 }, { expiresInHours: 'x' }, { maxDownloads: 0 }, { maxDownloads: 1.5 }, { password: 'abc' }]) assert.equal((await u.call('POST', `/api/drive/files/${f.id}/share`, { body })).status, 400, JSON.stringify(body))
    // plain link (back-compat shape)
    const plain = (await u.call('POST', `/api/drive/files/${f.id}/share`)).data
    assert.match(plain.url, /^\/s\//)
    assert.equal(text(await app.call('GET', plain.url)), 'secret text')
    // view permission renders text inline
    const view = (await u.call('POST', `/api/drive/files/${f.id}/share`, { body: { permission: 'view' } })).data
    assert.match((await app.call('GET', view.url)).headers.get('content-disposition'), /^inline/)
    // limits
    const once = (await u.call('POST', `/api/drive/files/${f.id}/share`, { body: { maxDownloads: 1 } })).data
    assert.equal((await app.call('GET', once.url)).status, 200)
    assert.equal((await app.call('GET', once.url)).status, 404)
    const exp = (await u.call('POST', `/api/drive/files/${f.id}/share`, { body: { expiresInHours: 1 } })).data
    assert.equal((await app.call('GET', exp.url)).status, 200)
    const row = app.db.findOne('shares', (s) => s.token === exp.token)
    app.db.update('shares', row.id, { expiresAt: Date.now() - 1000 })
    assert.equal((await app.call('GET', exp.url)).status, 404)
    // password
    const pw = (await u.call('POST', `/api/drive/files/${f.id}/share`, { body: { password: 'hunter22' } })).data
    assert.equal(pw.passwordProtected, true)
    assert.equal(JSON.stringify(app.db.findOne('shares', (s) => s.token === pw.token)).includes('hunter22'), false)
    const no = await app.call('GET', pw.url)
    assert.equal(no.status, 401); assert.equal(no.headers.get('x-share-password-required'), '1')
    assert.equal((await app.call('GET', `${pw.url}?password=hunter22`)).status, 401, 'passwords are never accepted in the URL')
    assert.equal(text(await app.call('GET', pw.url, { headers: { 'x-share-password': 'hunter22' } })), 'secret text')
    const viaPost = await app.call('POST', `/api/drive/public/${pw.token}/download`, { body: { password: 'hunter22' } })
    assert.equal(text(viaPost), 'secret text')
    for (let i = 0; i < 12; i++) await app.call('GET', pw.url, { headers: { 'x-share-password': `guess${i}` } })
    assert.equal((await app.call('GET', pw.url, { headers: { 'x-share-password': 'hunter22' } })).status, 429, 'brute force is throttled even for the right password')
    const log = (await u.call('GET', `/api/drive/files/${f.id}/shares`)).data.shares.find((s) => s.token === pw.token)
    assert.ok(log.accessLog.length > 0 && log.accessLog.some((l) => l.ok === false))
    // revoke + trashed
    assert.equal((await v.call('DELETE', `/api/drive/shares/${plain.token}`)).status, 404)
    assert.equal((await u.call('DELETE', `/api/drive/shares/${plain.token}`)).status, 200)
    assert.equal((await app.call('GET', plain.url)).status, 404)
    await u.call('DELETE', `/api/drive/files/${f.id}`)
    assert.equal((await app.call('GET', view.url)).status, 404, 'links to trashed files stop working')
    assert.equal((await app.call('GET', '/s/not-a-token')).status, 404)
  })
})

test('people sharing: viewer vs editor, no account enumeration, shared-with-me, revoke', async () => {
  await withApp(async (app) => {
    const owner = await app.register(), viewer = await app.register(), editor = await app.register(), stranger = await app.register()
    const f = (await put(owner, 'team.txt', 'v1')).data
    const r1 = await owner.call('POST', `/api/drive/files/${f.id}/acl`, { body: { email: viewer.user.email, role: 'viewer' } })
    const r2 = await owner.call('POST', `/api/drive/files/${f.id}/acl`, { body: { email: 'nobody@nowhere.dev', role: 'viewer' } })
    assert.deepEqual(r1.data, r2.data, 'same answer for existing and unknown accounts')
    await owner.call('POST', `/api/drive/files/${f.id}/acl`, { body: { email: editor.user.email, role: 'editor' } })
    assert.equal((await owner.call('POST', `/api/drive/files/${f.id}/acl`, { body: { email: viewer.user.email, role: 'admin' } })).status, 400)
    assert.equal(text(await viewer.call('GET', `/api/drive/files/${f.id}`)), 'v1')
    assert.equal((await viewer.call('PUT', `/api/drive/files/${f.id}/content`, { raw: 'hack' })).status, 403)
    assert.equal((await viewer.call('PATCH', `/api/drive/files/${f.id}`, { body: { name: 'x' } })).status, 403)
    assert.equal((await viewer.call('DELETE', `/api/drive/files/${f.id}`)).status, 403)
    assert.equal((await viewer.call('POST', `/api/drive/files/${f.id}/share`)).status, 403)
    assert.equal((await viewer.call('GET', `/api/drive/files/${f.id}/acl`)).status, 403)
    assert.equal((await editor.call('PUT', `/api/drive/files/${f.id}/content`, { raw: 'edited by editor' })).status, 200)
    assert.equal(text(await owner.call('GET', `/api/drive/files/${f.id}`)), 'edited by editor')
    assert.equal((await editor.call('DELETE', `/api/drive/files/${f.id}`)).status, 403, 'editors cannot trash')
    assert.equal((await stranger.call('GET', `/api/drive/files/${f.id}`)).status, 404)
    assert.equal((await stranger.call('PUT', `/api/drive/files/${f.id}/content`, { raw: 'x' })).status, 404)
    const shared = (await viewer.call('GET', '/api/drive/shared')).data.files
    assert.equal(shared.length, 1); assert.equal(shared[0].role, 'viewer')
    assert.equal((await stranger.call('GET', '/api/drive/shared')).data.files.length, 0)
    assert.ok((await viewer.call('GET', '/api/notifications')).data.notifications.some((n) => /shared/.test(n.title)))
    const act = (await owner.call('GET', `/api/drive/files/${f.id}/activity`)).data.activity
    assert.ok(act.some((a) => a.action === 'edit'))
    const acl = (await owner.call('GET', `/api/drive/files/${f.id}/acl`)).data.acl
    const vEntry = acl.find((e) => e.email === viewer.user.email)
    assert.equal((await owner.call('DELETE', `/api/drive/files/${f.id}/acl/${vEntry.id}`)).status, 200)
    assert.equal((await viewer.call('GET', `/api/drive/files/${f.id}`)).status, 404)
    // folder ACL is inherited
    const d = await mkdir(owner, 'shared-folder')
    const inside = (await put(owner, 'inside.txt', 'in', { folder: d.id })).data
    app.db.insert('drive_acl', { ownerId: owner.user.id, folderId: d.id, principalType: 'user', principalId: stranger.user.id, role: 'viewer' })
    assert.equal(text(await stranger.call('GET', `/api/drive/files/${inside.id}`)), 'in')
  })
})

test('chunked uploads: assemble, ranges across chunks, validation, abort, expiry, quota', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const a = Buffer.alloc(1000, 'a'), b = Buffer.alloc(1000, 'b'), c = Buffer.alloc(500, 'c')
    assert.equal((await u.call('POST', '/api/drive/uploads', { body: { name: 'big.bin', size: -1 } })).status, 400)
    assert.equal((await u.call('POST', '/api/drive/uploads', { body: { name: '../x', size: 10 } })).status, 400)
    const up = (await u.call('POST', '/api/drive/uploads', { body: { name: 'big.bin', size: 2500, contentType: 'application/octet-stream' } })).data
    assert.equal((await v.call('PUT', `/api/drive/uploads/${up.uploadId}/parts/1`, { raw: a })).status, 404)
    assert.equal((await u.call('PUT', `/api/drive/uploads/${up.uploadId}/parts/0`, { raw: a })).status, 400)
    assert.equal((await u.call('PUT', `/api/drive/uploads/${up.uploadId}/parts/1`, { raw: Buffer.alloc(0) })).status, 400)
    await u.call('PUT', `/api/drive/uploads/${up.uploadId}/parts/2`, { raw: b })
    assert.equal((await u.call('POST', `/api/drive/uploads/${up.uploadId}/complete`)).status, 400, 'part 1 missing')
    await u.call('PUT', `/api/drive/uploads/${up.uploadId}/parts/1`, { raw: a })
    assert.equal((await u.call('POST', `/api/drive/uploads/${up.uploadId}/complete`)).status, 400, 'size mismatch')
    assert.equal((await u.call('PUT', `/api/drive/uploads/${up.uploadId}/parts/3`, { raw: Buffer.alloc(600) })).status, 400, 'over the declared size')
    await u.call('PUT', `/api/drive/uploads/${up.uploadId}/parts/3`, { raw: c })
    const done = await u.call('POST', `/api/drive/uploads/${up.uploadId}/complete`)
    assert.equal(done.status, 201); assert.equal(done.data.size, 2500)
    const whole = (await u.call('GET', `/api/drive/files/${done.data.id}`)).data
    assert.ok(whole.equals(Buffer.concat([a, b, c])))
    const mid = (await u.call('GET', `/api/drive/files/${done.data.id}`, { headers: { range: 'bytes=990-2010' } }))
    assert.equal(mid.status, 206)
    assert.ok(mid.data.equals(Buffer.concat([a, b, c]).subarray(990, 2011)), 'range spanning three chunks')
    assert.equal(done.data.sha256, (await import('node:crypto')).createHash('sha256').update(Buffer.concat([a, b, c])).digest('hex'))
    assert.equal((await u.call('GET', `/api/drive/uploads/${up.uploadId}`)).status, 404, 'finished uploads are gone')
    // abort frees parts
    const up2 = (await u.call('POST', '/api/drive/uploads', { body: { name: 'x.bin', size: 10 } })).data
    await u.call('PUT', `/api/drive/uploads/${up2.uploadId}/parts/1`, { raw: Buffer.alloc(5) })
    const blob = app.db.get('drive_uploads', up2.uploadId).parts[1].blobId
    assert.equal((await u.call('DELETE', `/api/drive/uploads/${up2.uploadId}`)).status, 200)
    assert.equal(app.db.hasBlob(blob), false)
    // expiry sweep
    const up3 = (await u.call('POST', '/api/drive/uploads', { body: { name: 'y.bin', size: 10 } })).data
    app.db.update('drive_uploads', up3.uploadId, { expiresAt: Date.now() - 1 })
    assert.equal(app.ctx.driveSweep.uploads(), 1)
    // quota
    process.env.RD_DRIVE_QUOTA_BYTES = '4000'
    try {
      assert.equal((await u.call('POST', '/api/drive/uploads', { body: { name: 'z.bin', size: 5000 } })).status, 413)
      assert.equal((await put(u, 'fits.txt', Buffer.alloc(1000))).status, 201)
      assert.equal((await put(u, 'nope.txt', Buffer.alloc(1000))).status, 413, 'versions of existing files count too: 2500 + 1000 + 1000 > 4000')
      assert.equal((await u.call('GET', '/api/drive/usage')).data.used, 3500)
    } finally { delete process.env.RD_DRIVE_QUOTA_BYTES }
  })
})

function parseZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16)
  const names = []
  let p = cdOff
  for (let i = 0; i < count; i++) { const nl = buf.readUInt16LE(p + 28); names.push(buf.toString('utf8', p + 46, p + 46 + nl)); p += 46 + nl }
  return names
}
test('zip: files and folders stream into a valid archive (verified with python zipfile)', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const d = await mkdir(u, 'proj'), sub = await mkdir(u, 'sub', d.id)
    const a = (await put(u, 'a.txt', 'alpha '.repeat(500))).data
    const b = (await put(u, 'b.txt', 'beta', { folder: d.id })).data
    const c = (await put(u, 'c.bin', Buffer.from([0, 1, 2, 3, 255]), { folder: sub.id, type: 'application/octet-stream' })).data
    const z = await u.call('POST', '/api/drive/zip', { body: { fileIds: [a.id], folderIds: [d.id] } })
    assert.equal(z.status, 200); assert.equal(z.headers.get('content-type'), 'application/zip')
    assert.deepEqual(parseZip(z.data).sort(), ['a.txt', 'proj/b.txt', 'proj/sub/c.bin'])
    const dir = mkdtempSync(path.join(tmpdir(), 'rdzip-'))
    try {
      writeFileSync(path.join(dir, 't.zip'), z.data)
      const py = spawnSync('python3', ['-I', '-c', "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(z.read('a.txt').decode()[:12], z.read('proj/b.txt').decode(), list(z.read('proj/sub/c.bin')))", path.join(dir, 't.zip')], { encoding: 'utf8' })
      assert.equal(py.status, 0, py.stderr)
      assert.equal(py.stdout.trim(), 'alpha alpha  beta [0, 1, 2, 3, 255]')
    } finally { rmSync(dir, { recursive: true, force: true }) }
    assert.equal((await u.call('POST', '/api/drive/zip', { body: {} })).status, 400)
    assert.equal((await v.call('POST', '/api/drive/zip', { body: { fileIds: [a.id] } })).status, 404, "cannot zip someone else's file")
    assert.equal((await u.call('POST', '/api/drive/zip', { body: { fileIds: [b.id, b.id] } })).status, 200, 'duplicate ids are tolerated')
    void c
  })
})

test('duplicates and usage reporting', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    await put(u, 'one.txt', 'same bytes'); await put(u, 'two.txt', 'same bytes'); await put(u, 'three.txt', 'different')
    const g = (await u.call('GET', '/api/drive/duplicates')).data.groups
    assert.equal(g.length, 1); assert.equal(g[0].files.length, 2)
    const us = (await u.call('GET', '/api/drive/usage')).data
    assert.equal(us.used, 10 + 10 + 9); assert.equal(us.files, 3)
  })
})

test('auth required everywhere except public share links; blob refs registered', async () => {
  await withApp(async (app) => {
    for (const [m, p] of [['GET', '/api/drive/files'], ['GET', '/api/drive/browse'], ['GET', '/api/drive/trash'], ['POST', '/api/drive/zip'], ['GET', '/api/drive/search?q=a'], ['POST', '/api/drive/uploads'], ['GET', '/api/drive/usage']]) {
      assert.equal((await app.call(m, p)).status, 401, `${m} ${p}`)
    }
    assert.equal((await app.call('GET', '/s/abc')).status, 404)
    const u = await app.register()
    const f = (await put(u, 'r.txt', 'data')).data
    const refs = [...app.ctx.blobRefs.get('drive')()]
    assert.ok(refs.includes(app.db.get('files', f.id).versions[0].blobId))
  })
})
