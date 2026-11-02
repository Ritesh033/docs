import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp } from './helpers.js'
import { parseCidr, ipToInt, intToIp, cidrOverlap, cidrContainsCidr, cidrContainsIp } from '../src/modules/network.js'

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
const vpc = async (u, cidr = '10.0.0.0/16', name = 'main') => (await post(u, '/api/network/vpcs', { name, cidr })).data
const subnet = async (u, vpcId, cidr, az = 'rd-east-1a', extra = {}) => (await post(u, `/api/network/vpcs/${vpcId}/subnets`, { cidr, az, name: 's', ...extra })).data
const launch = async (u, body) => { const r = await post(u, '/api/compute/instances', body); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data }

test('cidr maths: parsing, canonical form, overlap, containment', () => {
  const c = parseCidr('10.0.0.0/16')
  assert.deepEqual([intToIp(c.base), c.prefix, c.size, intToIp(c.last)], ['10.0.0.0', 16, 65536, '10.0.255.255'])
  assert.equal(parseCidr('0.0.0.0/0').size, 2 ** 32)
  assert.equal(parseCidr('192.168.1.5/32').size, 1)
  for (const bad of ['10.0.0.1/16', '10.0.0.0/33', '10.0.0/16', '10.0.0.256/16', '10.0.0.0', '10.0.0.0/', 'x', '010.0.0.0/8', '10.0.0.0/-1', '', null, 5, '10.0.0.0/16 ']) assert.throws(() => parseCidr(bad), /CIDR|Invalid/, String(bad))
  assert.equal(cidrOverlap(parseCidr('10.0.0.0/24'), parseCidr('10.0.0.128/25')), true)
  assert.equal(cidrOverlap(parseCidr('10.0.0.0/24'), parseCidr('10.0.1.0/24')), false)
  assert.equal(cidrContainsCidr(parseCidr('10.0.0.0/16'), parseCidr('10.0.5.0/24')), true)
  assert.equal(cidrContainsCidr(parseCidr('10.0.5.0/24'), parseCidr('10.0.0.0/16')), false)
  assert.equal(cidrContainsIp(parseCidr('172.16.0.0/12'), ipToInt('172.31.255.255')), true)
  assert.equal(cidrContainsIp(parseCidr('172.16.0.0/12'), ipToInt('172.32.0.0')), false)
  assert.equal(ipToInt('1.2.3.4'), 0x01020304); assert.equal(ipToInt('255.255.255.255'), 0xffffffff); assert.equal(ipToInt('1.2.3'), null); assert.equal(ipToInt('01.2.3.4'), null)
  assert.equal(intToIp(ipToInt('192.0.2.7')), '192.0.2.7')
})

test('vpcs: validation, defaults, limits, isolation, deletion rules', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    for (const body of [{ name: 'x', cidr: '8.8.8.0/24' }, { name: 'x', cidr: '10.0.0.0/8' }, { name: 'x', cidr: '10.0.0.0/29' }, { name: 'x', cidr: '10.0.0.1/16' }, { name: 'x', cidr: '11.0.0.0/16' }, { name: '', cidr: '10.0.0.0/16' }, { name: 'x', cidr: '10.0.0.0/16', region: 'mars-1' }, { name: 'x' }]) {
      assert.equal((await post(u, '/api/network/vpcs', body)).status, 400, JSON.stringify(body))
    }
    const a = await vpc(u)
    assert.equal(a.cidr, '10.0.0.0/16'); assert.equal(a.region, 'rd-east-1')
    const detail = (await u.call('GET', `/api/network/vpcs/${a.id}`)).data
    assert.equal(detail.securityGroups.length, 1); assert.equal(detail.securityGroups[0].isDefault, true); assert.equal(detail.routeTables[0].main, true)
    assert.deepEqual(detail.routeTables[0].routes, [{ destination: '10.0.0.0/16', target: 'local' }])
    assert.equal(detail.securityGroups[0].ingress[0].sgId, detail.securityGroups[0].id, 'default group allows its own members')
    assert.equal((await vpc(v)).cidr, '10.0.0.0/16', 'CIDRs may repeat across users')
    assert.equal((await u.call('GET', `/api/network/vpcs/${a.id}`, {})).status, 200)
    assert.equal((await v.call('GET', `/api/network/vpcs/${a.id}`)).status, 404)
    assert.equal((await v.call('DELETE', `/api/network/vpcs/${a.id}`)).status, 404)
    const s = await subnet(u, a.id, '10.0.1.0/24')
    assert.equal((await u.call('DELETE', `/api/network/vpcs/${a.id}`)).status, 409, 'has subnets')
    await u.call('DELETE', `/api/network/subnets/${s.id}`)
    assert.equal((await u.call('DELETE', `/api/network/vpcs/${a.id}`)).status, 200)
    for (let i = 0; i < 5; i++) await vpc(u, `10.${i}.0.0/16`, `v${i}`)
    assert.equal((await post(u, '/api/network/vpcs', { name: 'six', cidr: '10.9.0.0/16' })).status, 409, 'VPC cap')
  })
})

