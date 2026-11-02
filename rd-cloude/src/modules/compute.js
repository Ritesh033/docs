// Compute control plane (SIMULATED: there are no real virtual machines. State machines, metering, quotas and bookkeeping are real).
// Instances, key pairs, volumes + snapshots, autoscaling groups, load balancers, simulated metrics and console output. See docs/compute.md.
import crypto from 'node:crypto'
import { HttpError, required } from '../http.js'
import { INSTANCE_TYPES, PRICES, instanceHours, priceOf } from '../billing.js'
import { REGIONS } from './network.js'

const envInt = (name, dflt, min, max) => { const n = Number(process.env[name]); return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : dflt }
const LIM = {
  instances: () => envInt('RD_COMPUTE_MAX_INSTANCES', 25, 1, 1000), volumes: () => envInt('RD_COMPUTE_MAX_VOLUMES', 20, 1, 1000), totalVolumeGb: () => envInt('RD_COMPUTE_MAX_VOLUME_GB', 4096, 1, 1_000_000),
  keypairs: 20, snapshotsPerVolume: 20, asgs: 5, asgMax: 20, lbs: 5, lbTargets: 20, tags: 30, events: 100, consoleLines: 200, attachmentsPerInstance: 8,
  simDelayMs: () => envInt('RD_SIM_DELAY_MS', 0, 0, 60_000),
}
export const IMAGES = [
  { id: 'rd-linux-2026', name: 'RD Linux 2026', os: 'linux', arch: 'x86_64' },
  { id: 'ubuntu-24.04', name: 'Ubuntu Server 24.04 LTS', os: 'linux', arch: 'x86_64' },
  { id: 'debian-12', name: 'Debian 12', os: 'linux', arch: 'x86_64' },
  { id: 'alpine-3.20', name: 'Alpine Linux 3.20', os: 'linux', arch: 'x86_64' },
]
const IMAGE_IDS = new Set(IMAGES.map((i) => i.id))
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.:/-]{0,62}$/
const TAG_KEY_RE = /^[A-Za-z0-9_.:/-]{1,64}$/
const iso = (t = Date.now()) => new Date(t).toISOString()

