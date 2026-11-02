import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startTestApp } from './helpers.js'
import { metricAt } from '../src/modules/compute.js'
import { summarize } from '../src/billing.js'

async function withApp(fn, env = {}) {
  const old = { RD_QUOTAS_DISABLED: process.env.RD_QUOTAS_DISABLED }
  process.env.RD_QUOTAS_DISABLED = '1'
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; process.env[k] = v }
  const app = await startTestApp()
  try { await fn(app) } finally {
    await app.close()
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}
const post = (u, p, body) => u.call('POST', p, { body })
const launch = async (u, body = {}) => { const r = await post(u, '/api/compute/instances', { name: 'i', ...body }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data }
const get = async (u, id) => (await u.call('GET', `/api/compute/instances/${id}`)).data

test('instance lifecycle: state machine, invalid transitions, resize, reboot, events and console', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const i = await launch(u, { name: 'web', type: 'medium' })
    assert.equal(i.state, 'running'); assert.equal(i.simulated, true); assert.equal(i.vcpu, 2); assert.equal(i.az, 'rd-east-1a'); assert.equal(i.image, 'rd-linux-2026')
    for (const [action, body] of [['start'], ['resize', { type: 'large' }]]) assert.equal((await post(u, `/api/compute/instances/${i.id}/${action}`, body ?? {})).status, 409, action)
    assert.equal((await post(u, `/api/compute/instances/${i.id}/reboot`, {})).data.state, 'running')
    assert.equal((await post(u, `/api/compute/instances/${i.id}/stop`, {})).data.state, 'stopped')
    assert.equal((await post(u, `/api/compute/instances/${i.id}/stop`, {})).status, 409)
    assert.equal((await post(u, `/api/compute/instances/${i.id}/reboot`, {})).status, 409)
    assert.equal((await post(u, `/api/compute/instances/${i.id}/resize`, { type: 'huge' })).status, 400)
    const big = (await post(u, `/api/compute/instances/${i.id}/resize`, { type: 'large' })).data
    assert.equal(big.type, 'large'); assert.equal(big.memGb, 32)
    assert.equal((await post(u, `/api/compute/instances/${i.id}/start`, {})).data.state, 'running')
    const d = await get(u, i.id)
    assert.deepEqual(d.events.map((e) => e.state), ['pending', 'running', 'running', 'stopping', 'stopped', 'stopped', 'pending', 'running'])
    const log = (await u.call('GET', `/api/compute/instances/${i.id}/console`)).data.lines.join('\n')
    assert.match(log, /launch requested/); assert.match(log, /instance is ready \(simulated\)/); assert.match(log, /stop requested/)
    assert.equal((await post(u, `/api/compute/instances/${i.id}/terminate`, {})).data.state, 'terminated')
    assert.equal((await post(u, `/api/compute/instances/${i.id}/start`, {})).status, 409)
    assert.equal((await u.call('GET', '/api/compute/instances')).data.instances.length, 0)
    assert.equal((await u.call('GET', '/api/compute/instances?includeTerminated=1')).data.instances.length, 1)
    for (const [m, p, body] of [['GET', `/api/compute/instances/${i.id}`], ['PATCH', `/api/compute/instances/${i.id}`, { name: 'x' }], ['POST', `/api/compute/instances/${i.id}/stop`, {}], ['GET', `/api/compute/instances/${i.id}/console`], ['GET', `/api/compute/instances/${i.id}/metrics`]]) assert.equal((await v.call(m, p, body ? { body } : {})).status, 404, `${m} ${p}`)
    assert.equal((await app.call('GET', '/api/compute/instances')).status, 401)
  })
})