test('subnets: containment, overlap, AZ rules, IP allocation (first 4 + last reserved), exhaustion and reuse', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const a = await vpc(u, '10.0.0.0/16')
    for (const [cidr, az] of [['10.1.0.0/24', 'rd-east-1a'], ['10.0.0.0/29', 'rd-east-1a'], ['10.0.1.0/24', 'rd-west-1a'], ['10.0.1.0/24', 'nope'], ['10.0.0.0/8', 'rd-east-1a'], ['bad', 'rd-east-1a']]) assert.equal((await post(u, `/api/network/vpcs/${a.id}/subnets`, { cidr, az })).status, 400, `${cidr} ${az}`)
    const s1 = await subnet(u, a.id, '10.0.0.0/28')
    assert.equal(s1.availableIps, 11)
    const s2 = await post(u, `/api/network/vpcs/${a.id}/subnets`, { cidr: '10.0.0.0/24', az: 'rd-east-1b' })
    assert.equal(s2.status, 409); assert.match(s2.data.error, /overlaps/)
    assert.equal((await post(v, `/api/network/vpcs/${a.id}/subnets`, { cidr: '10.0.5.0/24', az: 'rd-east-1a' })).status, 404)
    const ips = []
    for (let i = 0; i < 11; i++) ips.push((await launch(u, { name: `i${i}`, subnetId: s1.id })).privateIp)
    assert.deepEqual(ips.slice(0, 3), ['10.0.0.4', '10.0.0.5', '10.0.0.6']); assert.equal(ips.at(-1), '10.0.0.14', '10.0.0.15 (the last address) stays reserved')
    assert.equal(new Set(ips).size, 11)
    const full = await post(u, '/api/compute/instances', { name: 'overflow', subnetId: s1.id })
    assert.equal(full.status, 409); assert.match(full.data.error, /no free IP/)
    const list = (await u.call('GET', '/api/compute/instances')).data.instances
    await post(u, `/api/compute/instances/${list[3].id}/terminate`)
    assert.equal((await launch(u, { name: 'reuse', subnetId: s1.id })).privateIp, ips[3], 'freed addresses are reused (lowest first)')
    assert.equal((await u.call('DELETE', `/api/network/subnets/${s1.id}`)).status, 409, 'subnet has instances')
  })
})