/* ------------------------------------------------------------------ deterministic simulated metrics */
const h32 = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }
const rnd = (seed) => { let t = (seed + 0x6d2b79f5) >>> 0; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const WORKLOAD = { idle: 4, web: 28, batch: 72, db: 40 }
/** One-minute sample for an instance: a pure function of (instance id, minute), so charts never change between requests. */
export function metricAt(inst, minute) {
  const seed = h32(`${inst.id}:${minute}`)
  const base = WORKLOAD[inst.tags?.workload] ?? 15 + (inst.vcpu ?? 1) * 1.5
  const day = Math.sin((2 * Math.PI * (minute % 1440)) / 1440)
  const cpu = Math.max(1, Math.min(100, base + 14 * day + (rnd(seed) - 0.5) * 16))
  const mem = Math.max(5, Math.min(98, 30 + base * 0.45 + 5 * Math.sin(minute / 97) + (rnd(seed ^ 0x9e37) - 0.5) * 4))
  const load = cpu / 100
  return {
    cpu: +cpu.toFixed(1), memory: +mem.toFixed(1), netIn: Math.round(load * 4e6 * (0.6 + rnd(seed ^ 0x1234))), netOut: Math.round(load * 2.5e6 * (0.6 + rnd(seed ^ 0x4321))),
    diskRead: Math.round(load * 8e5 * rnd(seed ^ 0xabcd)), diskWrite: Math.round(load * 6e5 * rnd(seed ^ 0xdcba)),
  }
}
const runIntervals = (i) => i.runIntervals ?? (i.runningSince ? [[Date.parse(i.runningSince), null]] : [])

export function register(r, db, ctx) {
  const by = (col, field, value) => (typeof db.findBy === 'function' ? db.findBy(col, field, value) : db.find(col, (x) => x[field] === value))
  const ownRow = (col, user, id, what) => {
    const row = typeof id === 'string' ? db.get(col, id) : null
    if (!row || row.userId !== user.id) throw new HttpError(404, `${what} not found`)
    return row
  }
  const own = (col, id, user) => ownRow(col, user, id, 'Not')
  const audit = (userId, action, resource, meta) => { try { ctx.events.emit('audit', { userId, action, resource, meta }) } catch { /* ignore */ } }
  const mine = (userId) => by('instances', 'userId', userId)
  const live = (userId) => mine(userId).filter((i) => i.state !== 'terminated')
  const nameOk = (n, what = 'Name') => { if (typeof n !== 'string' || !NAME_RE.test(n)) throw new HttpError(400, `${what} must be 1-63 characters (letters, digits, space and _ . : / -)`); return n }
  const tagsOk = (t) => {
    if (t === undefined) return {}
    if (t === null || typeof t !== 'object' || Array.isArray(t)) throw new HttpError(400, 'tags must be an object of string values')
    const e = Object.entries(t)
    if (e.length > LIM.tags) throw new HttpError(400, `At most ${LIM.tags} tags`)
    for (const [k, v] of e) if (!TAG_KEY_RE.test(k) || typeof v !== 'string' || v.length > 128 || /^aws:|^rd:/i.test(k)) throw new HttpError(400, `Invalid tag "${k.slice(0, 40)}" (keys: letters, digits, _ . : / -, no rd: prefix; values: strings up to 128 characters)`)
    return Object.fromEntries(e)
  }

  /* ------------------------------------------------------------------ catalogue */
  r.get('/api/compute/regions', () => ({ regions: Object.entries(REGIONS).map(([id, v]) => ({ id, name: v.name, availabilityZones: v.azs })), simulated: true }))
  r.get('/api/compute/images', () => ({ images: IMAGES }))
  r.get('/api/compute/types', () => ({ types: Object.entries(INSTANCE_TYPES).map(([id, t]) => ({ id, ...t, pricePerHour: PRICES[`compute.${id}`].price })) }))

  /* ------------------------------------------------------------------ instance state machine */
  const view = (i) => ({
    id: i.id, name: i.name, type: i.type, vcpu: i.vcpu, memGb: i.memGb, region: i.region, az: i.az, image: i.image, state: i.state, ip: i.ip, privateIp: i.privateIp ?? null, publicIp: i.publicIp ?? null,
    subnetId: i.subnetId ?? null, vpcId: i.vpcId ?? null, securityGroupIds: i.securityGroupIds ?? [], tags: i.tags ?? {}, keyName: i.keyName ?? null, asgId: i.asgId ?? null, userData: i.userData ?? null,
    volumes: by('cmp_volumes', 'userId', i.userId).filter((v) => v.attachment?.instanceId === i.id).map((v) => ({ id: v.id, device: v.attachment.device, sizeGb: v.sizeGb })),
    createdAt: i.createdAt, runningSince: i.runningSince ?? null, accruedMs: i.accruedMs ?? 0, hoursRunning: +instanceHours(i).toFixed(4), simulated: true,
  })
  function note(inst, state, reason, consoleLines = []) {
    const events = [...(inst.events ?? []), { ts: Date.now(), state, reason }].slice(-LIM.events)
    const lines = [...(inst.consoleLog ?? []), ...consoleLines.map((l) => `[${iso()}] ${l}`)].slice(-LIM.consoleLines)
    return { events, consoleLog: lines }
  }
  const BOOT = (i) => [`rd-hypervisor: starting ${i.name} (${i.type}: ${i.vcpu} vCPU, ${i.memGb} GB)`, `kernel: RD Linux 6.x booting from image ${i.image}`, 'init: mounting filesystems', `net: eth0 up, address ${i.privateIp ?? i.ip}`, 'cloud-init: user data processed', 'systemd: reached target Multi-User System', 'rd-agent: instance is ready (simulated)']
  const timers = new Set()
  function after(ms, fn) {
    if (ms <= 0) return fn()
    const t = setTimeout(() => { timers.delete(t); try { fn() } catch (e) { console.error('[compute] transition failed:', e.message) } }, ms)
    t.unref?.(); timers.add(t)
  }
  function becomeRunning(id, reason = 'started') {
    const i = db.get('instances', id)
    if (!i || !['pending'].includes(i.state)) return
    let publicIp = i.publicIp ?? null
    if (!publicIp && i.subnetId && db.get('net_subnets', i.subnetId)?.public) { try { publicIp = ctx.net.newPublicIp() } catch { /* pool exhausted: no public IP */ } }
    const now = Date.now()
    db.update('instances', id, { state: 'running', runningSince: iso(now), publicIp, runIntervals: [...(i.runIntervals ?? []), [now, null]], ...note(i, 'running', reason, BOOT({ ...i })) })
  }
  function accrue(i) {
    const now = Date.now()
    const accruedMs = (i.accruedMs ?? 0) + (i.runningSince ? now - Date.parse(i.runningSince) : 0)
    const ivs = (i.runIntervals ?? []).map((iv, idx, arr) => (idx === arr.length - 1 && iv[1] === null ? [iv[0], now] : iv))
    return { accruedMs, runningSince: null, runIntervals: ivs }
  }
  function becomeStopped(id, reason = 'stopped') {
    const i = db.get('instances', id)
    if (!i || i.state !== 'stopping') return
    const eip = ctx.net.elasticIpOf(id)
    db.update('instances', id, { state: 'stopped', publicIp: eip ? eip.ip : null, ...note(i, 'stopped', reason, ['rd-agent: shutdown complete']) })
  }
  function cleanup(i) {
    if (i.subnetId && i.privateIp) ctx.net.releaseIp(i.subnetId, i.privateIp)
    ctx.net.releaseEipsOf(i.id)
    for (const v of by('cmp_volumes', 'userId', i.userId)) if (v.attachment?.instanceId === i.id) db.update('cmp_volumes', v.id, { state: 'available', attachment: null })
    for (const lb of by('cmp_lbs', 'userId', i.userId)) if (lb.targets.some((t) => t.instanceId === i.id)) db.update('cmp_lbs', lb.id, { targets: lb.targets.filter((t) => t.instanceId !== i.id) })
    for (const g of by('cmp_asgs', 'userId', i.userId)) if (g.members.includes(i.id)) db.update('cmp_asgs', g.id, { members: g.members.filter((m) => m !== i.id) })
  }
  function becomeTerminated(id, reason = 'terminated') {
    const i = db.get('instances', id)
    if (!i || i.state !== 'shutting-down') return
    db.update('instances', id, { state: 'terminated', publicIp: null, privateIp: i.privateIp, ...note(i, 'terminated', reason) })
    cleanup(i)
  }
  /** Settle transitional states left behind by a restart. Runs on the first request because ctx.net (network.js) registers after this module. */
  let recovered = false
  function recover() {
    for (const i of db.find('instances', (x) => ['pending', 'stopping', 'shutting-down'].includes(x.state))) { if (i.state === 'pending') becomeRunning(i.id, 'recovered'); else if (i.state === 'stopping') becomeStopped(i.id, 'recovered'); else becomeTerminated(i.id, 'recovered') }
  }
  ctx.hooks.beforeRoute.push(() => { if (!recovered) { recovered = true; try { recover() } catch (e) { console.error('[compute] recovery failed:', e.message) } } })

  function launch(user, spec, extra = {}) {
    const type = spec.type || 'small'
    if (!INSTANCE_TYPES[type]) throw new HttpError(400, `Unknown type. Use one of: ${Object.keys(INSTANCE_TYPES).join(', ')}`)
    nameOk(spec.name)
    const image = spec.image ?? 'rd-linux-2026'
    if (!IMAGE_IDS.has(image)) throw new HttpError(400, `Unknown image. Use one of: ${[...IMAGE_IDS].join(', ')}`)
    let region = spec.region || 'rd-east-1'
    if (!REGIONS[region]) throw new HttpError(400, `Unknown region. Use one of: ${Object.keys(REGIONS).join(', ')}`)
    if (live(user.id).length >= LIM.instances()) throw new HttpError(409, `At most ${LIM.instances()} instances per account`)
    ctx.quotas?.enforce?.(user.id, 'compute.instances', 1)
    const tags = tagsOk(spec.tags)
    let az = spec.az ?? REGIONS[region].azs[0], subnet = null, sgIds = [], privateIp = null
    if (spec.userData !== undefined && (typeof spec.userData !== 'string' || spec.userData.length > 16 * 1024)) throw new HttpError(400, 'userData must be a string of at most 16 KB')
    let keyName = null
    if (spec.keyPairId) { const kp = ownRow('cmp_keypairs', user, spec.keyPairId, 'Key pair'); keyName = kp.name }
    let vpcId = null
    if (spec.subnetId) {
      subnet = ctx.net.subnetFor(user, spec.subnetId)
      vpcId = subnet.vpcId
      const vpc = db.get('net_vpcs', vpcId)
      region = vpc.region; az = subnet.az
      sgIds = spec.securityGroupIds !== undefined ? ctx.net.validateSgs(user, vpcId, spec.securityGroupIds) : [vpc.defaultSgId]
    } else if (spec.securityGroupIds?.length) throw new HttpError(400, 'securityGroupIds require a subnetId')
    else if (!REGIONS[region].azs.includes(az)) throw new HttpError(400, `Availability zone must be one of: ${REGIONS[region].azs.join(', ')}`)
    const id = db.id('i')
    if (subnet) privateIp = ctx.net.allocateIp(subnet.id, id)
    const row = db.insert('instances', {
      id, userId: user.id, name: spec.name, type, ...INSTANCE_TYPES[type], region, az, image, tags, keyName, userData: spec.userData ?? null, subnetId: subnet?.id ?? null, vpcId, privateIp, publicIp: null, securityGroupIds: sgIds,
      state: 'pending', runningSince: null, accruedMs: 0, runIntervals: [], events: [], consoleLog: [],
      ip: privateIp ?? `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${1 + Math.floor(Math.random() * 253)}`, ...extra,
    })
    db.update('instances', id, note(row, 'pending', 'launch requested', ['rd-control-plane: instance launch requested']))
    after(LIM.simDelayMs(), () => becomeRunning(id, 'launched'))
    audit(user.id, 'compute.instance.launch', id, { type, region })
    return db.get('instances', id)
  }

  const transient = (i) => ['pending', 'stopping', 'shutting-down'].includes(i.state)
  r.get('/api/compute/instances', ({ user, query }) => {
    const tag = [...query.entries()].filter(([k]) => k.startsWith('tag.'))
    let list = mine(user.id).filter((i) => query.get('includeTerminated') === '1' || i.state !== 'terminated')
    if (query.get('state')) list = list.filter((i) => i.state === query.get('state'))
    if (query.get('name')) list = list.filter((i) => i.name.toLowerCase().includes(query.get('name').toLowerCase()))
    for (const [k, v] of tag) list = list.filter((i) => (i.tags ?? {})[k.slice(4)] === v)
    return { instances: list.map(view), simulated: true }
  })
  r.post('/api/compute/instances', ({ user, body }) => {
    required(body, 'name')
    return [201, view(launch(user, body))]
  })
  r.get('/api/compute/instances/:id', ({ user, params }) => ({ ...view(ownRow('instances', user, params.id, 'Instance')), events: (db.get('instances', params.id).events ?? []).slice(-20) }))
  r.patch('/api/compute/instances/:id', ({ user, params, body }) => {
    const i = ownRow('instances', user, params.id, 'Instance')
    if (i.state === 'terminated') throw new HttpError(409, 'The instance is terminated')
    const patch = {}
    if (body.name !== undefined) patch.name = nameOk(body.name)
    if (body.tags !== undefined) patch.tags = tagsOk(body.tags)
    return view(db.update('instances', i.id, patch))
  })

  function op(action, fromStates, run) {
    r.post(`/api/compute/instances/:id/${action}`, ({ user, params, body }) => {
      const i = ownRow('instances', user, params.id, 'Instance')
      if (!fromStates.includes(i.state)) throw new HttpError(409, `Cannot ${action} an instance that is ${i.state}`)
      run(i, user, body ?? {})
      return view(db.get('instances', i.id))
    })
  }
  op('start', ['stopped'], (i, user) => {
    ctx.quotas?.enforce?.(user.id, 'compute.instances', 0)
    db.update('instances', i.id, { state: 'pending', ...note(i, 'pending', 'start requested', ['rd-control-plane: start requested']) })
    after(LIM.simDelayMs(), () => becomeRunning(i.id, 'started'))
  })
  op('stop', ['running'], (i) => {
    db.update('instances', i.id, { state: 'stopping', ...accrue(i), ...note(i, 'stopping', 'stop requested', ['rd-control-plane: stop requested', 'systemd: stopping']) })
    after(LIM.simDelayMs(), () => becomeStopped(i.id, 'stopped'))
  })
  op('reboot', ['running'], (i) => { db.update('instances', i.id, note(i, 'running', 'reboot', ['rd-control-plane: reboot requested', ...BOOT(i)])) })
  op('terminate', ['pending', 'running', 'stopped'], (i) => {
    db.update('instances', i.id, { state: 'shutting-down', ...(i.state === 'running' ? accrue(i) : {}), ...note(i, 'shutting-down', 'terminate requested', ['rd-control-plane: terminate requested']) })
    audit(i.userId, 'compute.instance.terminate', i.id, null)
    after(LIM.simDelayMs(), () => becomeTerminated(i.id, 'terminated'))
  })
  op('resize', ['stopped'], (i, _user, body) => {
    const type = body.type
    if (!INSTANCE_TYPES[type]) throw new HttpError(400, `Unknown type. Use one of: ${Object.keys(INSTANCE_TYPES).join(', ')}`)
    db.update('instances', i.id, { type, ...INSTANCE_TYPES[type], ...note(i, 'stopped', `resized ${i.type} -> ${type}`) })
  })
  r.get('/api/compute/instances/:id/console', ({ user, params }) => ({ instanceId: params.id, lines: ownRow('instances', user, params.id, 'Instance').consoleLog ?? [], simulated: true }))

  r.get('/api/compute/instances/:id/metrics', ({ user, params, query }) => {
    const i = ownRow('instances', user, params.id, 'Instance')
    const windows = { '1h': 3600, '6h': 6 * 3600, '24h': 24 * 3600 }
    const win = windows[query.get('window') ?? '1h']
    if (!win) throw new HttpError(400, 'window must be 1h, 6h or 24h')
    const period = Number(query.get('period') ?? (win <= 3600 ? 60 : 300))
    if (![60, 300, 900].includes(period)) throw new HttpError(400, 'period must be 60, 300 or 900 seconds')
    const now = Date.now(), from = now - win * 1000
    const ivs = runIntervals(i)
    const series = []
    for (let t = Math.floor(from / (period * 1000)) * period * 1000; t <= now; t += period * 1000) {
      if (!ivs.some(([a, b]) => t + period * 1000 > a && t < (b ?? Infinity))) continue
      const m0 = Math.floor(t / 60_000)
      const n = period / 60
      const acc = { cpu: 0, memory: 0, netIn: 0, netOut: 0, diskRead: 0, diskWrite: 0 }
      for (let k = 0; k < n; k++) { const m = metricAt(i, m0 + k); for (const key of Object.keys(acc)) acc[key] += m[key] }
      series.push({ t: iso(t), cpu: +(acc.cpu / n).toFixed(1), memory: +(acc.memory / n).toFixed(1), netIn: acc.netIn, netOut: acc.netOut, diskRead: acc.diskRead, diskWrite: acc.diskWrite })
    }
    return { instanceId: i.id, window: query.get('window') ?? '1h', period, series, simulated: true, note: 'Synthetic, deterministic workload model — no real machine is measured.' }
  })

  /* ------------------------------------------------------------------ key pairs (real ed25519) */
  const kpView = (k) => ({ id: k.id, name: k.name, fingerprint: k.fingerprint, publicKey: k.publicKey, createdAt: k.createdAt })
  function opensshEd25519(rawPub, comment) {
    const type = Buffer.from('ssh-ed25519')
    const blob = Buffer.concat([Buffer.from([0, 0, 0, type.length]), type, Buffer.from([0, 0, 0, rawPub.length]), rawPub])
    return { text: `ssh-ed25519 ${blob.toString('base64')} ${comment}`, fingerprint: `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}` }
  }
  r.get('/api/compute/keypairs', ({ user }) => ({ keyPairs: by('cmp_keypairs', 'userId', user.id).map(kpView) }))
  r.post('/api/compute/keypairs', ({ user, body }) => {
    required(body, 'name')
    nameOk(body.name)
    const kps = by('cmp_keypairs', 'userId', user.id)
    if (kps.length >= LIM.keypairs) throw new HttpError(409, `At most ${LIM.keypairs} key pairs`)
    if (kps.some((k) => k.name === body.name)) throw new HttpError(409, 'A key pair with that name exists')
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
    const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
    const ssh = opensshEd25519(raw, body.name.replace(/\s+/g, '_'))
    const row = db.insert('cmp_keypairs', { userId: user.id, name: body.name, publicKey: ssh.text, fingerprint: ssh.fingerprint })
    // the private key is returned exactly once and never stored
    return [201, { ...kpView(row), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }]
  })
  r.delete('/api/compute/keypairs/:id', ({ user, params }) => { db.remove('cmp_keypairs', ownRow('cmp_keypairs', user, params.id, 'Key pair').id); return { ok: true } })

  /* ------------------------------------------------------------------ volumes + snapshots */
  const volView = (v) => ({ id: v.id, name: v.name ?? null, sizeGb: v.sizeGb, az: v.az, type: v.type, state: v.state, attachment: v.attachment ?? null, snapshotId: v.snapshotId ?? null, createdAt: v.createdAt })
  const volumes = (userId) => by('cmp_volumes', 'userId', userId).filter((v) => v.state !== 'deleted')
  r.get('/api/compute/volumes', ({ user }) => ({ volumes: volumes(user.id).map(volView) }))
  r.post('/api/compute/volumes', ({ user, body }) => {
    let size = body.sizeGb, az = body.az ?? 'rd-east-1a'
    let snap = null
    if (body.snapshotId) { snap = ownRow('cmp_snapshots', user, body.snapshotId, 'Snapshot'); size = size ?? snap.sizeGb; if (size < snap.sizeGb) throw new HttpError(400, `Size must be at least the snapshot size (${snap.sizeGb} GB)`) }
    if (!Number.isInteger(size) || size < 1 || size > 16384) throw new HttpError(400, 'sizeGb must be an integer between 1 and 16384')
    if (!Object.values(REGIONS).some((rg) => rg.azs.includes(az))) throw new HttpError(400, 'Unknown availability zone')
    const type = body.type ?? 'standard'
    if (!['standard', 'ssd'].includes(type)) throw new HttpError(400, 'type must be standard or ssd')
    const vols = volumes(user.id)
    if (vols.length >= LIM.volumes()) throw new HttpError(409, `At most ${LIM.volumes()} volumes`)
    if (vols.reduce((s, v) => s + v.sizeGb, 0) + size > LIM.totalVolumeGb()) throw new HttpError(409, `Total volume size is limited to ${LIM.totalVolumeGb()} GB`)
    if (body.name !== undefined) nameOk(body.name)
    return [201, volView(db.insert('cmp_volumes', { userId: user.id, name: body.name ?? null, sizeGb: size, az, type, state: 'available', attachment: null, snapshotId: snap?.id ?? null }))]
  })
  const volOf = (user, id) => { const v = ownRow('cmp_volumes', user, id, 'Volume'); if (v.state === 'deleted') throw new HttpError(404, 'Volume not found'); return v }
  r.get('/api/compute/volumes/:id', ({ user, params }) => volView(volOf(user, params.id)))
  r.post('/api/compute/volumes/:id/attach', ({ user, params, body }) => {
    const v = volOf(user, params.id)
    const i = ownRow('instances', user, body.instanceId, 'Instance')
    if (v.state !== 'available') throw new HttpError(409, 'The volume is already attached')
    if (!['running', 'stopped'].includes(i.state)) throw new HttpError(409, `Cannot attach to an instance that is ${i.state}`)
    if (v.az !== i.az) throw new HttpError(400, `The volume is in ${v.az} but the instance is in ${i.az}`)
    const device = body.device ?? `/dev/sd${'fghijklmnop'[volumes(user.id).filter((x) => x.attachment?.instanceId === i.id).length]}`
    if (!/^\/dev\/sd[f-p]$/.test(device)) throw new HttpError(400, 'device must be /dev/sdf .. /dev/sdp')
    const attached = volumes(user.id).filter((x) => x.attachment?.instanceId === i.id)
    if (attached.length >= LIM.attachmentsPerInstance) throw new HttpError(409, `At most ${LIM.attachmentsPerInstance} volumes per instance`)
    if (attached.some((x) => x.attachment.device === device)) throw new HttpError(409, `${device} is already in use`)
    return volView(db.update('cmp_volumes', v.id, { state: 'in-use', attachment: { instanceId: i.id, device } }))
  })
  r.post('/api/compute/volumes/:id/detach', ({ user, params }) => {
    const v = volOf(user, params.id)
    if (v.state !== 'in-use') throw new HttpError(409, 'The volume is not attached')
    const i = db.get('instances', v.attachment.instanceId)
    if (i?.state === 'running' && ctx.compute?.strictDetach) throw new HttpError(409, 'Stop the instance before detaching')
    return volView(db.update('cmp_volumes', v.id, { state: 'available', attachment: null }))
  })
  r.post('/api/compute/volumes/:id/resize', ({ user, params, body }) => {
    const v = volOf(user, params.id)
    if (!Number.isInteger(body.sizeGb) || body.sizeGb < 1 || body.sizeGb > 16384) throw new HttpError(400, 'sizeGb must be an integer between 1 and 16384')
    if (body.sizeGb <= v.sizeGb) throw new HttpError(400, 'Volumes can only grow')
    if (volumes(user.id).reduce((s, x) => s + x.sizeGb, 0) - v.sizeGb + body.sizeGb > LIM.totalVolumeGb()) throw new HttpError(409, `Total volume size is limited to ${LIM.totalVolumeGb()} GB`)
    return volView(db.update('cmp_volumes', v.id, { sizeGb: body.sizeGb }))
  })
  r.delete('/api/compute/volumes/:id', ({ user, params }) => {
    const v = volOf(user, params.id)
    if (v.state === 'in-use') throw new HttpError(409, 'Detach the volume first')
    db.update('cmp_volumes', v.id, { state: 'deleted' })
    return { ok: true }
  })
  const snapView = (s) => ({ id: s.id, volumeId: s.volumeId, sizeGb: s.sizeGb, state: s.state, description: s.description ?? '', createdAt: s.createdAt })
  r.get('/api/compute/snapshots', ({ user }) => ({ snapshots: by('cmp_snapshots', 'userId', user.id).map(snapView) }))
  r.post('/api/compute/volumes/:id/snapshots', ({ user, params, body }) => {
    const v = volOf(user, params.id)
    if (by('cmp_snapshots', 'userId', user.id).filter((s) => s.volumeId === v.id).length >= LIM.snapshotsPerVolume) throw new HttpError(409, `At most ${LIM.snapshotsPerVolume} snapshots per volume`)
    return [201, snapView(db.insert('cmp_snapshots', { userId: user.id, volumeId: v.id, sizeGb: v.sizeGb, state: 'completed', description: String(body.description ?? '').slice(0, 200) }))]
  })
  r.delete('/api/compute/snapshots/:id', ({ user, params }) => { db.remove('cmp_snapshots', ownRow('cmp_snapshots', user, params.id, 'Snapshot').id); return { ok: true } })

  /* ------------------------------------------------------------------ autoscaling groups */
  const recentCpu = (inst, now = Date.now()) => { const m = Math.floor(now / 60_000); return [0, 1, 2].reduce((s, k) => s + metricAt(inst, m - k).cpu, 0) / 3 }
  const asgView = (g) => ({
    id: g.id, name: g.name, minSize: g.minSize, maxSize: g.maxSize, desired: g.desired, targetCpu: g.targetCpu, cooldownSec: g.cooldownSec, template: g.template,
    members: g.members.map((id) => { const i = db.get('instances', id); return i ? { id, name: i.name, state: i.state } : { id, state: 'missing' } }), activity: g.activity.slice(-20).reverse(), lastScaleAt: g.lastScaleAt ?? null,
    averageCpu: (() => { const ms = g.members.map((id) => db.get('instances', id)).filter((i) => i?.state === 'running'); return ms.length ? +(ms.reduce((s, i) => s + recentCpu(i), 0) / ms.length).toFixed(1) : null })(),
  })
  const asgNote = (g, msg) => [...g.activity, { at: iso(), message: msg }].slice(-50)
  r.get('/api/compute/asgs', ({ user }) => ({ autoScalingGroups: by('cmp_asgs', 'userId', user.id).map(asgView) }))
  function asgBounds(b, cur = {}) {
    const min = b.minSize ?? cur.minSize ?? 0, max = b.maxSize ?? cur.maxSize ?? 1, desired = b.desired ?? cur.desired ?? Math.max(min, 1)
    for (const [k, v] of Object.entries({ minSize: min, maxSize: max, desired })) if (!Number.isInteger(v) || v < 0 || v > LIM.asgMax) throw new HttpError(400, `${k} must be an integer between 0 and ${LIM.asgMax}`)
    if (min > max) throw new HttpError(400, 'minSize must not exceed maxSize')
    if (desired < min || desired > max) throw new HttpError(400, 'desired must be between minSize and maxSize')
    return { minSize: min, maxSize: max, desired }
  }
  r.post('/api/compute/asgs', ({ user, body }) => {
    required(body, 'name', 'template')
    nameOk(body.name)
    if (by('cmp_asgs', 'userId', user.id).length >= LIM.asgs) throw new HttpError(409, `At most ${LIM.asgs} autoscaling groups`)
    const t = body.template
    if (t === null || typeof t !== 'object' || !INSTANCE_TYPES[t.type ?? 'small']) throw new HttpError(400, 'template needs a valid instance type')
    const template = { type: t.type ?? 'small', image: t.image ?? 'rd-linux-2026', region: t.region ?? 'rd-east-1', az: t.az, subnetIds: t.subnetIds ?? (t.subnetId ? [t.subnetId] : []), securityGroupIds: t.securityGroupIds, keyPairId: t.keyPairId, tags: tagsOk(t.tags), userData: t.userData }
    if (!IMAGE_IDS.has(template.image)) throw new HttpError(400, 'Unknown image')
    if (!Array.isArray(template.subnetIds) || template.subnetIds.length > 6) throw new HttpError(400, 'subnetIds must be an array of at most 6 ids')
    for (const sid of template.subnetIds) ctx.net.subnetFor(user, sid)
    const bounds = asgBounds(body)
    const targetCpu = body.targetCpu ?? 50
    if (!(targetCpu >= 10 && targetCpu <= 90)) throw new HttpError(400, 'targetCpu must be between 10 and 90')
    const g = db.insert('cmp_asgs', { userId: user.id, name: body.name, ...bounds, targetCpu, cooldownSec: body.cooldownSec ?? 60, template, members: [], activity: [], lastScaleAt: null })
    reconcile(g.id, Date.now())
    audit(user.id, 'compute.asg.create', g.id, { name: g.name })
    return [201, asgView(db.get('cmp_asgs', g.id))]
  })
  const asgOf = (user, id) => ownRow('cmp_asgs', user, id, 'Autoscaling group')
  r.get('/api/compute/asgs/:id', ({ user, params }) => asgView(asgOf(user, params.id)))
  r.patch('/api/compute/asgs/:id', ({ user, params, body }) => {
    const g = asgOf(user, params.id)
    const patch = asgBounds(body, g)
    if (body.targetCpu !== undefined) { if (!(body.targetCpu >= 10 && body.targetCpu <= 90)) throw new HttpError(400, 'targetCpu must be between 10 and 90'); patch.targetCpu = body.targetCpu }
    db.update('cmp_asgs', g.id, patch)
    reconcile(g.id, Date.now())
    return asgView(db.get('cmp_asgs', g.id))
  })
  r.delete('/api/compute/asgs/:id', ({ user, params }) => {
    const g = asgOf(user, params.id)
    for (const id of g.members) { const i = db.get('instances', id); if (i && i.state !== 'terminated' && i.state !== 'shutting-down') { db.update('instances', id, { state: 'shutting-down', ...(i.state === 'running' ? accrue(i) : {}), ...note(i, 'shutting-down', 'autoscaling group deleted') }); after(LIM.simDelayMs(), () => becomeTerminated(id, 'asg deleted')) } }
    db.remove('cmp_asgs', g.id)
    return { ok: true }
  })
  /** Make the group's membership match `desired` and replace unhealthy members. */
  function reconcile(asgId, now) {
    let g = db.get('cmp_asgs', asgId)
    if (!g) return
    const user = { id: g.userId }
    // health: members that disappeared or were stopped/terminated are replaced
    const healthy = [], notes = []
    for (const id of g.members) {
      const i = db.get('instances', id)
      if (i && ['pending', 'running'].includes(i.state)) healthy.push(id)
      else { notes.push(`replacing unhealthy instance ${id} (${i?.state ?? 'missing'})`); if (i && ['stopped', 'stopping'].includes(i.state)) { db.update('instances', id, { state: 'shutting-down', ...note(i, 'shutting-down', 'unhealthy: replaced by autoscaling') }); after(LIM.simDelayMs(), () => becomeTerminated(id, 'replaced')) } }
    }
    let members = healthy
    let activity = g.activity
    for (const n of notes) activity = [...activity, { at: iso(), message: n }]
    while (members.length < g.desired) {
      try {
        const tpl = g.template
        const idx = members.length + g.members.length
        const subnetId = tpl.subnetIds?.length ? tpl.subnetIds[idx % tpl.subnetIds.length] : undefined
        const inst = launch(user, { name: `${g.name}-${crypto.randomBytes(2).toString('hex')}`, type: tpl.type, image: tpl.image, region: tpl.region, az: tpl.az, subnetId, securityGroupIds: subnetId ? tpl.securityGroupIds : undefined, keyPairId: tpl.keyPairId, tags: tpl.tags, userData: tpl.userData }, { asgId: g.id, tags: { ...tpl.tags, 'rd:asg': g.name } }) // reserved tags are set by the platform, never by users
        members = [...members, inst.id]; activity = [...activity, { at: iso(), message: `launched ${inst.id}` }]
      } catch (e) { activity = [...activity, { at: iso(), message: `launch failed: ${e.message}` }]; break }
    }
    while (members.length > g.desired) {
      const victim = members.at(0)
      const i = db.get('instances', victim)
      if (i) { db.update('instances', victim, { state: 'shutting-down', ...(i.state === 'running' ? accrue(i) : {}), ...note(i, 'shutting-down', 'scale in') }); after(LIM.simDelayMs(), () => becomeTerminated(victim, 'scale in')) }
      members = members.slice(1); activity = [...activity, { at: iso(), message: `terminated ${victim} (scale in)` }]
    }
    db.update('cmp_asgs', g.id, { members, activity: activity.slice(-50) })
  }
  /** Target tracking on the simulated CPU: scale out above target+10, scale in below target-20, one step per cooldown. */
  function asgTick(now = Date.now()) {
    let changed = 0
    for (const g of db.find('cmp_asgs', () => true)) {
      reconcile(g.id, now)
      const fresh = db.get('cmp_asgs', g.id)
      const running = fresh.members.map((id) => db.get('instances', id)).filter((i) => i?.state === 'running')
      if (!running.length || (fresh.lastScaleAt && now - fresh.lastScaleAt < fresh.cooldownSec * 1000)) continue
      const avg = running.reduce((s, i) => s + recentCpu(i, now), 0) / running.length
      let desired = fresh.desired
      if (avg > fresh.targetCpu + 10 && desired < fresh.maxSize) desired++
      else if (avg < fresh.targetCpu - 20 && desired > fresh.minSize) desired--
      if (desired !== fresh.desired) {
        db.update('cmp_asgs', g.id, { desired, lastScaleAt: now, activity: asgNote(fresh, `scaling ${fresh.desired} -> ${desired} (average CPU ${avg.toFixed(1)}%, target ${fresh.targetCpu}%)`) })
        reconcile(g.id, now); changed++
      }
    }
    return changed
  }

  /* ------------------------------------------------------------------ load balancers */
  const lbHealth = (lb, t, now = Date.now()) => {
    const i = db.get('instances', t.instanceId)
    if (!i || i.state === 'terminated') return { state: 'unavailable', reason: 'Instance is terminated' }
    if (i.state !== 'running') return { state: 'unhealthy', reason: `Instance is ${i.state}` }
    const need = lb.targetGroup.healthCheck.intervalSec * lb.targetGroup.healthCheck.healthyThreshold * 1000
    return now - Date.parse(i.runningSince) < need ? { state: 'initial', reason: 'Health checks in progress' } : { state: 'healthy', reason: null }
  }
  const lbView = (lb) => ({ id: lb.id, name: lb.name, region: lb.region, dnsName: lb.dnsName, state: 'active', listeners: lb.listeners, targetGroup: lb.targetGroup, targets: lb.targets.map((t) => ({ ...t, health: lbHealth(lb, t) })), createdAt: lb.createdAt })
  r.get('/api/compute/load-balancers', ({ user }) => ({ loadBalancers: by('cmp_lbs', 'userId', user.id).map(lbView) }))
  r.post('/api/compute/load-balancers', ({ user, body }) => {
    required(body, 'name')
    nameOk(body.name)
    if (by('cmp_lbs', 'userId', user.id).length >= LIM.lbs) throw new HttpError(409, `At most ${LIM.lbs} load balancers`)
    const listeners = body.listeners ?? [{ port: 80, protocol: 'http' }]
    if (!Array.isArray(listeners) || !listeners.length || listeners.length > 5 || listeners.some((l) => !Number.isInteger(l?.port) || l.port < 1 || l.port > 65535 || !['http', 'https', 'tcp'].includes(l.protocol))) throw new HttpError(400, 'listeners must be 1-5 entries {port 1-65535, protocol http|https|tcp}')
    const tg = body.targetGroup ?? {}
    const hc = tg.healthCheck ?? {}
    const port = tg.port ?? 80
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'targetGroup.port must be 1-65535')
    const intervalSec = hc.intervalSec ?? 10, healthyThreshold = hc.healthyThreshold ?? 3
    if (!Number.isInteger(intervalSec) || intervalSec < 5 || intervalSec > 300 || !Number.isInteger(healthyThreshold) || healthyThreshold < 2 || healthyThreshold > 10) throw new HttpError(400, 'healthCheck.intervalSec must be 5-300 and healthyThreshold 2-10')
    const path = hc.path ?? '/'
    if (typeof path !== 'string' || !/^\/[\w\-./~%]{0,200}$/.test(path)) throw new HttpError(400, 'healthCheck.path must be an absolute path')
    const id = db.id('lb')
    const lb = db.insert('cmp_lbs', { id, userId: user.id, name: body.name, region: body.region ?? 'rd-east-1', dnsName: `${body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${id.slice(-6)}.lb.rd.local`, listeners, targetGroup: { port, protocol: tg.protocol ?? 'http', healthCheck: { path, intervalSec, healthyThreshold } }, targets: [] })
    return [201, lbView(lb)]
  })
  const lbOf = (user, id) => ownRow('cmp_lbs', user, id, 'Load balancer')
  r.get('/api/compute/load-balancers/:id', ({ user, params }) => lbView(lbOf(user, params.id)))
  r.post('/api/compute/load-balancers/:id/targets', ({ user, params, body }) => {
    const lb = lbOf(user, params.id)
    const i = ownRow('instances', user, body.instanceId, 'Instance')
    if (i.state === 'terminated' || i.state === 'shutting-down') throw new HttpError(409, `The instance is ${i.state}`)
    if (lb.targets.some((t) => t.instanceId === i.id)) throw new HttpError(409, 'The instance is already registered')
    if (lb.targets.length >= LIM.lbTargets) throw new HttpError(409, `At most ${LIM.lbTargets} targets`)
    return lbView(db.update('cmp_lbs', lb.id, { targets: [...lb.targets, { instanceId: i.id, port: lb.targetGroup.port }] }))
  })
  r.delete('/api/compute/load-balancers/:id/targets/:instanceId', ({ user, params }) => {
    const lb = lbOf(user, params.id)
    if (!lb.targets.some((t) => t.instanceId === params.instanceId)) throw new HttpError(404, 'Target not found')
    return lbView(db.update('cmp_lbs', lb.id, { targets: lb.targets.filter((t) => t.instanceId !== params.instanceId) }))
  })
  r.delete('/api/compute/load-balancers/:id', ({ user, params }) => { db.remove('cmp_lbs', lbOf(user, params.id).id); return { ok: true } })

  /* ------------------------------------------------------------------ cost estimator */
  r.post('/api/compute/estimate', ({ body }) => {
    const items = body.instances ?? []
    if (!Array.isArray(items) || items.length > 50) throw new HttpError(400, 'instances must be an array of at most 50 entries')
    const lines = []
    for (const it of items) {
      if (!INSTANCE_TYPES[it?.type]) throw new HttpError(400, 'Unknown instance type')
      const count = it.count ?? 1, hours = it.hoursPerMonth ?? 730
      if (!Number.isInteger(count) || count < 1 || count > 1000 || !(hours >= 0 && hours <= 744)) throw new HttpError(400, 'count must be 1-1000 and hoursPerMonth 0-744')
      lines.push({ description: `${count} × ${it.type} for ${hours} h`, monthly: +(priceOf(`compute.${it.type}`, count * hours)).toFixed(4) })
    }
    for (const v of body.volumes ?? []) { if (!Number.isInteger(v?.sizeGb) || v.sizeGb < 1) throw new HttpError(400, 'volume sizeGb must be a positive integer'); lines.push({ description: `${v.sizeGb} GB volume`, monthly: +priceOf('compute.volume_gb_month', v.sizeGb).toFixed(4) }) }
    if (body.elasticIps) lines.push({ description: `${body.elasticIps} elastic IP(s)`, monthly: +priceOf('network.eip_hour', body.elasticIps * 730).toFixed(4) })
    return { lines, monthlyTotal: +lines.reduce((s, l) => s + l.monthly, 0).toFixed(4), currency: 'USD', simulated: true }
  })

  /* ------------------------------------------------------------------ housekeeping */
  const timer = setInterval(() => { try { asgTick() } catch (e) { console.error('[compute] asg tick failed:', e.message) } }, 15_000)
  timer.unref?.()
  ctx.compute = { asgTick, metricAt, settleAll() { for (const i of db.find('instances', (x) => transient(x))) { if (i.state === 'pending') becomeRunning(i.id); else if (i.state === 'stopping') becomeStopped(i.id); else becomeTerminated(i.id) } } }
  ctx.events.on('shutdown', () => { clearInterval(timer); for (const t of timers) clearTimeout(t) })
  ctx.events.on('account.deleted', ({ userId }) => { for (const col of ['instances', 'cmp_keypairs', 'cmp_volumes', 'cmp_snapshots', 'cmp_asgs', 'cmp_lbs']) db.removeWhere(col, (x) => x.userId === userId) })
  void own
}