test('transitional states with simulated delays are real, block conflicting operations and settle', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const i = await launch(u, { name: 'slow' })
    assert.equal(i.state, 'pending'); assert.equal(i.runningSince, null)
    assert.equal((await post(u, `/api/compute/instances/${i.id}/stop`, {})).status, 409, 'cannot stop while pending')
    await new Promise((r) => setTimeout(r, 150))
    assert.equal((await get(u, i.id)).state, 'running')
    assert.equal((await post(u, `/api/compute/instances/${i.id}/stop`, {})).data.state, 'stopping')
    assert.equal((await post(u, `/api/compute/instances/${i.id}/start`, {})).status, 409, 'cannot start while stopping')
    assert.equal((await post(u, `/api/compute/instances/${i.id}/terminate`, {})).status, 409)
    await new Promise((r) => setTimeout(r, 150))
    assert.equal((await get(u, i.id)).state, 'stopped')
    await post(u, `/api/compute/instances/${i.id}/terminate`, {})
    assert.equal((await get(u, i.id)).state, 'shutting-down')
    app.ctx.compute.settleAll()
    assert.equal((await get(u, i.id)).state, 'terminated')
  }, { RD_SIM_DELAY_MS: '80' })
})

test('launch validation, tags, filters, user data, quotas', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const bad = async (body) => (await post(u, '/api/compute/instances', body)).status
    for (const body of [{}, { name: '' }, { name: 'x'.repeat(64) }, { name: 'ok', type: 'huge' }, { name: 'ok', image: 'windows-95' }, { name: 'ok', region: 'mars-1' }, { name: 'ok', az: 'rd-east-9z' }, { name: 'ok', tags: 'nope' }, { name: 'ok', tags: { 'bad key!': 'x' } }, { name: 'ok', tags: { a: 5 } }, { name: 'ok', tags: { 'rd:internal': 'x' } }, { name: 'ok', userData: 'x'.repeat(20000) }, { name: 'ok', keyPairId: 'nope' }, { name: 'ok', subnetId: 'nope' }]) assert.equal(await bad(body), body.keyPairId || body.subnetId ? 404 : 400, JSON.stringify(body).slice(0, 60))
    const a = await launch(u, { name: 'alpha web', tags: { env: 'prod', workload: 'web' }, userData: '#!/bin/sh\necho hi' })
    await launch(u, { name: 'beta', tags: { env: 'dev' } })
    assert.deepEqual(a.tags, { env: 'prod', workload: 'web' }); assert.equal(a.userData, '#!/bin/sh\necho hi')
    const names = async (qs) => (await u.call('GET', `/api/compute/instances?${qs}`)).data.instances.map((x) => x.name).sort()
    assert.deepEqual(await names('tag.env=prod'), ['alpha web']); assert.deepEqual(await names('name=BETA'), ['beta']); assert.deepEqual(await names('state=stopped'), []); assert.deepEqual(await names('state=running'), ['alpha web', 'beta'])
    const patched = (await u.call('PATCH', `/api/compute/instances/${a.id}`, { body: { name: 'renamed', tags: { env: 'staging' } } })).data
    assert.equal(patched.name, 'renamed'); assert.deepEqual(patched.tags, { env: 'staging' })
    assert.equal((await u.call('PATCH', `/api/compute/instances/${a.id}`, { body: { name: '' } })).status, 400)
    assert.equal((await u.call('GET', '/api/compute/regions')).data.regions.length, 3)
    assert.ok((await u.call('GET', '/api/compute/images')).data.images.some((x) => x.id === 'ubuntu-24.04'))
    assert.equal((await u.call('GET', '/api/compute/types')).data.types.find((t) => t.id === 'large').pricePerHour, 0.16)
  })
  await withApp(async (app) => {
    const u = await app.register()
    for (let i = 0; i < 2; i++) await launch(u)
    const r = await post(u, '/api/compute/instances', { name: 'third' })
    assert.equal(r.status, 409); assert.match(r.data.error, /At most 2/)
  }, { RD_COMPUTE_MAX_INSTANCES: '2' })
  const app = await startTestApp() // plan quotas stay enabled here
  try {
    const u = await app.register()
    for (let i = 0; i < 3; i++) await launch(u)
    const r = await post(u, '/api/compute/instances', { name: 'fourth' })
    assert.equal(r.status, 429); assert.match(r.data.error, /Compute instances limit/)
  } finally { await app.close() }
})

