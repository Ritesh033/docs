// Virtual networking control plane (SIMULATED: no packets flow, but the bookkeeping is real): VPCs with real IPv4 CIDR maths,
// subnets with IP allocation, route tables, internet gateways, elastic IPs, security groups and a rule evaluator.
// Exposes ctx.net for the compute module. See docs/compute.md.
import crypto from 'node:crypto'
import { HttpError, required } from '../http.js'

const envInt = (name, dflt, min, max) => { const n = Number(process.env[name]); return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : dflt }
const LIM = { vpcs: () => envInt('RD_NET_MAX_VPCS', 5, 1, 100), subnetsPerVpc: 20, sgs: 50, rulesPerSg: 60, routesPerTable: 50, routeTables: 20, eips: () => envInt('RD_NET_MAX_EIPS', 5, 1, 100), igws: 5 }

export const REGIONS = {
  'rd-east-1': { name: 'RD East', azs: ['rd-east-1a', 'rd-east-1b', 'rd-east-1c'] },
  'rd-west-1': { name: 'RD West', azs: ['rd-west-1a', 'rd-west-1b'] },
  'rd-eu-1': { name: 'RD Europe', azs: ['rd-eu-1a', 'rd-eu-1b'] },
}

/* ------------------------------------------------------------------ IPv4 / CIDR maths */
export function ipToInt(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s))
  if (!m) return null
  const o = m.slice(1).map(Number)
  if (o.some((x, i) => x > 255 || (m[i + 1].length > 1 && m[i + 1].startsWith('0')))) return null
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0
}
export const intToIp = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
/** Parse "a.b.c.d/p" (host bits must be zero). Returns { base, prefix, size, last }. */
export function parseCidr(s) {
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(String(s))
  if (!m) throw new HttpError(400, `Invalid CIDR "${String(s).slice(0, 40)}": use the form 10.0.0.0/16`)
  const ip = ipToInt(m[1]), prefix = Number(m[2])
  if (ip === null || prefix > 32) throw new HttpError(400, `Invalid CIDR "${String(s).slice(0, 40)}"`)
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  if ((ip & mask) >>> 0 !== ip) throw new HttpError(400, `CIDR ${s} has host bits set (did you mean ${intToIp((ip & mask) >>> 0)}/${prefix}?)`)
  const size = 2 ** (32 - prefix)
  return { base: ip, prefix, size, last: ip + size - 1 }
}
export const cidrOverlap = (a, b) => a.base <= b.last && b.base <= a.last
export const cidrContainsCidr = (outer, inner) => inner.base >= outer.base && inner.last <= outer.last
export const cidrContainsIp = (c, ipInt) => ipInt >= c.base && ipInt <= c.last
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].map(parseCidr)