test('route tables, internet gateways and elastic IPs', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const a = await vpc(u)
    const pub = await subnet(u, a.id, '10.0.1.0/24', 'rd-east-1a', { public: true })
    const igw = (await post(u, '/api/network/igws', { name: 'gw' })).data
    const rt = (await post(u, '/api/network/route-tables', { vpcId: a.id, name: 'public' })).data
    assert.equal((await post(u, `/api/network/route-tables/${rt.id}/routes`, { destination: '0.0.0.0/0', target: igw.id })).status, 400, 'gateway not attached yet')
    assert.equal((await post(u, `/api/network/igws/${igw.id}/attach`, { vpcId: a.id })).data.vpcId, a.id)
    assert.equal((await post(u, '/api/network/igws', { name: 'gw2' })).status, 201)
    const igw2 = (await u.call('GET', '/api/network/igws')).data.internetGateways.find((g) => g.name === 'gw2')
    assert.equal((await post(u, `/api/network/igws/${igw2.id}/attach`, { vpcId: a.id })).status, 409, 'one gateway per VPC')
    assert.equal((await post(v, `/api/network/igws/${igw.id}/attach`, { vpcId: a.id })).status, 404)
    assert.equal((await post(u, `/api/network/route-tables/${rt.id}/routes`, { destination: '0.0.0.0/0', target: igw.id })).status, 200)
    assert.equal((await post(u, `/api/network/route-tables/${rt.id}/routes`, { destination: '0.0.0.0/0', target: 'blackhole' })).status, 409, 'duplicate destination')
    assert.equal((await post(u, `/api/network/route-tables/${rt.id}/routes`, { destination: '10.5.0.0/16', target: 'nonsense' })).status, 400)
    assert.equal((await u.call('DELETE', `/api/network/route-tables/${rt.id}/routes?destination=10.0.0.0/16`)).status, 400, 'local route is permanent')
    assert.equal((await post(u, `/api/network/route-tables/${rt.id}/associate`, { subnetId: pub.id })).data.associations.length, 1)
    const detail = (await u.call('GET', `/api/network/vpcs/${a.id}`)).data
    assert.equal(detail.routeTables.find((t) => t.main).associations.length, 0, 'moved off the main table')
    assert.equal((await u.call('DELETE', `/api/network/route-tables/${rt.id}`)).status, 409)
    assert.equal((await u.call('DELETE', `/api/network/route-tables/${detail.mainRouteTableId}`)).status, 400)
    assert.equal((await u.call('POST', `/api/network/igws/${igw.id}/detach`)).status, 200)
    assert.equal((await u.call('GET', `/api/network/route-tables`)).data.routeTables.find((t) => t.id === rt.id).routes.find((x) => x.destination === '0.0.0.0/0').target, 'blackhole', 'routes via a detached gateway become blackholes')
    await post(u, `/api/network/igws/${igw.id}/attach`, { vpcId: a.id })
    // elastic IPs
    const inst = await launch(u, { name: 'web', subnetId: pub.id })
    const e1 = (await post(u, '/api/network/eips', {})).data, e2 = (await post(u, '/api/network/eips', {})).data
    assert.notEqual(e1.ip, e2.ip); assert.match(e1.ip, /^(198\.51\.100|203\.0\.113)\.\d+$/)
    assert.equal((await post(u, `/api/network/eips/${e1.id}/associate`, { instanceId: inst.id })).data.instanceId, inst.id)
    assert.equal((await u.call('GET', `/api/compute/instances/${inst.id}`)).data.publicIp, e1.ip)
    assert.equal((await post(u, `/api/network/eips/${e2.id}/associate`, { instanceId: inst.id })).status, 409, 'one EIP per instance')
    assert.equal((await u.call('DELETE', `/api/network/eips/${e1.id}`)).status, 409, 'release needs disassociation')
    assert.equal((await post(u, `/api/network/igws/${igw.id}/detach`, {})).status, 409, 'EIP in use in the VPC')
    await post(u, `/api/compute/instances/${inst.id}/stop`)
    assert.equal((await u.call('GET', `/api/compute/instances/${inst.id}`)).data.publicIp, e1.ip, 'an Elastic IP survives stop/start')
    assert.equal((await post(u, `/api/network/eips/${e1.id}/disassociate`, {})).data.instanceId, null)
    assert.equal((await u.call('DELETE', `/api/network/eips/${e1.id}`)).status, 200)
    assert.equal((await v.call('GET', '/api/network/eips')).data.elasticIps.length, 0)
    assert.equal((await post(v, `/api/network/eips/${e2.id}/associate`, { instanceId: inst.id })).status, 404)
    const plain = await launch(u, { name: 'no-vpc' })
    assert.equal((await post(u, `/api/network/eips/${e2.id}/associate`, { instanceId: plain.id })).status, 400, 'instance must be in a VPC')
    for (let i = 0; i < 4; i++) assert.equal((await post(u, '/api/network/eips', {})).status, 201)
    assert.equal((await post(u, '/api/network/eips', {})).status, 409, 'EIP cap (5)')
  })
})