test('key pairs: real ed25519, private key shown once, OpenSSH public key and fingerprint verified independently', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const kp = (await post(u, '/api/compute/keypairs', { name: 'my key' })).data
    assert.match(kp.privateKey, /^-----BEGIN PRIVATE KEY-----/); assert.match(kp.publicKey, /^ssh-ed25519 AAAA[A-Za-z0-9+/]+ my_key$/); assert.match(kp.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/)
    // decode the OpenSSH blob and prove the private key signs for it
    const blob = Buffer.from(kp.publicKey.split(' ')[1], 'base64')
    assert.equal(blob.readUInt32BE(0), 11); assert.equal(blob.subarray(4, 15).toString(), 'ssh-ed25519'); assert.equal(blob.readUInt32BE(15), 32)
    const raw = blob.subarray(19)
    assert.equal(`SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`, kp.fingerprint)
    const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' })
    const sig = crypto.sign(null, Buffer.from('hello'), crypto.createPrivateKey(kp.privateKey))
    assert.equal(crypto.verify(null, Buffer.from('hello'), pub, sig), true)
    const listed = (await u.call('GET', '/api/compute/keypairs')).data.keyPairs
    assert.equal(listed.length, 1); assert.equal(listed[0].privateKey, undefined, 'the private key is never stored or returned again')
    assert.ok(!JSON.stringify(app.db.get('cmp_keypairs', kp.id)).includes('PRIVATE'))
    assert.equal((await post(u, '/api/compute/keypairs', { name: 'my key' })).status, 409)
    assert.equal((await post(u, '/api/compute/keypairs', { name: '' })).status, 400)
    const kp2 = (await post(u, '/api/compute/keypairs', { name: 'second' })).data
    assert.notEqual(kp2.publicKey, kp.publicKey)
    const inst = await launch(u, { keyPairId: kp.id })
    assert.equal(inst.keyName, 'my key')
    assert.equal((await post(v, '/api/compute/instances', { name: 'steal', keyPairId: kp.id })).status, 404, "other users' key pairs are invisible")
    assert.equal((await v.call('DELETE', `/api/compute/keypairs/${kp.id}`)).status, 404)
    assert.equal((await u.call('DELETE', `/api/compute/keypairs/${kp.id}`)).status, 200)
    for (let i = 0; i < 19; i++) assert.equal((await post(u, '/api/compute/keypairs', { name: `k${i}` })).status, 201)
    assert.equal((await post(u, '/api/compute/keypairs', { name: 'too-many' })).status, 409)
  })
})

