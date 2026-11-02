import { s } from '/charts.js'

const put = (el, ...kids) => el.append(...kids.flat(Infinity).filter((x) => x != null && x !== false))
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((x) => x != null && x !== false))
const TABS = [['topology', 'Topology'], ['vpcs', 'VPCs & subnets'], ['sg', 'Security groups'], ['routing', 'Routing & gateways'], ['test', 'Connectivity tester']]
const text = (v) => document.createTextNode(String(v))

function diagram(topo) {
  const W = 940, PAD = 16, SW = 210, IH = 26
  let y = PAD
  const nodes = []
  for (const v of topo.vpcs) {
    const cols = Math.max(1, Math.min(4, v.subnets.length))
    const rows = Math.ceil(v.subnets.length / cols) || 1
    const heights = v.subnets.map((sn) => 40 + Math.max(1, sn.instances.length) * (IH + 6))
    const rowH = []
    for (let r = 0; r < rows; r++) rowH.push(Math.max(70, ...heights.slice(r * cols, r * cols + cols)))
    const vh = 54 + rowH.reduce((a, b) => a + b + 12, 0)
    const g = s('g', {}, s('rect', { class: 'nw-vpc', x: PAD, y, width: W - 2 * PAD, height: vh, rx: 10 }),
      s('text', { class: 'nw-label', x: PAD + 14, y: y + 24, 'font-weight': 600 }, text(`${v.name}  ${v.cidr}  ·  ${v.region}`)))
    if (v.internetGatewayId) g.append(s('circle', { class: 'nw-igw', cx: W - PAD - 24, cy: y + 22, r: 9 }, s('title', {}, text('Internet gateway attached'))), s('text', { class: 'nw-sub', x: W - PAD - 130, y: y + 26 }, text('internet gateway')))
    let yy = y + 44
    v.subnets.forEach((sn, idx) => {
      const col = idx % cols, row = Math.floor(idx / cols)
      if (col === 0 && row > 0) yy += rowH[row - 1] + 12
      const x = PAD + 14 + col * (SW + 12)
      g.append(s('rect', { class: `nw-subnet ${sn.public ? 'pub' : ''}`, x, y: yy, width: SW, height: rowH[row], rx: 8 }),
        s('text', { class: 'nw-label', x: x + 10, y: yy + 18 }, text(`${sn.name} ${sn.public ? '(public)' : '(private)'}`)), s('text', { class: 'nw-sub', x: x + 10, y: yy + 33 }, text(`${sn.cidr} · ${sn.az} · ${sn.availableIps} free`)))
      sn.instances.forEach((i, k) => {
        const iy = yy + 42 + k * (IH + 6)
        g.append(s('g', { tabindex: 0, role: 'img', 'aria-label': `${i.name}, ${i.state}, ${i.privateIp}${i.publicIp ? `, public ${i.publicIp}` : ''}` }, s('rect', { class: `nw-inst ${i.state}`, x: x + 10, y: iy, width: SW - 20, height: IH, rx: 5 }), s('text', { class: 'nw-label', x: x + 18, y: iy + 17 }, text(`${i.name}  ${i.privateIp}`)), s('title', {}, text(`${i.name}\n${i.state}\nprivate ${i.privateIp}${i.publicIp ? `\npublic ${i.publicIp}` : ''}`))))
      })
    })
    nodes.push(g); y += vh + 16
  }
  const svg = s('svg', { class: 'nw-topo', viewBox: `0 0 ${W} ${Math.max(y, 80)}`, role: 'img', 'aria-label': 'Network topology: VPCs, subnets and instances' }, s('title', {}, text('Network topology')), nodes)
  return svg
}