test('security groups: rule validation, limits, references, deletion rules', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const a = await vpc(u), b = await vpc(u, '10.1.0.0/16', 'other')
    const sg = (await post(u, '/api/network/security-groups', { vpcId: a.id, name: 'web', description: 'web tier' })).data
    assert.equal(sg.ingress.length, 0); assert.equal(sg.egress.length, 1)
    assert.equal((await post(u, '/api/network/security-groups', { vpcId: a.id, name: 'web' })).status, 409)
    assert.equal((await post(v, '/api/network/security-groups', { vpcId: a.id, name: 'x' })).status, 404)
    const add = (id, dir, body) => post(u, `/api/network/security-groups/${id}/${dir}`, body)
    for (const body of [{ protocol: 'icmpx', cidr: '0.0.0.0/0' }, { protocol: 'tcp', fromPort: -1, cidr: '0.0.0.0/0' }, { protocol: 'tcp', fromPort: 70000, cidr: '0.0.0.0/0' }, { protocol: 'tcp', fromPort: 90, toPort: 80, cidr: '0.0.0.0/0' }, { protocol: 'tcp', fromPort: 80, cidr: 'bad' }, { protocol: 'tcp', fromPort: 80 }, { protocol: 'tcp', fromPort: 1.5, cidr: '0.0.0.0/0' }, { protocol: 'tcp', fromPort: 80, cidr: '0.0.0.0/0', description: 'x'.repeat(141) }, { protocol: 'tcp', fromPort: 80, sgId: 5 }]) {
      assert.equal((await add(sg.id, 'ingress', body)).status, 400, JSON.stringify(body))
    }
    const r1 = (await add(sg.id, 'ingress', { protocol: 'tcp', fromPort: 443, cidr: '0.0.0.0/0' })).data.ingress[0]
    assert.match(r1.id, /^sgr_/)
    assert.equal((await add(sg.id, 'ingress', { protocol: 'tcp', fromPort: 443, cidr: '0.0.0.0/0' })).status, 409, 'duplicate rule')
    const db2 = (await post(u, '/api/network/security-groups', { vpcId: a.id, name: 'db' })).data
    assert.equal((await add(db2.id, 'ingress', { protocol: 'tcp', fromPort: 5432, sgId: sg.id })).status, 201, 'group-to-group reference')
    const other = (await post(u, '/api/network/security-groups', { vpcId: b.id, name: 'foreign' })).data
    assert.equal((await add(db2.id, 'ingress', { protocol: 'tcp', fromPort: 5432, sgId: other.id })).status, 400, 'cross-VPC reference refused')
    assert.equal((await u.call('DELETE', `/api/network/security-groups/${sg.id}`)).status, 409, 'referenced by another group')
    assert.equal((await u.call('DELETE', `/api/network/security-groups/${db2.id}/ingress/${r1.id}`)).status, 404)
    assert.equal((await u.call('DELETE', `/api/network/security-groups/${sg.id}/ingress/${r1.id}`)).data.ingress.length, 0)
    const def = (await u.call('GET', `/api/network/vpcs/${a.id}`)).data.securityGroups.find((s) => s.isDefault)
    assert.equal((await u.call('DELETE', `/api/network/security-groups/${def.id}`)).status, 400)
    for (let i = 0; i < 60; i++) await add(db2.id, 'egress', { protocol: 'tcp', fromPort: 1000 + i, cidr: '10.0.0.0/8' })
    assert.equal((await add(db2.id, 'egress', { protocol: 'tcp', fromPort: 9999, cidr: '10.0.0.0/8' })).status, 409, 'rule cap')
    const s = await subnet(u, a.id, '10.0.1.0/24')
    const inst = await launch(u, { name: 'x', subnetId: s.id, securityGroupIds: [sg.id] })
    assert.deepEqual(inst.securityGroupIds, [sg.id])
    assert.equal((await post(u, '/api/compute/instances', { name: 'y', subnetId: s.id, securityGroupIds: [other.id] })).status, 400, "another VPC's group")
    assert.equal((await post(u, '/api/compute/instances', { name: 'y', subnetId: s.id, securityGroupIds: [def.id, 'nope'] })).status, 400)
    assert.equal((await post(u, '/api/compute/instances', { name: 'y', securityGroupIds: [sg.id] })).status, 400, 'groups need a subnet')
    assert.equal((await u.call('DELETE', `/api/network/security-groups/${sg.id}`)).status, 409, 'attached to an instance')
    assert.equal((await v.call('GET', `/api/network/security-groups/${sg.id}`)).status, 404)
  })
})