test('volumes and snapshots: attach rules, resize, snapshots, caps, cleanup on termination, metering', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const inst = await launch(u, { name: 'db' })
    for (const body of [{}, { sizeGb: 0 }, { sizeGb: 20000 }, { sizeGb: 1.5 }, { sizeGb: 10, type: 'tape' }, { sizeGb: 10, az: 'nowhere' }, { sizeGb: 10, name: '' }]) assert.equal((await post(u, '/api/compute/volumes', body)).status, 400, JSON.stringify(body))
    const vol = (await post(u, '/api/compute/volumes', { sizeGb: 20, name: 'data' })).data
    assert.equal(vol.state, 'available')
    const wrongAz = (await post(u, '/api/compute/volumes', { sizeGb: 5, az: 'rd-east-1b' })).data
    assert.equal((await post(u, `/api/compute/volumes/${wrongAz.id}/attach`, { instanceId: inst.id })).status, 400, 'availability zones must match')
    assert.equal((await post(v, `/api/compute/volumes/${vol.id}/attach`, { instanceId: inst.id })).status, 404)
    const att = (await post(u, `/api/compute/volumes/${vol.id}/attach`, { instanceId: inst.id })).data
    assert.equal(att.state, 'in-use'); assert.equal(att.attachment.device, '/dev/sdf')
    assert.equal((await post(u, `/api/compute/volumes/${vol.id}/attach`, { instanceId: inst.id })).status, 409)
    assert.equal((await u.call('DELETE', `/api/compute/volumes/${vol.id}`)).status, 409, 'detach first')
    assert.deepEqual((await get(u, inst.id)).volumes, [{ id: vol.id, device: '/dev/sdf', sizeGb: 20 }])
    const v2 = (await post(u, '/api/compute/volumes', { sizeGb: 5 })).data
    assert.equal((await post(u, `/api/compute/volumes/${v2.id}/attach`, { instanceId: inst.id, device: '/dev/sdf' })).status, 409, 'device in use')
    assert.equal((await post(u, `/api/compute/volumes/${v2.id}/attach`, { instanceId: inst.id, device: '/etc/passwd' })).status, 400)
    assert.equal((await post(u, `/api/compute/volumes/${vol.id}/resize`, { sizeGb: 10 })).status, 400, 'volumes only grow')
    assert.equal((await post(u, `/api/compute/volumes/${vol.id}/resize`, { sizeGb: 50 })).data.sizeGb, 50)
    const snap = (await post(u, `/api/compute/volumes/${vol.id}/snapshots`, { description: 'nightly' })).data
    assert.equal(snap.sizeGb, 50); assert.equal(snap.state, 'completed')
    assert.equal((await post(u, '/api/compute/volumes', { snapshotId: snap.id, sizeGb: 10 })).status, 400, 'restore size must be at least the snapshot size')
    assert.equal((await post(u, '/api/compute/volumes', { snapshotId: snap.id })).data.sizeGb, 50, 'size defaults to the snapshot size')
    assert.equal((await post(v, '/api/compute/volumes', { snapshotId: snap.id })).status, 404)
    // termination detaches
    await post(u, `/api/compute/instances/${inst.id}/terminate`, {})
    const after = (await u.call('GET', '/api/compute/volumes')).data.volumes.find((x) => x.id === vol.id)
    assert.equal(after.state, 'available'); assert.equal(after.attachment, null)
    assert.equal((await u.call('DELETE', `/api/compute/volumes/${vol.id}`)).status, 200)
    assert.equal((await u.call('GET', `/api/compute/volumes/${vol.id}`)).status, 404)
    assert.equal((await u.call('DELETE', `/api/compute/snapshots/${snap.id}`)).status, 200)
    // metering: volume GB-months accrue daily (idempotently)
    const st = app.db.findOne('billing_state', (s) => s.userId === u.user.id)
    if (st) app.db.update('billing_state', st.id, { storageDay: new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10) })
    else app.db.insert('billing_state', { userId: u.user.id, storageDay: new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10) })
    const line = summarize(app.db, u.user.id).lines.find((l) => l.kind === 'compute.volume_gb_month')
    assert.ok(line && line.qty > 0, 'volume usage metered')
    const q1 = line.qty
    assert.equal(summarize(app.db, u.user.id).lines.find((l) => l.kind === 'compute.volume_gb_month').qty, q1, 'idempotent')
  })
  await withApp(async (app) => {
    const u = await app.register()
    assert.equal((await post(u, '/api/compute/volumes', { sizeGb: 80 })).status, 201)
    assert.equal((await post(u, '/api/compute/volumes', { sizeGb: 30 })).status, 409, 'total size cap')
    for (let i = 0; i < 4; i++) await post(u, '/api/compute/volumes', { sizeGb: 1 })
  }, { RD_COMPUTE_MAX_VOLUME_GB: '100', RD_COMPUTE_MAX_VOLUMES: '5' })
})