export default {
  id: 'network', title: 'Network', group: 'Cloud', order: 12,
  async render(el, arg, lib) {
    const { h, api, act, toast, rerender, confirmDialog, promptDialog } = lib
    const tab = TABS.some(([id]) => id === arg) ? arg : 'topology'
    put(el, h('h1', {}, 'Network'), h('div', { class: 'nw-banner', role: 'note' }, h('b', {}, 'Simulated. '), 'VPCs, subnets, routes and security groups are real bookkeeping with real CIDR maths and rule evaluation, but no packets flow.'),
      h('nav', { class: 'nw-tabs', 'aria-label': 'Network sections' }, TABS.map(([id, label]) => h('a', { href: `#network/${id}`, 'aria-current': id === tab ? 'page' : null }, label))))
    const body = h('div'); el.append(body)
    const err = (e) => h('div', { class: 'nw-err', role: 'alert' }, e.message)
    const field = (label, input) => h('label', {}, label, input)
    const sel = (opts, value, aria) => h('select', { 'aria-label': aria }, opts.map(([v, l]) => h('option', { value: v, selected: v === value ? true : null }, l)))
    const topo = await api('GET', '/api/network/topology')

    if (tab === 'topology') {
      put(body, topo.vpcs.length ? diagram(topo) : h('p', { class: 'muted' }, 'No VPCs yet. Create one under “VPCs & subnets”.'),
        topo.elasticIps.length ? [h('h3', {}, 'Elastic IPs'), h('ul', {}, topo.elasticIps.map((e) => h('li', {}, `${e.ip} → ${e.instanceId ?? 'unassociated'}`)))] : null)
    }

    if (tab === 'vpcs') {
      const name = h('input', { placeholder: 'main', 'aria-label': 'VPC name' }), cidr = h('input', { value: '10.0.0.0/16', 'aria-label': 'VPC CIDR' }), region = sel([['rd-east-1', 'rd-east-1'], ['rd-west-1', 'rd-west-1'], ['rd-eu-1', 'rd-eu-1']], 'rd-east-1', 'Region')
      put(body, h('h3', {}, 'Create a VPC'), h('div', { class: 'nw-form' }, field('Name', name), field('CIDR (private range, /16–/28)', cidr), field('Region', region)),
        h('div', { class: 'nw-row' }, h('button', { onclick: act(async () => { await api('POST', '/api/network/vpcs', { name: name.value, cidr: cidr.value, region: region.value }); rerender() }) }, 'Create VPC')))
      for (const v of topo.vpcs) {
        const sn = h('input', { placeholder: '10.0.1.0/24', 'aria-label': 'Subnet CIDR' }), sname = h('input', { placeholder: 'private-a', 'aria-label': 'Subnet name' }), az = sel(({ 'rd-east-1': ['rd-east-1a', 'rd-east-1b', 'rd-east-1c'], 'rd-west-1': ['rd-west-1a', 'rd-west-1b'], 'rd-eu-1': ['rd-eu-1a', 'rd-eu-1b'] }[v.region]).map((z) => [z, z]), '', 'Availability zone'), pub = h('input', { type: 'checkbox', id: `pub-${v.id}` })
        put(body, h('div', { class: 'nw-card' }, h('div', { class: 'nw-row' }, h('b', {}, `${v.name} — ${v.cidr}`), h('span', { class: 'muted' }, v.region), h('button', { class: 'sec', onclick: act(async () => { if (await confirmDialog(`Delete VPC ${v.name}?`, 'Delete')) { await api('DELETE', `/api/network/vpcs/${v.id}`); rerender() } }) }, 'Delete VPC')),
          v.subnets.length ? h('table', { class: 'nw-table' }, h('thead', {}, h('tr', {}, ['Subnet', 'CIDR', 'Zone', 'Type', 'IPs used / free', ''].map((x) => h('th', {}, x)))), h('tbody', {}, v.subnets.map((x) => h('tr', {}, h('td', {}, x.name), h('td', {}, x.cidr), h('td', {}, x.az), h('td', {}, x.public ? 'public' : 'private'), h('td', {}, `${x.instances.length} / ${x.availableIps}`), h('td', {}, h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/network/subnets/${x.id}`); rerender() }) }, 'Delete')))))) : h('p', { class: 'muted' }, 'No subnets.'),
          h('div', { class: 'nw-form' }, field('Subnet name', sname), field('CIDR', sn), field('Zone', az), h('label', {}, 'Public', pub)), h('div', { class: 'nw-row' }, h('button', { onclick: act(async () => { await api('POST', `/api/network/vpcs/${v.id}/subnets`, { name: sname.value || 'subnet', cidr: sn.value, az: az.value, public: pub.checked }); rerender() }) }, 'Add subnet'))))
      }
    }

    if (tab === 'sg') {
      const { securityGroups: groups } = await api('GET', '/api/network/security-groups')
      const pick = sel(groups.map((g) => [g.id, `${g.name} (${topo.vpcs.find((v) => v.id === g.vpcId)?.name ?? ''})`]), sessionStorage.getItem('rd_nw_sg') ?? groups[0]?.id, 'Security group')
      pick.addEventListener('change', () => { sessionStorage.setItem('rd_nw_sg', pick.value); rerender() })
      const vsel = sel(topo.vpcs.map((v) => [v.id, v.name]), topo.vpcs[0]?.id, 'VPC'), nm = h('input', { placeholder: 'web', 'aria-label': 'Group name' })
      put(body, h('div', { class: 'nw-row' }, vsel, nm, h('button', { onclick: act(async () => { const g = await api('POST', '/api/network/security-groups', { vpcId: vsel.value, name: nm.value }); sessionStorage.setItem('rd_nw_sg', g.id); rerender() }) }, 'Create group')))
      const g = groups.find((x) => x.id === pick.value) ?? groups[0]
      if (!g) { put(body, h('p', { class: 'muted' }, 'No security groups. Create a VPC first.')); return }
      const ruleTable = (dir, rules) => h('table', { class: 'nw-table' }, h('thead', {}, h('tr', {}, ['Protocol', 'Ports', dir === 'ingress' ? 'Source' : 'Destination', 'Description', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, rules.map((r) => h('tr', {}, h('td', {}, r.protocol === '-1' ? 'all' : r.protocol), h('td', {}, r.fromPort === null ? 'all' : r.fromPort === r.toPort ? String(r.fromPort) : `${r.fromPort}–${r.toPort}`), h('td', {}, r.cidr ?? `group ${groups.find((x) => x.id === r.sgId)?.name ?? r.sgId}`), h('td', {}, r.description), h('td', {}, h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/network/security-groups/${g.id}/${dir}/${r.id}`); rerender() }) }, 'Remove'))))))
      const adder = (dir) => {
        const proto = sel([['tcp', 'tcp'], ['udp', 'udp'], ['icmp', 'icmp'], ['-1', 'all']], 'tcp', 'Protocol'), from = h('input', { type: 'number', placeholder: 'port', min: '0', max: '65535', 'aria-label': 'From port', style: { width: '90px' } }), to = h('input', { type: 'number', placeholder: 'to', min: '0', max: '65535', 'aria-label': 'To port', style: { width: '90px' } }), cidr = h('input', { value: dir === 'ingress' ? '0.0.0.0/0' : '0.0.0.0/0', 'aria-label': 'CIDR' })
        return h('div', { class: 'nw-row' }, proto, from, to, cidr, h('button', { onclick: act(async () => { const b = { protocol: proto.value, cidr: cidr.value }; if (from.value !== '') { b.fromPort = Number(from.value); b.toPort = to.value === '' ? b.fromPort : Number(to.value) } await api('POST', `/api/network/security-groups/${g.id}/${dir}`, b); rerender() }) }, `Add ${dir} rule`))
      }
      put(body, h('div', { class: 'nw-row' }, h('label', {}, 'Group ', pick), g.isDefault ? null : h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/network/security-groups/${g.id}`); sessionStorage.removeItem('rd_nw_sg'); rerender() }) }, 'Delete group')),
        h('h3', {}, 'Inbound rules'), ruleTable('ingress', g.ingress), adder('ingress'), h('h3', {}, 'Outbound rules'), ruleTable('egress', g.egress), adder('egress'))
    }

    if (tab === 'routing') {
      const [{ routeTables }, { internetGateways }, { elasticIps }] = await Promise.all([api('GET', '/api/network/route-tables'), api('GET', '/api/network/igws'), api('GET', '/api/network/eips')])
      put(body, h('h3', {}, 'Internet gateways'), h('div', { class: 'nw-row' }, h('button', { onclick: act(async () => { await api('POST', '/api/network/igws', { name: 'igw' }); rerender() }) }, 'Create gateway')),
        internetGateways.map((g) => h('div', { class: 'nw-row' }, h('code', {}, g.id), g.vpcId ? `attached to ${topo.vpcs.find((v) => v.id === g.vpcId)?.name}` : 'detached',
          g.vpcId ? h('button', { class: 'sec', onclick: act(async () => { await api('POST', `/api/network/igws/${g.id}/detach`, {}); rerender() }) }, 'Detach') : [h('button', { class: 'sec', onclick: act(async () => { const v = await promptDialog(`Attach to which VPC id?\n${topo.vpcs.map((x) => `${x.name}: ${x.id}`).join('\n')}`, topo.vpcs[0]?.id ?? ''); if (v) { await api('POST', `/api/network/igws/${g.id}/attach`, { vpcId: v }); rerender() } }) }, 'Attach'), h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/network/igws/${g.id}`); rerender() }) }, 'Delete')])),
        h('h3', {}, 'Route tables'),
        routeTables.map((t) => h('div', { class: 'nw-card' }, h('div', { class: 'nw-row' }, h('b', {}, `${t.name}${t.main ? ' (main)' : ''}`), h('span', { class: 'muted' }, `${topo.vpcs.find((v) => v.id === t.vpcId)?.name} · ${t.associations.length} subnet(s)`)),
          h('table', { class: 'nw-table' }, h('tbody', {}, t.routes.map((r) => h('tr', {}, h('td', {}, r.destination), h('td', {}, r.target), h('td', {}, r.target === 'local' ? null : h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/network/route-tables/${t.id}/routes?destination=${encodeURIComponent(r.destination)}`); rerender() }) }, 'Remove')))))),
          h('div', { class: 'nw-row' }, h('button', { class: 'sec', onclick: act(async () => { const dest = await promptDialog('Destination CIDR', '0.0.0.0/0'); if (!dest) return; const target = await promptDialog('Target (internet gateway id or "blackhole")', internetGateways.find((g) => g.vpcId === t.vpcId)?.id ?? 'blackhole'); if (target) { await api('POST', `/api/network/route-tables/${t.id}/routes`, { destination: dest, target }); rerender() } }) }, 'Add route'),
            h('button', { class: 'sec', onclick: act(async () => { const sid = await promptDialog(`Associate which subnet id?\n${topo.vpcs.filter((v) => v.id === t.vpcId).flatMap((v) => v.subnets).map((x) => `${x.name}: ${x.id}`).join('\n')}`, ''); if (sid) { await api('POST', `/api/network/route-tables/${t.id}/associate`, { subnetId: sid }); rerender() } }) }, 'Associate subnet'),
            t.main ? null : h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/network/route-tables/${t.id}`); rerender() }) }, 'Delete')))),
        h('h3', {}, 'Elastic IPs ($0.005 / hour while allocated)'), h('div', { class: 'nw-row' }, h('button', { onclick: act(async () => { await api('POST', '/api/network/eips', {}); rerender() }) }, 'Allocate Elastic IP')),
        elasticIps.map((e) => h('div', { class: 'nw-row' }, h('code', {}, e.ip), e.instanceId ? `→ ${e.instanceId}` : 'unassociated',
          e.instanceId ? h('button', { class: 'sec', onclick: act(async () => { await api('POST', `/api/network/eips/${e.id}/disassociate`, {}); rerender() }) }, 'Disassociate') : [h('button', { class: 'sec', onclick: act(async () => { const i = await promptDialog('Associate with which instance id?', ''); if (i) { await api('POST', `/api/network/eips/${e.id}/associate`, { instanceId: i }); rerender() } }) }, 'Associate'), h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/network/eips/${e.id}`); rerender() }) }, 'Release')])))
    }

    if (tab === 'test') {
      const { instances } = await api('GET', '/api/compute/instances')
      const opts = [['', 'Choose…'], ...instances.map((i) => [i.id, `${i.name} (${i.privateIp ?? i.ip}${i.publicIp ? ` / ${i.publicIp}` : ''})`])]
      const from = sel(opts, '', 'Source'), to = sel(opts, '', 'Destination'), fromIp = h('input', { placeholder: 'or an IPv4 address', 'aria-label': 'Source IP' }), toIp = h('input', { placeholder: 'or an IPv4 address', 'aria-label': 'Destination IP' })
      const proto = sel([['tcp', 'tcp'], ['udp', 'udp'], ['icmp', 'icmp']], 'tcp', 'Protocol'), port = h('input', { type: 'number', value: '443', min: '0', max: '65535', 'aria-label': 'Port', style: { width: '90px' } })
      const out = h('div', { 'aria-live': 'polite' })
      put(body, h('p', { class: 'muted' }, 'Evaluates routing, the source\'s outbound rules and the destination\'s inbound rules — and tells you which rule matched, or why traffic is denied.'),
        h('div', { class: 'nw-form' }, field('From', from), field('…or IP', fromIp), field('To', to), field('…or IP', toIp), field('Protocol', proto), field('Port', port)),
        h('div', { class: 'nw-row' }, h('button', { onclick: async () => {
          try {
            const r = await api('POST', '/api/network/check', { from: from.value || fromIp.value, to: to.value || toIp.value, protocol: proto.value, port: proto.value === 'icmp' ? undefined : Number(port.value) })
            fill(out, h('div', { class: `nw-result ${r.allowed ? 'allowed' : 'denied'}` }, h('b', { class: r.allowed ? 'nw-ok' : 'nw-bad' }, r.allowed ? '✓ Allowed' : '✗ Denied'), ` — ${r.reason}`,
              h('ul', {}, r.steps.map((st) => h('li', {}, `${st.step}: `, h('span', { class: st.ok ? 'nw-ok' : 'nw-bad' }, st.ok ? 'ok' : 'blocked'), st.note ? ` (${st.note})` : '', st.matched?.length ? ` — matched ${st.matched.map((m) => `${m.sg}/${m.rule}`).join(', ')}` : '')))))
          } catch (e) { fill(out, err(e)) }
        } }, 'Test connectivity')), out)
    }
    void toast
  },
}