test('rule evaluator: security groups, routing, public addressing and explanations', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const a = await vpc(u, '10.0.0.0/16'), b = await vpc(u, '10.1.0.0/16', 'second')
    const priv = await subnet(u, a.id, '10.0.1.0/24'), pub = await subnet(u, a.id, '10.0.2.0/24', 'rd-east-1b', { public: true }), sb = await subnet(u, b.id, '10.1.1.0/24')
    const webSg = (await post(u, '/api/network/security-groups', { vpcId: a.id, name: 'web' })).data
    const dbSg = (await post(u, '/api/network/security-groups', { vpcId: a.id, name: 'db' })).data
    await post(u, `/api/network/security-groups/${webSg.id}/ingress`, { protocol: 'tcp', fromPort: 80, toPort: 443, cidr: '0.0.0.0/0' })
    await post(u, `/api/network/security-groups/${webSg.id}/ingress`, { protocol: 'icmp', cidr: '10.0.0.0/16' })
    await post(u, `/api/network/security-groups/${dbSg.id}/ingress`, { protocol: 'tcp', fromPort: 5432, sgId: webSg.id })
    const web = await launch(u, { name: 'web', subnetId: pub.id, securityGroupIds: [webSg.id] })
    const dbi = await launch(u, { name: 'db', subnetId: priv.id, securityGroupIds: [dbSg.id] })
    const other = await launch(u, { name: 'other', subnetId: sb.id })
    const check = async (from, to, protocol, port) => (await post(u, '/api/network/check', { from, to, protocol, port })).data
    let r = await check(web.id, dbi.id, 'tcp', 5432)
    assert.equal(r.allowed, true, JSON.stringify(r)); assert.equal(r.steps.find((x) => x.step === 'ingress').matched[0].sg, 'db', 'matched via the group reference')
    r = await check(web.id, dbi.id, 'tcp', 22); assert.equal(r.allowed, false); assert.match(r.reason, /destination.*ingress/)
    r = await check(dbi.id, web.id, 'tcp', 80); assert.equal(r.allowed, true, 'cidr rule 10.0.0.0/16 not needed: 0.0.0.0/0 matches')
    r = await check(dbi.id, web.id, 'tcp', 8080); assert.equal(r.allowed, false)
    r = await check(dbi.id, web.id, 'icmp'); assert.equal(r.allowed, true, 'icmp from inside the VPC')
    r = await check(web.privateIp, dbi.privateIp, 'tcp', 5432); assert.equal(r.allowed, true, 'instances can be addressed by IP')
    r = await check(web.id, other.id, 'tcp', 80); assert.equal(r.allowed, false); assert.match(r.reason, /different VPCs/)
    // restrict egress of the web tier: only 10.0.0.0/16 on 5432
    const full = (await u.call('GET', `/api/network/security-groups/${webSg.id}`)).data
    await u.call('DELETE', `/api/network/security-groups/${webSg.id}/egress/${full.egress[0].id}`)
    r = await check(web.id, dbi.id, 'tcp', 5432); assert.equal(r.allowed, false); assert.match(r.reason, /source.*egress/)
    await post(u, `/api/network/security-groups/${webSg.id}/egress`, { protocol: 'tcp', fromPort: 5432, cidr: '10.0.0.0/16' })
    r = await check(web.id, dbi.id, 'tcp', 5432); assert.equal(r.allowed, true)
    // the internet: needs a gateway route + public IP
    const igw = (await post(u, '/api/network/igws', {})).data
    await post(u, `/api/network/igws/${igw.id}/attach`, { vpcId: a.id })
    await post(u, `/api/network/security-groups/${webSg.id}/egress`, { protocol: 'tcp', fromPort: 443, cidr: '0.0.0.0/0' })
    r = await check(web.id, '93.184.216.34', 'tcp', 443); assert.equal(r.allowed, false); assert.match(r.reason, /no 0\.0\.0\.0\/0 route/)
    const rt = (await post(u, '/api/network/route-tables', { vpcId: a.id, name: 'public' })).data
    await post(u, `/api/network/route-tables/${rt.id}/routes`, { destination: '0.0.0.0/0', target: igw.id })
    await post(u, `/api/network/route-tables/${rt.id}/associate`, { subnetId: pub.id })
    r = await check(web.id, '93.184.216.34', 'tcp', 443); assert.equal(r.allowed, true, JSON.stringify(r))
    r = await check(web.id, '93.184.216.34', 'tcp', 25); assert.equal(r.allowed, false, 'egress rule')
    r = await check(dbi.id, '93.184.216.34', 'tcp', 443); assert.equal(r.allowed, false, 'private subnet without a route')
    // public reachability of the web tier from outside
    r = await check('93.184.216.34', web.publicIp ?? (await u.call('GET', `/api/compute/instances/${web.id}`)).data.publicIp, 'tcp', 443)
    assert.equal(r.allowed, true, JSON.stringify(r))
    r = await check('93.184.216.34', (await u.call('GET', `/api/compute/instances/${web.id}`)).data.publicIp, 'tcp', 22); assert.equal(r.allowed, false)
    // stopped instances answer nothing
    await post(u, `/api/compute/instances/${dbi.id}/stop`)
    r = await check(web.id, dbi.id, 'tcp', 5432); assert.equal(r.allowed, false); assert.match(r.reason, /stopped/)
    for (const body of [{}, { from: web.id }, { from: web.id, to: dbi.id, protocol: 'gre', port: 1 }, { from: web.id, to: dbi.id, protocol: 'tcp', port: 'x' }, { from: web.id, to: dbi.id, protocol: 'tcp', port: 70000 }, { from: 'nope', to: dbi.id, protocol: 'tcp', port: 1 }, { from: 5, to: dbi.id, protocol: 'tcp', port: 1 }]) assert.ok((await post(u, '/api/network/check', body)).status >= 400, JSON.stringify(body))
    assert.equal((await post(v, '/api/network/check', { from: web.id, to: dbi.id, protocol: 'tcp', port: 80 })).status, 404, "other users' instances do not exist")
  })
})