test('metrics: deterministic, bounded to running time, workload-aware, validated', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const idle = await launch(u, { name: 'idle', tags: { workload: 'idle' } }), batch = await launch(u, { name: 'batch', tags: { workload: 'batch' } })
    const m = async (id, qs = '') => (await u.call('GET', `/api/compute/instances/${id}/metrics${qs}`)).data
    const a = await m(idle.id), b = await m(idle.id)
    assert.deepEqual(a.series, b.series, 'the same request returns identical data')
    assert.equal(a.simulated, true); assert.match(a.note, /Synthetic/)
    assert.ok(a.series.length >= 1)
    const avg = (s) => s.series.reduce((x, p) => x + p.cpu, 0) / s.series.length
    assert.ok(avg(await m(batch.id)) > avg(a) + 30, 'a batch workload burns more CPU than an idle one')
    for (const p of a.series) { assert.ok(p.cpu >= 1 && p.cpu <= 100 && p.memory >= 5 && p.memory <= 98); for (const k of ['netIn', 'netOut', 'diskRead', 'diskWrite']) assert.ok(Number.isInteger(p[k]) && p[k] >= 0) }
    assert.equal((await m(idle.id, '?window=24h')).period, 300)
    assert.equal((await u.call('GET', `/api/compute/instances/${idle.id}/metrics?window=7d`)).status, 400)
    assert.equal((await u.call('GET', `/api/compute/instances/${idle.id}/metrics?period=7`)).status, 400)
    // a stopped instance stops producing samples
    const before = (await m(idle.id)).series.length
    await post(u, `/api/compute/instances/${idle.id}/stop`, {})
    const stopped = await m(idle.id)
    assert.ok(stopped.series.length <= before)
    assert.ok(Date.parse(stopped.series.at(-1).t) <= Date.now())
    // metricAt is a pure function of (instance, minute)
    assert.deepEqual(metricAt({ id: 'x', vcpu: 2 }, 12345), metricAt({ id: 'x', vcpu: 2 }, 12345))
    assert.notDeepEqual(metricAt({ id: 'x', vcpu: 2 }, 12345), metricAt({ id: 'y', vcpu: 2 }, 12345))
    assert.equal((await v.call('GET', `/api/compute/instances/${idle.id}/metrics`)).status, 404)
  })
})