export function register(r, db, ctx) {
  const by = (col, field, value) => (typeof db.findBy === 'function' ? db.findBy(col, field, value) : db.find(col, (x) => x[field] === value))
  const ownRow = (col, user, id, what) => {
    const row = typeof id === 'string' ? db.get(col, id) : null
    if (!row || row.userId !== user.id) throw new HttpError(404, `${what} not found`)
    return row
  }
  const nameOk = (n, what = 'Name') => { if (typeof n !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _.:/-]{0,62}$/.test(n)) throw new HttpError(400, `${what} must be 1-63 characters (letters, digits, space and _ . : / -)`); return n }
  const audit = (userId, action, resource, meta) => { try { ctx.events.emit('audit', { userId, action, resource, meta }) } catch { /* ignore */ } }

  /* ------------------------------------------------------------------ rules */
  const PROTOS = new Set(['tcp', 'udp', 'icmp', '-1'])
  function parseRule(body, direction) {
    const protocol = String(body.protocol ?? 'tcp').toLowerCase()
    if (!PROTOS.has(protocol)) throw new HttpError(400, 'protocol must be tcp, udp, icmp or -1 (all)')
    let fromPort = null, toPort = null
    if (protocol === 'tcp' || protocol === 'udp') {
      fromPort = body.fromPort; toPort = body.toPort ?? body.fromPort
      for (const p of [fromPort, toPort]) if (!Number.isInteger(p) || p < 0 || p > 65535) throw new HttpError(400, 'Ports must be integers between 0 and 65535')
      if (fromPort > toPort) throw new HttpError(400, 'fromPort must not exceed toPort')
    }
    const peer = {}
    if (body.cidr !== undefined) { parseCidr(body.cidr); peer.cidr = body.cidr }
    else if (body.sgId !== undefined) { if (typeof body.sgId !== 'string') throw new HttpError(400, 'sgId must be a string'); peer.sgId = body.sgId }
    else throw new HttpError(400, direction === 'ingress' ? 'Provide a source: cidr or sgId' : 'Provide a destination: cidr or sgId')
    if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 140)) throw new HttpError(400, 'description must be at most 140 characters')
    return { id: `sgr_${crypto.randomBytes(5).toString('hex')}`, protocol, fromPort, toPort, ...peer, description: body.description ?? '' }
  }
  const ruleMatches = (rule, protocol, port) => {
    if (rule.protocol === '-1') return true
    if (rule.protocol !== protocol) return false
    if (protocol === 'icmp') return true
    return port >= rule.fromPort && port <= rule.toPort
  }

  /* ------------------------------------------------------------------ VPCs */
  const vpcView = (v) => ({ id: v.id, name: v.name, cidr: v.cidr, region: v.region, defaultSecurityGroupId: v.defaultSgId, internetGatewayId: v.igwId ?? null, mainRouteTableId: v.mainRtId, createdAt: v.createdAt })
  function createRouteTable(user, vpc, name, main = false) {
    return db.insert('net_routetables', { userId: user.id, vpcId: vpc.id, name, main, routes: [{ destination: vpc.cidr, target: 'local' }], associations: [] })
  }
  r.get('/api/network/vpcs', ({ user }) => ({ vpcs: by('net_vpcs', 'userId', user.id).map(vpcView) }))
  r.post('/api/network/vpcs', ({ user, body }) => {
    required(body, 'name', 'cidr')
    nameOk(body.name)
    const c = parseCidr(body.cidr)
    if (!PRIVATE.some((p) => cidrContainsCidr(p, c))) throw new HttpError(400, 'VPC CIDRs must be inside 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16')
    if (c.prefix < 16 || c.prefix > 28) throw new HttpError(400, 'VPC CIDR prefix must be between /16 and /28')
    const region = body.region ?? 'rd-east-1'
    if (!REGIONS[region]) throw new HttpError(400, `Unknown region. Use one of: ${Object.keys(REGIONS).join(', ')}`)
    if (by('net_vpcs', 'userId', user.id).length >= LIM.vpcs()) throw new HttpError(409, `At most ${LIM.vpcs()} VPCs`)
    const vpc = db.insert('net_vpcs', { userId: user.id, name: body.name, cidr: body.cidr, region })
    const rt = createRouteTable(user, vpc, 'main', true)
    const sg = db.insert('net_sgs', {
      userId: user.id, vpcId: vpc.id, name: 'default', description: 'default VPC security group', isDefault: true,
      ingress: [{ id: `sgr_${crypto.randomBytes(5).toString('hex')}`, protocol: '-1', fromPort: null, toPort: null, sgId: 'self', description: 'allow members of this group' }],
      egress: [{ id: `sgr_${crypto.randomBytes(5).toString('hex')}`, protocol: '-1', fromPort: null, toPort: null, cidr: '0.0.0.0/0', description: 'allow all outbound' }],
    })
    db.update('net_sgs', sg.id, { ingress: sg.ingress.map((x) => (x.sgId === 'self' ? { ...x, sgId: sg.id } : x)) })
    audit(user.id, 'network.vpc.create', vpc.id, { cidr: vpc.cidr })
    return [201, vpcView(db.update('net_vpcs', vpc.id, { defaultSgId: sg.id, mainRtId: rt.id }))]
  })
  const vpcOf = (user, id) => ownRow('net_vpcs', user, id, 'VPC')
  r.get('/api/network/vpcs/:id', ({ user, params }) => {
    const v = vpcOf(user, params.id)
    return { ...vpcView(v), subnets: by('net_subnets', 'vpcId', v.id).map(subnetView), securityGroups: by('net_sgs', 'vpcId', v.id).map(sgView), routeTables: by('net_routetables', 'vpcId', v.id).map(rtView) }
  })
  r.delete('/api/network/vpcs/:id', ({ user, params }) => {
    const v = vpcOf(user, params.id)
    if (by('net_subnets', 'vpcId', v.id).length) throw new HttpError(409, 'Delete the VPC\'s subnets first')
    if (v.igwId) throw new HttpError(409, 'Detach the internet gateway first')
    if (db.find('instances', (i) => i.vpcId === v.id && i.state !== 'terminated').length) throw new HttpError(409, 'The VPC still has instances')
    if (by('net_sgs', 'vpcId', v.id).some((s) => !s.isDefault)) throw new HttpError(409, 'Delete the VPC\'s custom security groups first')
    db.removeWhere('net_sgs', (s) => s.vpcId === v.id)
    db.removeWhere('net_routetables', (t) => t.vpcId === v.id)
    db.remove('net_vpcs', v.id)
    return { ok: true }
  })

  /* ------------------------------------------------------------------ subnets (+ IP allocation) */
  const subnetView = (s) => {
    const c = parseCidr(s.cidr)
    return { id: s.id, vpcId: s.vpcId, name: s.name, cidr: s.cidr, az: s.az, public: !!s.public, routeTableId: s.routeTableId ?? null, availableIps: Math.max(0, c.size - 5 - Object.keys(s.allocated ?? {}).length), allocated: Object.keys(s.allocated ?? {}).length }
  }
  r.get('/api/network/subnets', ({ user, query }) => ({ subnets: by('net_subnets', 'userId', user.id).filter((s) => !query.get('vpcId') || s.vpcId === query.get('vpcId')).map(subnetView) }))
  r.post('/api/network/vpcs/:id/subnets', ({ user, params, body }) => {
    const v = vpcOf(user, params.id)
    required(body, 'cidr', 'az')
    nameOk(body.name ?? 'subnet')
    const c = parseCidr(body.cidr), vc = parseCidr(v.cidr)
    if (!cidrContainsCidr(vc, c)) throw new HttpError(400, `Subnet ${body.cidr} is not inside the VPC CIDR ${v.cidr}`)
    if (c.prefix > 28) throw new HttpError(400, 'Subnets can be at most /28')
    if (c.prefix <= vc.prefix && c.size === vc.size && false) throw new HttpError(400, 'Subnet is as large as the VPC')
    if (!REGIONS[v.region].azs.includes(body.az)) throw new HttpError(400, `Availability zone must be one of: ${REGIONS[v.region].azs.join(', ')}`)
    const subs = by('net_subnets', 'vpcId', v.id)
    if (subs.length >= LIM.subnetsPerVpc) throw new HttpError(409, `At most ${LIM.subnetsPerVpc} subnets per VPC`)
    const clash = subs.find((s) => cidrOverlap(parseCidr(s.cidr), c))
    if (clash) throw new HttpError(409, `Subnet ${body.cidr} overlaps ${clash.name} (${clash.cidr})`)
    const s = db.insert('net_subnets', { userId: user.id, vpcId: v.id, name: body.name ?? 'subnet', cidr: body.cidr, az: body.az, public: body.public === true, allocated: {}, routeTableId: v.mainRtId })
    const rt = db.get('net_routetables', v.mainRtId)
    db.update('net_routetables', rt.id, { associations: [...rt.associations, s.id] })
    return [201, subnetView(s)]
  })
  r.delete('/api/network/subnets/:id', ({ user, params }) => {
    const s = ownRow('net_subnets', user, params.id, 'Subnet')
    if (Object.keys(s.allocated ?? {}).length) throw new HttpError(409, 'The subnet still has instances')
    for (const t of by('net_routetables', 'vpcId', s.vpcId)) if (t.associations.includes(s.id)) db.update('net_routetables', t.id, { associations: t.associations.filter((x) => x !== s.id) })
    db.remove('net_subnets', s.id)
    return { ok: true }
  })
  /** Allocate the lowest free address (first 4 and the last address are reserved, as in AWS). */
  function allocateIp(subnetId, owner) {
    const s = db.get('net_subnets', subnetId)
    if (!s) throw new HttpError(404, 'Subnet not found')
    const c = parseCidr(s.cidr)
    const taken = s.allocated ?? {}
    for (let n = c.base + 4; n < c.last; n++) {
      const ip = intToIp(n)
      if (!taken[ip]) { db.update('net_subnets', s.id, { allocated: { ...taken, [ip]: owner } }); return ip }
    }
    throw new HttpError(409, 'The subnet has no free IP addresses')
  }
  function releaseIp(subnetId, ip) {
    const s = db.get('net_subnets', subnetId)
    if (!s || !s.allocated?.[ip]) return
    const { [ip]: _x, ...rest } = s.allocated
    db.update('net_subnets', s.id, { allocated: rest })
  }

  /* ------------------------------------------------------------------ route tables / internet gateways */
  const rtView = (t) => ({ id: t.id, vpcId: t.vpcId, name: t.name, main: !!t.main, routes: t.routes, associations: t.associations })
  r.get('/api/network/route-tables', ({ user, query }) => ({ routeTables: by('net_routetables', 'userId', user.id).filter((t) => !query.get('vpcId') || t.vpcId === query.get('vpcId')).map(rtView) }))
  r.post('/api/network/route-tables', ({ user, body }) => {
    required(body, 'vpcId')
    const v = vpcOf(user, body.vpcId)
    if (by('net_routetables', 'vpcId', v.id).length >= LIM.routeTables) throw new HttpError(409, `At most ${LIM.routeTables} route tables per VPC`)
    return [201, rtView(createRouteTable(user, v, nameOk(body.name ?? 'custom')))]
  })
  r.post('/api/network/route-tables/:id/routes', ({ user, params, body }) => {
    const t = ownRow('net_routetables', user, params.id, 'Route table')
    required(body, 'destination', 'target')
    const dest = parseCidr(body.destination)
    const target = String(body.target)
    if (target !== 'blackhole') {
      const g = db.get('net_igws', target)
      if (!g || g.userId !== user.id || g.vpcId !== t.vpcId) throw new HttpError(400, 'target must be "blackhole" or the id of an internet gateway attached to this VPC')
    }
    if (t.routes.some((x) => x.destination === body.destination)) throw new HttpError(409, 'A route for that destination already exists')
    if (t.routes.length >= LIM.routesPerTable) throw new HttpError(409, `At most ${LIM.routesPerTable} routes per table`)
    if (dest.size === 0) throw new HttpError(400, 'Invalid destination')
    return rtView(db.update('net_routetables', t.id, { routes: [...t.routes, { destination: body.destination, target }] }))
  })
  r.delete('/api/network/route-tables/:id/routes', ({ user, params, query }) => {
    const t = ownRow('net_routetables', user, params.id, 'Route table')
    const dest = query.get('destination')
    const route = t.routes.find((x) => x.destination === dest)
    if (!route) throw new HttpError(404, 'Route not found')
    if (route.target === 'local') throw new HttpError(400, 'The local route cannot be deleted')
    return rtView(db.update('net_routetables', t.id, { routes: t.routes.filter((x) => x.destination !== dest) }))
  })
  r.post('/api/network/route-tables/:id/associate', ({ user, params, body }) => {
    const t = ownRow('net_routetables', user, params.id, 'Route table')
    const s = ownRow('net_subnets', user, body.subnetId, 'Subnet')
    if (s.vpcId !== t.vpcId) throw new HttpError(400, 'The subnet belongs to another VPC')
    for (const x of by('net_routetables', 'vpcId', t.vpcId)) if (x.associations.includes(s.id)) db.update('net_routetables', x.id, { associations: x.associations.filter((a) => a !== s.id) })
    db.update('net_subnets', s.id, { routeTableId: t.id })
    return rtView(db.update('net_routetables', t.id, { associations: [...db.get('net_routetables', t.id).associations, s.id] }))
  })
  r.delete('/api/network/route-tables/:id', ({ user, params }) => {
    const t = ownRow('net_routetables', user, params.id, 'Route table')
    if (t.main) throw new HttpError(400, 'The main route table cannot be deleted')
    if (t.associations.length) throw new HttpError(409, 'The route table still has subnet associations')
    db.remove('net_routetables', t.id)
    return { ok: true }
  })

  const igwView = (g) => ({ id: g.id, name: g.name, vpcId: g.vpcId ?? null })
  r.get('/api/network/igws', ({ user }) => ({ internetGateways: by('net_igws', 'userId', user.id).map(igwView) }))
  r.post('/api/network/igws', ({ user, body }) => {
    if (by('net_igws', 'userId', user.id).length >= LIM.igws) throw new HttpError(409, `At most ${LIM.igws} internet gateways`)
    return [201, igwView(db.insert('net_igws', { userId: user.id, name: nameOk(body.name ?? 'igw'), vpcId: null }))]
  })
  r.post('/api/network/igws/:id/attach', ({ user, params, body }) => {
    const g = ownRow('net_igws', user, params.id, 'Internet gateway')
    const v = vpcOf(user, body.vpcId)
    if (g.vpcId) throw new HttpError(409, 'The gateway is already attached')
    if (v.igwId) throw new HttpError(409, 'The VPC already has an internet gateway')
    db.update('net_vpcs', v.id, { igwId: g.id })
    return igwView(db.update('net_igws', g.id, { vpcId: v.id }))
  })
  r.post('/api/network/igws/:id/detach', ({ user, params }) => {
    const g = ownRow('net_igws', user, params.id, 'Internet gateway')
    if (!g.vpcId) throw new HttpError(409, 'The gateway is not attached')
    if (db.find('net_eips', (e) => e.userId === user.id && e.instanceId && db.get('instances', e.instanceId)?.vpcId === g.vpcId).length) throw new HttpError(409, 'Elastic IPs are still in use in the VPC')
    for (const t of by('net_routetables', 'vpcId', g.vpcId)) if (t.routes.some((x) => x.target === g.id)) db.update('net_routetables', t.id, { routes: t.routes.map((x) => (x.target === g.id ? { ...x, target: 'blackhole' } : x)) })
    db.update('net_vpcs', g.vpcId, { igwId: null })
    return igwView(db.update('net_igws', g.id, { vpcId: null }))
  })
  r.delete('/api/network/igws/:id', ({ user, params }) => {
    const g = ownRow('net_igws', user, params.id, 'Internet gateway')
    if (g.vpcId) throw new HttpError(409, 'Detach the gateway first')
    db.remove('net_igws', g.id)
    return { ok: true }
  })

  /* ------------------------------------------------------------------ elastic / public IPs (documentation ranges) */
  const PUBLIC_POOL = ['198.51.100', '203.0.113']
  function newPublicIp() {
    const used = new Set([...db.find('net_eips', () => true).map((e) => e.ip), ...db.find('instances', (i) => i.publicIp).map((i) => i.publicIp)])
    for (let n = 0; n < 500; n++) { const ip = `${PUBLIC_POOL[crypto.randomInt(PUBLIC_POOL.length)]}.${crypto.randomInt(1, 255)}`; if (!used.has(ip)) return ip }
    throw new HttpError(409, 'No public IP addresses are available')
  }
  const eipView = (e) => ({ id: e.id, ip: e.ip, instanceId: e.instanceId ?? null, allocatedAt: e.createdAt })
  r.get('/api/network/eips', ({ user }) => ({ elasticIps: by('net_eips', 'userId', user.id).map(eipView) }))
  r.post('/api/network/eips', ({ user }) => {
    if (by('net_eips', 'userId', user.id).length >= LIM.eips()) throw new HttpError(409, `At most ${LIM.eips()} elastic IPs`)
    return [201, eipView(db.insert('net_eips', { userId: user.id, ip: newPublicIp(), instanceId: null, billedUntil: Date.now() }))]
  })
  r.post('/api/network/eips/:id/associate', ({ user, params, body }) => {
    const e = ownRow('net_eips', user, params.id, 'Elastic IP')
    const inst = db.get('instances', body.instanceId)
    if (!inst || inst.userId !== user.id || inst.state === 'terminated') throw new HttpError(404, 'Instance not found')
    if (!inst.vpcId) throw new HttpError(400, 'The instance is not in a VPC subnet')
    const vpc = db.get('net_vpcs', inst.vpcId)
    if (!vpc?.igwId) throw new HttpError(400, 'The instance\'s VPC has no internet gateway')
    if (e.instanceId) throw new HttpError(409, 'The Elastic IP is already associated; disassociate it first')
    const prev = db.find('net_eips', (x) => x.instanceId === inst.id)[0]
    if (prev) throw new HttpError(409, 'The instance already has an Elastic IP')
    db.update('instances', inst.id, { publicIp: e.ip })
    return eipView(db.update('net_eips', e.id, { instanceId: inst.id }))
  })
  r.post('/api/network/eips/:id/disassociate', ({ user, params }) => {
    const e = ownRow('net_eips', user, params.id, 'Elastic IP')
    if (e.instanceId) { const i = db.get('instances', e.instanceId); if (i?.publicIp === e.ip) db.update('instances', i.id, { publicIp: null }) }
    return eipView(db.update('net_eips', e.id, { instanceId: null }))
  })
  r.delete('/api/network/eips/:id', ({ user, params }) => {
    const e = ownRow('net_eips', user, params.id, 'Elastic IP')
    if (e.instanceId) throw new HttpError(409, 'Disassociate the Elastic IP first')
    db.remove('net_eips', e.id)
    return { ok: true }
  })

  /* ------------------------------------------------------------------ security groups */
  const sgView = (s) => ({ id: s.id, vpcId: s.vpcId, name: s.name, description: s.description, isDefault: !!s.isDefault, ingress: s.ingress, egress: s.egress })
  r.get('/api/network/security-groups', ({ user, query }) => ({ securityGroups: by('net_sgs', 'userId', user.id).filter((s) => !query.get('vpcId') || s.vpcId === query.get('vpcId')).map(sgView) }))
  r.post('/api/network/security-groups', ({ user, body }) => {
    required(body, 'vpcId', 'name')
    const v = vpcOf(user, body.vpcId)
    nameOk(body.name)
    if (by('net_sgs', 'vpcId', v.id).some((s) => s.name === body.name)) throw new HttpError(409, 'A security group with that name exists in the VPC')
    if (by('net_sgs', 'userId', user.id).length >= LIM.sgs) throw new HttpError(409, `At most ${LIM.sgs} security groups`)
    const egress = [{ id: `sgr_${crypto.randomBytes(5).toString('hex')}`, protocol: '-1', fromPort: null, toPort: null, cidr: '0.0.0.0/0', description: 'allow all outbound' }]
    return [201, sgView(db.insert('net_sgs', { userId: user.id, vpcId: v.id, name: body.name, description: String(body.description ?? '').slice(0, 200), isDefault: false, ingress: [], egress }))]
  })
  const sgOf = (user, id) => ownRow('net_sgs', user, id, 'Security group')
  r.get('/api/network/security-groups/:id', ({ user, params }) => sgView(sgOf(user, params.id)))
  for (const dir of ['ingress', 'egress']) {
    r.post(`/api/network/security-groups/:id/${dir}`, ({ user, params, body }) => {
      const s = sgOf(user, params.id)
      const rule = parseRule(body, dir)
      if (rule.sgId) { const peer = db.get('net_sgs', rule.sgId); if (!peer || peer.userId !== user.id || peer.vpcId !== s.vpcId) throw new HttpError(400, 'sgId must be a security group in the same VPC') }
      if (s[dir].length >= LIM.rulesPerSg) throw new HttpError(409, `At most ${LIM.rulesPerSg} ${dir} rules`)
      const dup = s[dir].find((x) => x.protocol === rule.protocol && x.fromPort === rule.fromPort && x.toPort === rule.toPort && x.cidr === rule.cidr && x.sgId === rule.sgId)
      if (dup) throw new HttpError(409, 'An identical rule already exists')
      return [201, sgView(db.update('net_sgs', s.id, { [dir]: [...s[dir], rule] }))]
    })
    r.delete(`/api/network/security-groups/:id/${dir}/:ruleId`, ({ user, params }) => {
      const s = sgOf(user, params.id)
      if (!s[dir].some((x) => x.id === params.ruleId)) throw new HttpError(404, 'Rule not found')
      return sgView(db.update('net_sgs', s.id, { [dir]: s[dir].filter((x) => x.id !== params.ruleId) }))
    })
  }
  r.delete('/api/network/security-groups/:id', ({ user, params }) => {
    const s = sgOf(user, params.id)
    if (s.isDefault) throw new HttpError(400, 'The default security group cannot be deleted')
    if (db.find('instances', (i) => i.state !== 'terminated' && (i.securityGroupIds ?? []).includes(s.id)).length) throw new HttpError(409, 'The security group is attached to instances')
    if (by('net_sgs', 'vpcId', s.vpcId).some((o) => o.id !== s.id && [...o.ingress, ...o.egress].some((x) => x.sgId === s.id))) throw new HttpError(409, 'Other security groups reference this group')
    db.remove('net_sgs', s.id)
    return { ok: true }
  })

  /* ------------------------------------------------------------------ rule evaluator */
  const liveInstances = (userId) => db.find('instances', (i) => i.userId === userId && i.state !== 'terminated')
  function resolveEndpoint(user, ref) {
    if (typeof ref !== 'string' || !ref) throw new HttpError(400, 'from and to must be an instance id or an IPv4 address')
    const insts = liveInstances(user.id)
    const inst = insts.find((i) => i.id === ref) ?? insts.find((i) => i.privateIp === ref || i.publicIp === ref)
    if (inst) return { kind: 'instance', inst, ip: inst.privateIp ?? null, sgs: (inst.securityGroupIds ?? []).map((id) => db.get('net_sgs', id)).filter(Boolean), subnet: inst.subnetId ? db.get('net_subnets', inst.subnetId) : null, vpcId: inst.vpcId ?? null }
    const n = ipToInt(ref)
    if (n === null) throw new HttpError(404, 'No instance with that id or address')
    return { kind: 'ip', ip: ref, ipInt: n, sgs: [], subnet: null, vpcId: null }
  }
  /** Is traffic from `from` to `to` on protocol/port allowed? Returns a full explanation. */
  function evaluate(user, fromRef, toRef, protocol, port) {
    const from = resolveEndpoint(user, fromRef), to = resolveEndpoint(user, toRef)
    const steps = []
    const result = (allowed, reason) => ({ allowed, reason, steps, from: { kind: from.kind, ip: from.ip, vpcId: from.vpcId }, to: { kind: to.kind, ip: to.ip, vpcId: to.vpcId } })
    if (from.kind === 'instance' && from.inst.state !== 'running') return result(false, `Source instance is ${from.inst.state}`)
    if (to.kind === 'instance' && to.inst.state !== 'running') return result(false, `Destination instance is ${to.inst.state}`)
    const sourceIp = from.kind === 'instance' ? from.ip : from.ip
    const destIp = to.kind === 'instance' ? (to.inst.privateIp ?? null) : to.ip
    // 1. routing
    let viaPublic = false
    if (from.kind === 'instance' && to.kind === 'instance' && from.vpcId && from.vpcId === to.vpcId) steps.push({ step: 'route', ok: true, note: 'same VPC: local route' })
    else if (from.kind === 'instance' && to.kind === 'instance' && from.vpcId && to.vpcId && from.vpcId !== to.vpcId) {
      if (to.inst.publicIp && refMatches(toRef, to.inst.publicIp)) { viaPublic = true } else return result(false, 'No route between different VPCs (peering is not supported); address the destination by its public IP')
    } else viaPublic = true
    if (viaPublic) {
      const rt = from.subnet ? db.get('net_routetables', from.subnet.routeTableId) : null
      const igwId = from.vpcId ? db.get('net_vpcs', from.vpcId)?.igwId : null
      const hasDefault = rt?.routes.some((x) => x.destination === '0.0.0.0/0' && x.target === igwId && igwId)
      if (from.kind === 'instance' && !hasDefault) return result(false, 'The source subnet has no 0.0.0.0/0 route to an internet gateway')
      if (from.kind === 'instance' && !from.inst.publicIp) return result(false, 'The source instance has no public IP address')
      steps.push({ step: 'route', ok: true, note: 'via the internet gateway' })
    }
    // 2. egress of the source
    if (from.kind === 'instance') {
      const dstInt = ipToInt(destIp ?? (to.kind === 'ip' ? to.ip : to.inst.publicIp))
      const ok = from.sgs.some((sg) => sg.egress.some((rule) => ruleMatches(rule, protocol, port) && (rule.cidr ? dstInt !== null && cidrContainsIp(parseCidr(rule.cidr), dstInt) : to.kind === 'instance' && to.sgs.some((t) => t.id === rule.sgId))))
      const hit = from.sgs.flatMap((sg) => sg.egress.filter((rule) => ruleMatches(rule, protocol, port) && (rule.cidr ? dstInt !== null && cidrContainsIp(parseCidr(rule.cidr), dstInt) : to.kind === 'instance' && to.sgs.some((t) => t.id === rule.sgId))).map((rule) => ({ sg: sg.name, rule: rule.id })))
      steps.push({ step: 'egress', ok, matched: hit })
      if (!ok) return result(false, 'Denied by the source\'s security groups (no matching egress rule)')
    }
    // 3. ingress of the destination
    if (to.kind === 'instance') {
      const srcInt = ipToInt(viaPublic ? (from.kind === 'instance' ? from.inst.publicIp : from.ip) : sourceIp)
      const matches = (rule) => ruleMatches(rule, protocol, port) && (rule.cidr ? srcInt !== null && cidrContainsIp(parseCidr(rule.cidr), srcInt) : from.kind === 'instance' && from.sgs.some((s) => s.id === rule.sgId))
      const hit = to.sgs.flatMap((sg) => sg.ingress.filter(matches).map((rule) => ({ sg: sg.name, rule: rule.id })))
      steps.push({ step: 'ingress', ok: hit.length > 0, matched: hit })
      if (!hit.length) return result(false, 'Denied by the destination\'s security groups (no matching ingress rule)')
    }
    return result(true, 'Allowed')
  }
  const refMatches = (ref, ip) => ref === ip
  r.post('/api/network/check', ({ user, body }) => {
    required(body, 'from', 'to')
    const protocol = String(body.protocol ?? 'tcp').toLowerCase()
    if (!['tcp', 'udp', 'icmp'].includes(protocol)) throw new HttpError(400, 'protocol must be tcp, udp or icmp')
    const port = protocol === 'icmp' ? 0 : body.port
    if (protocol !== 'icmp' && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new HttpError(400, 'port must be an integer between 0 and 65535')
    return evaluate(user, body.from, body.to, protocol, port)
  })

  /* ------------------------------------------------------------------ topology (for the UI diagram) */
  r.get('/api/network/topology', ({ user }) => {
    const insts = liveInstances(user.id)
    return {
      simulated: true,
      vpcs: by('net_vpcs', 'userId', user.id).map((v) => ({
        ...vpcView(v),
        subnets: by('net_subnets', 'vpcId', v.id).map((s) => ({ ...subnetView(s), instances: insts.filter((i) => i.subnetId === s.id).map((i) => ({ id: i.id, name: i.name, state: i.state, privateIp: i.privateIp, publicIp: i.publicIp ?? null, securityGroupIds: i.securityGroupIds ?? [] })) })),
        securityGroups: by('net_sgs', 'vpcId', v.id).map((s) => ({ id: s.id, name: s.name, isDefault: !!s.isDefault })),
      })),
      elasticIps: by('net_eips', 'userId', user.id).map(eipView),
    }
  })

  /* ------------------------------------------------------------------ API for the compute module */
  ctx.net = {
    parseCidr, allocateIp, releaseIp, evaluate, newPublicIp,
    subnetFor(user, subnetId) { const s = ownRow('net_subnets', user, subnetId, 'Subnet'); return s },
    vpcDefaultSg: (vpcId) => db.get('net_vpcs', vpcId)?.defaultSgId ?? null,
    validateSgs(user, vpcId, ids) {
      if (!Array.isArray(ids) || ids.length > 5) throw new HttpError(400, 'securityGroupIds must be an array of at most 5 ids')
      for (const id of ids) { const sg = db.get('net_sgs', id); if (!sg || sg.userId !== user.id || sg.vpcId !== vpcId) throw new HttpError(400, `Security group ${String(id).slice(0, 40)} does not exist in this VPC`) }
      return ids
    },
    releaseEipsOf(instanceId) { for (const e of db.find('net_eips', (x) => x.instanceId === instanceId)) db.update('net_eips', e.id, { instanceId: null }) },
    elasticIpOf: (instanceId) => db.find('net_eips', (x) => x.instanceId === instanceId)[0] ?? null,
  }
  ;(ctx.scopeRules ??= []).push(['/api/network', 'compute']) // security.js loads later and applies queued rules
  ctx.events.on('account.deleted', ({ userId }) => { for (const col of ['net_vpcs', 'net_subnets', 'net_routetables', 'net_igws', 'net_eips', 'net_sgs']) db.removeWhere(col, (x) => x.userId === userId) })
}