test('instances in subnets: public IP lifecycle, termination releases everything, topology view', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const a = await vpc(u)
    const pub = await subnet(u, a.id, '10.0.1.0/24', 'rd-east-1a', { public: true }), priv = await subnet(u, a.id, '10.0.2.0/24')
    const p = await launch(u, { name: 'pub', subnetId: pub.id }), q = await launch(u, { name: 'priv', subnetId: priv.id })
    assert.match(p.publicIp, /^(198\.51\.100|203\.0\.113)\./); assert.equal(q.publicIp, null)
    assert.equal(p.region, 'rd-east-1'); assert.equal(p.az, 'rd-east-1a'); assert.equal(p.vpcId, a.id)
    await post(u, `/api/compute/instances/${p.id}/stop`)
    assert.equal((await u.call('GET', `/api/compute/instances/${p.id}`)).data.publicIp, null, 'auto-assigned public IPs are released on stop')
    await post(u, `/api/compute/instances/${p.id}/start`)
    assert.match((await u.call('GET', `/api/compute/instances/${p.id}`)).data.publicIp, /^(198|203)\./)
    const topo = (await u.call('GET', '/api/network/topology')).data
    assert.equal(topo.simulated, true); assert.equal(topo.vpcs[0].subnets.find((s) => s.id === pub.id).instances[0].name, 'pub')
    await post(u, `/api/compute/instances/${q.id}/terminate`)
    assert.equal((await u.call('GET', '/api/network/subnets')).data.subnets.find((s) => s.id === priv.id).allocated, 0)
  })
})