test('autoscaling: bounds, launch to desired, target tracking out and in, health replacement, deletion', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const tpl = (tags) => ({ type: 'small', image: 'rd-linux-2026', region: 'rd-east-1', tags })
    for (const body of [{ name: 'g' }, { name: 'g', template: {}, minSize: 3, maxSize: 2 }, { name: 'g', template: tpl({}), minSize: 0, maxSize: 99 }, { name: 'g', template: tpl({}), minSize: 1, maxSize: 3, desired: 5 }, { name: 'g', template: { type: 'huge' } }, { name: 'g', template: tpl({}), targetCpu: 5 }, { name: 'g', template: { ...tpl({}), image: 'nope' } }]) assert.equal((await post(u, '/api/compute/asgs', body)).status, 400, JSON.stringify(body).slice(0, 80))
    const hot = (await post(u, '/api/compute/asgs', { name: 'hot', template: tpl({ workload: 'batch' }), minSize: 1, maxSize: 3, desired: 1, targetCpu: 30, cooldownSec: 0 })).data // batch CPU is 50-94% at any hour, far above 30+10
    assert.equal(hot.members.length, 1); assert.equal(hot.members[0].state, 'running')
    assert.equal((await u.call('GET', '/api/compute/instances')).data.instances[0].asgId, hot.id)
    assert.equal(app.ctx.compute.asgTick(Date.now() + 1), 1, 'busy members -> scale out')
    assert.equal((await u.call('GET', `/api/compute/asgs/${hot.id}`)).data.desired, 2)
    app.ctx.compute.asgTick(Date.now() + 2); app.ctx.compute.asgTick(Date.now() + 3)
    const scaled = (await u.call('GET', `/api/compute/asgs/${hot.id}`)).data
    assert.equal(scaled.desired, 3, 'capped at maxSize'); assert.equal(scaled.members.length, 3)
    assert.ok(scaled.activity.some((a) => /scaling 1 -> 2/.test(a.message)))
    assert.ok(scaled.averageCpu > 45)
    // health replacement
    const victim = scaled.members[0].id
    await post(u, `/api/compute/instances/${victim}/stop`, {})
    app.ctx.compute.asgTick(Date.now() + 4)
    const healed = (await u.call('GET', `/api/compute/asgs/${hot.id}`)).data
    assert.equal(healed.members.length, 3); assert.ok(!healed.members.some((m) => m.id === victim)); assert.ok(healed.activity.some((a) => /replacing unhealthy/.test(a.message)))
    assert.equal((await get(u, victim)).state, 'terminated')
    // idle groups scale in to the minimum
    const cold = (await post(u, '/api/compute/asgs', { name: 'cold', template: tpl({ workload: 'idle' }), minSize: 1, maxSize: 4, desired: 4, targetCpu: 60, cooldownSec: 0 })).data
    assert.equal(cold.members.length, 4)
    for (let i = 0; i < 6; i++) app.ctx.compute.asgTick(Date.now() + 100 + i)
    const shrunk = (await u.call('GET', `/api/compute/asgs/${cold.id}`)).data
    assert.equal(shrunk.desired, 1); assert.equal(shrunk.members.length, 1)
    // manual changes + isolation + deletion
    assert.equal((await u.call('PATCH', `/api/compute/asgs/${cold.id}`, { body: { minSize: 2, maxSize: 1 } })).status, 400)
    assert.equal((await u.call('PATCH', `/api/compute/asgs/${cold.id}`, { body: { desired: 2, maxSize: 4 } })).data.members.length, 2)
    assert.equal((await v.call('GET', `/api/compute/asgs/${cold.id}`)).status, 404)
    assert.equal((await v.call('DELETE', `/api/compute/asgs/${cold.id}`)).status, 404)
    assert.equal((await u.call('DELETE', `/api/compute/asgs/${hot.id}`)).status, 200)
    assert.equal((await u.call('GET', '/api/compute/instances?tag.rd:asg=hot')).data.instances.length, 0, 'deleting the group terminates its instances')
    for (let i = 0; i < 4; i++) await post(u, '/api/compute/asgs', { name: `g${i}`, template: tpl({}), minSize: 0, maxSize: 1, desired: 0 })
    assert.equal((await post(u, '/api/compute/asgs', { name: 'overflow', template: tpl({}), minSize: 0, maxSize: 1, desired: 0 })).status, 409)
  })
})

test('load balancers: validation, targets, health progression, cleanup', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    for (const body of [{}, { name: 'lb', listeners: [] }, { name: 'lb', listeners: [{ port: 0, protocol: 'http' }] }, { name: 'lb', listeners: [{ port: 80, protocol: 'ftp' }] }, { name: 'lb', targetGroup: { port: 99999 } }, { name: 'lb', targetGroup: { healthCheck: { intervalSec: 1 } } }, { name: 'lb', targetGroup: { healthCheck: { path: 'no-slash' } } }]) assert.equal((await post(u, '/api/compute/load-balancers', body)).status, 400, JSON.stringify(body))
    const lb = (await post(u, '/api/compute/load-balancers', { name: 'Public Web', targetGroup: { port: 8080, healthCheck: { path: '/health', intervalSec: 5, healthyThreshold: 2 } } })).data
    assert.match(lb.dnsName, /^public-web-[a-z0-9]{6}\.lb\.rd\.local$/)
    const a = await launch(u, { name: 'a' }), b = await launch(u, { name: 'b' })
    const reg = (await post(u, `/api/compute/load-balancers/${lb.id}/targets`, { instanceId: a.id })).data
    assert.equal(reg.targets[0].port, 8080); assert.equal(reg.targets[0].health.state, 'initial')
    assert.equal((await post(u, `/api/compute/load-balancers/${lb.id}/targets`, { instanceId: a.id })).status, 409)
    assert.equal((await post(v, `/api/compute/load-balancers/${lb.id}/targets`, { instanceId: a.id })).status, 404)
    await post(u, `/api/compute/load-balancers/${lb.id}/targets`, { instanceId: b.id })
    app.db.update('instances', a.id, { runningSince: new Date(Date.now() - 60_000).toISOString() })
    const h = (await u.call('GET', `/api/compute/load-balancers/${lb.id}`)).data.targets
    assert.equal(h.find((t) => t.instanceId === a.id).health.state, 'healthy', 'healthy after interval x threshold'); assert.equal(h.find((t) => t.instanceId === b.id).health.state, 'initial')
    await post(u, `/api/compute/instances/${a.id}/stop`, {})
    const stopped = (await u.call('GET', `/api/compute/load-balancers/${lb.id}`)).data.targets.find((t) => t.instanceId === a.id).health
    assert.equal(stopped.state, 'unhealthy'); assert.match(stopped.reason, /stopped/)
    await post(u, `/api/compute/instances/${b.id}/terminate`, {})
    assert.equal((await u.call('GET', `/api/compute/load-balancers/${lb.id}`)).data.targets.length, 1, 'terminated instances are deregistered')
    assert.equal((await u.call('DELETE', `/api/compute/load-balancers/${lb.id}/targets/${a.id}`)).data.targets.length, 0)
    assert.equal((await u.call('DELETE', `/api/compute/load-balancers/${lb.id}/targets/${a.id}`)).status, 404)
    assert.equal((await v.call('DELETE', `/api/compute/load-balancers/${lb.id}`)).status, 404)
    assert.equal((await u.call('DELETE', `/api/compute/load-balancers/${lb.id}`)).status, 200)
  })
})

test('cost estimator, metering of running time and cleanup on account deletion', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const est = (await post(u, '/api/compute/estimate', { instances: [{ type: 'large', count: 2, hoursPerMonth: 100 }, { type: 'small' }], volumes: [{ sizeGb: 100 }], elasticIps: 1 })).data
    assert.equal(est.lines[0].monthly, 32); assert.equal(est.lines[1].monthly, 7.3); assert.equal(est.lines[2].monthly, 8); assert.equal(est.lines[3].monthly, 3.65)
    assert.equal(est.monthlyTotal, 50.95); assert.equal(est.simulated, true)
    for (const body of [{ instances: [{ type: 'nope' }] }, { instances: [{ type: 'small', count: 0 }] }, { instances: [{ type: 'small', hoursPerMonth: 9999 }] }, { instances: 'x' }, { volumes: [{ sizeGb: -1 }] }]) assert.equal((await post(u, '/api/compute/estimate', body)).status, 400, JSON.stringify(body))
    const i = await launch(u, { type: 'large' })
    app.db.update('instances', i.id, { runningSince: new Date(Date.now() - 2 * 3600_000).toISOString() })
    const line = (await u.call('GET', '/api/billing/usage')).data.lines.find((l) => l.kind === 'compute.large')
    assert.ok(Math.abs(line.qty - 2) < 0.01, `two running hours metered (${line.qty})`)
    const eip = (await post(u, '/api/network/eips', {})).data
    app.db.update('net_eips', eip.id, { billedUntil: Date.now() - 5 * 3600_000 })
    assert.ok(Math.abs((await u.call('GET', '/api/billing/usage')).data.lines.find((l) => l.kind === 'network.eip_hour').qty - 5) < 0.01, 'elastic IP hours metered')
    app.ctx.events.emit('account.deleted', { userId: u.user.id })
    for (const col of ['instances', 'cmp_keypairs', 'cmp_volumes', 'cmp_asgs', 'cmp_lbs', 'net_vpcs', 'net_eips']) assert.equal(app.db.find(col, (x) => x.userId === u.user.id).length, 0, col)
  })
})
