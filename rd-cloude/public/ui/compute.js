import { lineChart, legend } from '/charts.js'

const put = (el, ...kids) => el.append(...kids.flat(Infinity).filter((x) => x != null && x !== false))
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((x) => x != null && x !== false))
const TABS = [['instances', 'Instances'], ['volumes', 'Volumes'], ['asg', 'Autoscaling'], ['lb', 'Load balancers'], ['keys', 'Key pairs']]

export default {
  id: 'compute', title: 'Compute', group: 'Cloud', order: 10,
  async render(el, arg, lib) {
    const { h, api, act, toast, rerender, confirmDialog, promptDialog, download, fmtBytes, fmtDate } = lib
    const [tabArg, extra] = (arg ?? '').split('/')
    const tab = tabArg === 'i' ? 'detail' : TABS.some(([id]) => id === tabArg) ? tabArg : 'instances'
    put(el, h('h1', {}, 'Compute'), h('div', { class: 'cp-banner', role: 'note' }, h('b', {}, 'Simulated control plane. '), 'No real virtual machines are created: state machines, quotas, networking rules and billing are real, but CPU/memory/network metrics are synthetic and consoles are generated.'),
      h('nav', { class: 'cp-tabs', 'aria-label': 'Compute sections' }, TABS.map(([id, label]) => h('a', { href: `#compute/${id}`, 'aria-current': id === tab || (tab === 'detail' && id === 'instances') ? 'page' : null }, label))))
    const body = h('div'); el.append(body)
    const err = (e) => h('div', { class: 'cp-err', role: 'alert' }, e.message)
    const badge = (s) => h('span', { class: `cp-badge cp-${s}` }, s)
    const dlg = (title, build) => {
      const d = h('dialog', { class: 'cp-dlg', 'aria-label': title }); const close = () => { d.close(); d.remove() }
      d.addEventListener('cancel', close); put(d, h('h3', {}, title), build(close)); document.body.append(d); d.showModal(); return close
    }
    const field = (label, input) => h('label', {}, label, input)
    const sel = (opts, value, aria) => h('select', { 'aria-label': aria }, opts.map(([v, l]) => h('option', { value: v, selected: v === value ? true : null }, l)))

    /* ------------------------------------------------------------------ instance detail */
    if (tab === 'detail') {
      const i = await api('GET', `/api/compute/instances/${extra}`).catch(() => null)
      if (!i) { put(body, h('p', { class: 'muted' }, 'Instance not found.')); return }
      const base = `/api/compute/instances/${i.id}`
      const [metrics, con] = await Promise.all([api('GET', `${base}/metrics?window=1h`), api('GET', `${base}/console`)])
      const act1 = (path, label, body) => h('button', { class: 'sec', onclick: act(async () => { await api('POST', `${base}/${path}`, body ?? {}); rerender() }) }, label)
      const tagsBox = h('textarea', { 'aria-label': 'Tags (key=value per line)', rows: 4 }); tagsBox.value = Object.entries(i.tags).map(([k, v]) => `${k}=${v}`).join('\n')
      put(body, h('p', {}, h('a', { href: '#compute/instances' }, '← Instances')),
        h('div', { class: 'cp-row' }, h('h2', { style: { margin: 0 } }, i.name), badge(i.state)),
        h('div', { class: 'cp-grid' }, [['Type', `${i.type} (${i.vcpu} vCPU, ${i.memGb} GB)`], ['Image', i.image], ['Zone', i.az], ['Private IP', i.privateIp ?? i.ip], ['Public IP', i.publicIp ?? '—'], ['Hours running', i.hoursRunning], ['Key pair', i.keyName ?? '—'], ['ID', i.id]].map(([k, v]) => h('div', { class: 'cp-stat' }, h('b', {}, String(v)), h('span', {}, k)))),
        h('div', { class: 'cp-actions' }, i.state === 'running' ? [act1('stop', 'Stop'), act1('reboot', 'Reboot')] : null, i.state === 'stopped' ? [act1('start', 'Start'), h('button', { class: 'sec', onclick: act(async () => { const t = await promptDialog('New instance type (small, medium, large)', i.type); if (t) { await api('POST', `${base}/resize`, { type: t }); rerender() } }) }, 'Resize')] : null,
          i.state !== 'terminated' ? h('button', { class: 'sec', onclick: act(async () => { if (await confirmDialog(`Terminate ${i.name}? This cannot be undone.`, 'Terminate')) { await api('POST', `${base}/terminate`, {}); rerender() } }) }, 'Terminate') : null),
        h('h3', {}, 'CPU and network (last hour, synthetic)'),
        metrics.series.length ? [lineChart([{ name: 'CPU %', points: metrics.series.map((p) => ({ x: p.t.slice(11, 16), y: p.cpu })) }, { name: 'Memory %', points: metrics.series.map((p) => ({ x: p.t.slice(11, 16), y: p.memory })) }], { title: `${i.name}: CPU and memory utilisation`, max: 100, format: (v) => `${v}%` }), legend(h, ['CPU %', 'Memory %']),
          lineChart([{ name: 'Network in', points: metrics.series.map((p) => ({ x: p.t.slice(11, 16), y: p.netIn / 1e6 })) }, { name: 'Network out', points: metrics.series.map((p) => ({ x: p.t.slice(11, 16), y: p.netOut / 1e6 })) }], { title: `${i.name}: network throughput in MB per minute`, format: (v) => `${(+v.toFixed(1))} MB` }), legend(h, ['Network in', 'Network out'])] : h('p', { class: 'muted' }, 'No samples: the instance is not running.'),
        h('h3', {}, 'Tags'), tagsBox, h('div', { class: 'cp-row' }, h('button', { onclick: act(async () => { const tags = {}; for (const line of tagsBox.value.split('\n')) { const m = /^\s*([^=\s]+)\s*=\s*(.*)$/.exec(line); if (m) tags[m[1]] = m[2] } await api('PATCH', base, { tags }); toast('Tags saved', 'info') }) }, 'Save tags')),
        h('h3', {}, 'Volumes'), i.volumes.length ? i.volumes.map((v) => h('div', {}, `${v.device} — ${v.sizeGb} GB (${v.id})`)) : h('p', { class: 'muted' }, 'None attached.'),
        h('h3', {}, 'Serial console (simulated)'), h('pre', { class: 'cp-console', tabindex: 0, 'aria-label': 'Serial console output' }, con.lines.join('\n') || '(empty)'),
        h('h3', {}, 'Events'), h('table', { class: 'cp-table' }, h('tbody', {}, i.events.slice().reverse().map((e) => h('tr', {}, h('td', {}, fmtDate(e.ts)), h('td', {}, badge(e.state)), h('td', {}, e.reason)))))
      )
      return
    }

    /* ------------------------------------------------------------------ instances */
    if (tab === 'instances') {
      const [{ instances }, { images }, { regions }, { keyPairs }, { subnets }, { types }] = await Promise.all([api('GET', '/api/compute/instances'), api('GET', '/api/compute/images'), api('GET', '/api/compute/regions'), api('GET', '/api/compute/keypairs'), api('GET', '/api/network/subnets'), api('GET', '/api/compute/types')])
      const nameFilter = h('input', { type: 'search', placeholder: 'Filter by name…', 'aria-label': 'Filter by name' })
      const table = h('div')
      const paint = () => {
        const q = nameFilter.value.toLowerCase()
        const list = instances.filter((i) => i.name.toLowerCase().includes(q))
        fill(table, list.length ? h('table', { class: 'cp-table' }, h('thead', {}, h('tr', {}, ['Name', 'State', 'Type', 'Zone', 'IP', 'Tags', ''].map((x) => h('th', {}, x)))),
          h('tbody', {}, list.map((i) => h('tr', {}, h('td', {}, h('a', { href: `#compute/i/${i.id}` }, i.name)), h('td', {}, badge(i.state)), h('td', {}, i.type), h('td', {}, i.az), h('td', {}, i.publicIp ?? i.privateIp ?? i.ip), h('td', {}, Object.entries(i.tags).map(([k, v]) => `${k}=${v}`).join(', ')),
            h('td', { class: 'cp-actions' }, i.state === 'running' ? h('button', { class: 'sec', onclick: act(async () => { await api('POST', `/api/compute/instances/${i.id}/stop`, {}); rerender() }) }, 'Stop') : null, i.state === 'stopped' ? h('button', { class: 'sec', onclick: act(async () => { await api('POST', `/api/compute/instances/${i.id}/start`, {}); rerender() }) }, 'Start') : null,
              h('button', { class: 'sec', onclick: act(async () => { if (await confirmDialog(`Terminate ${i.name}?`, 'Terminate')) { await api('POST', `/api/compute/instances/${i.id}/terminate`, {}); rerender() } }) }, 'Terminate')))))) : h('p', { class: 'muted' }, 'No instances. Launch one to get started.'))
      }
      nameFilter.addEventListener('input', paint)
      put(body, h('div', { class: 'cp-row' }, h('button', { onclick: () => launchDialog() }, 'Launch instance'), nameFilter), table); paint()

      function launchDialog() {
        dlg('Launch an instance (simulated)', (close) => {
          const name = h('input', { placeholder: 'web-1', 'aria-label': 'Name', maxlength: 63 }), type = sel(types.map((t) => [t.id, `${t.id} — ${t.vcpu} vCPU, ${t.memGb} GB ($${t.pricePerHour}/h)`]), 'small', 'Instance type'), image = sel(images.map((x) => [x.id, x.name]), 'rd-linux-2026', 'Image')
          const region = sel(regions.map((x) => [x.id, x.name]), 'rd-east-1', 'Region'), az = sel(regions[0].availabilityZones.map((z) => [z, z]), regions[0].availabilityZones[0], 'Availability zone')
          region.addEventListener('change', () => { const rg = regions.find((x) => x.id === region.value); fill(az, rg.availabilityZones.map((z) => h('option', { value: z }, z))) })
          const key = sel([['', 'No key pair'], ...keyPairs.map((k) => [k.id, k.name])], '', 'Key pair'), subnet = sel([['', 'No VPC (default networking)'], ...subnets.map((s) => [s.id, `${s.name} ${s.cidr} (${s.az})`])], '', 'Subnet')
          const sgBox = h('div'); let sgs = []
          subnet.addEventListener('change', async () => { fill(sgBox); if (!subnet.value) return; const s = subnets.find((x) => x.id === subnet.value); sgs = (await api('GET', `/api/network/security-groups?vpcId=${s.vpcId}`)).securityGroups; put(sgBox, h('div', { class: 'muted' }, 'Security groups'), sgs.map((g) => h('label', {}, h('input', { type: 'checkbox', value: g.id, checked: g.isDefault ? true : null }), ` ${g.name}`, ' '))) })
          const tags = h('textarea', { rows: 3, placeholder: 'env=prod\nworkload=web', 'aria-label': 'Tags' }), ud = h('textarea', { rows: 3, placeholder: '#!/bin/sh', 'aria-label': 'User data' })
          const msg = h('div')
          return h('div', {}, h('div', { class: 'cp-form' }, field('Name', name), field('Type', type), field('Image', image), field('Region', region), field('Zone', az), field('Key pair', key), field('Subnet', subnet)), sgBox, h('div', { class: 'cp-form' }, field('Tags (key=value per line)', tags), field('User data', ud)), msg,
            h('div', { class: 'cp-row' }, h('button', { class: 'sec', onclick: close }, 'Cancel'), h('button', { onclick: async () => {
              const t = {}; for (const line of tags.value.split('\n')) { const m = /^\s*([^=\s]+)\s*=\s*(.*)$/.exec(line); if (m) t[m[1]] = m[2] }
              const body = { name: name.value, type: type.value, image: image.value, region: region.value, az: az.value, tags: t }
              if (key.value) body.keyPairId = key.value; if (ud.value) body.userData = ud.value
              if (subnet.value) { body.subnetId = subnet.value; body.securityGroupIds = [...sgBox.querySelectorAll('input:checked')].map((c) => c.value) }
              try { const r = await api('POST', '/api/compute/instances', body); close(); location.hash = `#compute/i/${r.id}` } catch (e) { fill(msg, err(e)) }
            } }, 'Launch'))) })
      }
    }

    /* ------------------------------------------------------------------ volumes */
    if (tab === 'volumes') {
      const [{ volumes }, { snapshots }, { instances }] = await Promise.all([api('GET', '/api/compute/volumes'), api('GET', '/api/compute/snapshots'), api('GET', '/api/compute/instances')])
      const size = h('input', { type: 'number', min: '1', max: '16384', value: '10', 'aria-label': 'Size in GB', style: { width: '100px' } }), az = sel([['rd-east-1a', 'rd-east-1a'], ['rd-east-1b', 'rd-east-1b'], ['rd-east-1c', 'rd-east-1c'], ['rd-west-1a', 'rd-west-1a'], ['rd-eu-1a', 'rd-eu-1a']], 'rd-east-1a', 'Zone'), vname = h('input', { placeholder: 'name (optional)', 'aria-label': 'Volume name' })
      put(body, h('div', { class: 'cp-row' }, vname, field('GB', size), az, h('button', { onclick: act(async () => { await api('POST', '/api/compute/volumes', { sizeGb: Number(size.value), az: az.value, name: vname.value || undefined }); rerender() }) }, 'Create volume')),
        volumes.length ? h('table', { class: 'cp-table' }, h('thead', {}, h('tr', {}, ['Volume', 'Size', 'Zone', 'State', 'Attached to', ''].map((x) => h('th', {}, x)))), h('tbody', {}, volumes.map((v) => h('tr', {}, h('td', {}, v.name ?? v.id), h('td', {}, `${v.sizeGb} GB`), h('td', {}, v.az), h('td', {}, badge(v.state)), h('td', {}, v.attachment ? `${instances.find((i) => i.id === v.attachment.instanceId)?.name ?? v.attachment.instanceId} (${v.attachment.device})` : '—'),
          h('td', { class: 'cp-actions' }, v.state === 'available' ? h('button', { class: 'sec', onclick: act(async () => { const cands = instances.filter((i) => i.az === v.az); if (!cands.length) throw new Error(`No instance in ${v.az}`); const id = await promptDialog(`Attach to which instance id?\n${cands.map((i) => `${i.name}: ${i.id}`).join('\n')}`, cands[0].id); if (id) { await api('POST', `/api/compute/volumes/${v.id}/attach`, { instanceId: id }); rerender() } }) }, 'Attach') : h('button', { class: 'sec', onclick: act(async () => { await api('POST', `/api/compute/volumes/${v.id}/detach`, {}); rerender() }) }, 'Detach'),
            h('button', { class: 'sec', onclick: act(async () => { const n = await promptDialog('New size in GB (must be larger)', String(v.sizeGb + 10)); if (n) { await api('POST', `/api/compute/volumes/${v.id}/resize`, { sizeGb: Number(n) }); rerender() } }) }, 'Grow'),
            h('button', { class: 'sec', onclick: act(async () => { await api('POST', `/api/compute/volumes/${v.id}/snapshots`, {}); toast('Snapshot created', 'info'); rerender() }) }, 'Snapshot'),
            h('button', { class: 'sec', disabled: v.state === 'in-use' ? true : null, onclick: act(async () => { if (await confirmDialog('Delete this volume?', 'Delete')) { await api('DELETE', `/api/compute/volumes/${v.id}`); rerender() } }) }, 'Delete')))))) : h('p', { class: 'muted' }, 'No volumes.'),
        h('h3', {}, 'Snapshots'), snapshots.length ? h('table', { class: 'cp-table' }, h('tbody', {}, snapshots.map((s) => h('tr', {}, h('td', {}, s.id), h('td', {}, `${s.sizeGb} GB`), h('td', {}, fmtDate(s.createdAt)), h('td', { class: 'cp-actions' }, h('button', { class: 'sec', onclick: act(async () => { await api('POST', '/api/compute/volumes', { snapshotId: s.id, az: 'rd-east-1a' }); rerender() }) }, 'Restore to volume'), h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/compute/snapshots/${s.id}`); rerender() }) }, 'Delete')))))) : h('p', { class: 'muted' }, 'No snapshots.'))
    }

    /* ------------------------------------------------------------------ autoscaling */
    if (tab === 'asg') {
      const { autoScalingGroups: groups } = await api('GET', '/api/compute/asgs')
      const f = { name: h('input', { placeholder: 'web-asg', 'aria-label': 'Group name' }), type: sel([['small', 'small'], ['medium', 'medium'], ['large', 'large']], 'small', 'Type'), min: h('input', { type: 'number', value: '1', min: '0', 'aria-label': 'Min' }), max: h('input', { type: 'number', value: '3', min: '0', 'aria-label': 'Max' }), desired: h('input', { type: 'number', value: '1', min: '0', 'aria-label': 'Desired' }), cpu: h('input', { type: 'number', value: '50', min: '10', max: '90', 'aria-label': 'Target CPU' }), wl: sel([['', 'default'], ['idle', 'idle (4%)'], ['web', 'web (28%)'], ['batch', 'batch (72%)']], '', 'Simulated workload') }
      put(body, h('p', { class: 'muted' }, 'Target tracking on the simulated CPU: scale out above target+10%, scale in below target−20%, one step per cooldown. Unhealthy members are replaced.'),
        h('div', { class: 'cp-form' }, field('Name', f.name), field('Type', f.type), field('Min', f.min), field('Max', f.max), field('Desired', f.desired), field('Target CPU %', f.cpu), field('Simulated workload', f.wl)),
        h('div', { class: 'cp-row' }, h('button', { onclick: act(async () => { await api('POST', '/api/compute/asgs', { name: f.name.value, minSize: Number(f.min.value), maxSize: Number(f.max.value), desired: Number(f.desired.value), targetCpu: Number(f.cpu.value), template: { type: f.type.value, tags: f.wl.value ? { workload: f.wl.value } : {} } }); rerender() }) }, 'Create group')),
        groups.map((g) => h('div', { class: 'cp-stat', style: { margin: '8px 0' } }, h('div', { class: 'cp-row' }, h('b', {}, g.name), h('span', {}, `min ${g.minSize} · desired ${g.desired} · max ${g.maxSize} · target ${g.targetCpu}% · avg CPU ${g.averageCpu ?? '—'}%`), h('button', { class: 'sec', onclick: act(async () => { if (await confirmDialog(`Delete group ${g.name} and terminate its instances?`, 'Delete')) { await api('DELETE', `/api/compute/asgs/${g.id}`); rerender() } }) }, 'Delete')),
          h('div', {}, g.members.map((m) => h('span', {}, h('a', { href: `#compute/i/${m.id}` }, m.name ?? m.id), ' ', badge(m.state), ' '))), h('div', { class: 'muted' }, g.activity.slice(0, 5).map((a) => h('div', {}, `${fmtDate(a.at)} — ${a.message}`))))))
    }

    /* ------------------------------------------------------------------ load balancers */
    if (tab === 'lb') {
      const [{ loadBalancers: lbs }, { instances }] = await Promise.all([api('GET', '/api/compute/load-balancers'), api('GET', '/api/compute/instances')])
      const name = h('input', { placeholder: 'public-web', 'aria-label': 'Load balancer name' }), port = h('input', { type: 'number', value: '80', 'aria-label': 'Target port', style: { width: '90px' } })
      put(body, h('div', { class: 'cp-row' }, name, field('Target port', port), h('button', { onclick: act(async () => { await api('POST', '/api/compute/load-balancers', { name: name.value, targetGroup: { port: Number(port.value) } }); rerender() }) }, 'Create load balancer')),
        lbs.map((lb) => h('div', { class: 'cp-stat', style: { margin: '8px 0' } }, h('div', { class: 'cp-row' }, h('b', {}, lb.name), h('code', {}, lb.dnsName), h('span', { class: 'muted' }, `listeners ${lb.listeners.map((l) => `${l.protocol}:${l.port}`).join(', ')} → port ${lb.targetGroup.port} (${lb.targetGroup.healthCheck.path})`),
          h('button', { class: 'sec', onclick: act(async () => { const id = await promptDialog(`Register which instance id?\n${instances.map((i) => `${i.name}: ${i.id}`).join('\n')}`, instances[0]?.id ?? ''); if (id) { await api('POST', `/api/compute/load-balancers/${lb.id}/targets`, { instanceId: id }); rerender() } }) }, 'Register target'),
          h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/compute/load-balancers/${lb.id}`); rerender() }) }, 'Delete')),
          lb.targets.length ? h('table', { class: 'cp-table' }, h('tbody', {}, lb.targets.map((t) => h('tr', {}, h('td', {}, instances.find((i) => i.id === t.instanceId)?.name ?? t.instanceId), h('td', {}, badge(t.health.state)), h('td', { class: 'muted' }, t.health.reason ?? ''), h('td', {}, h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/compute/load-balancers/${lb.id}/targets/${t.instanceId}`); rerender() }) }, 'Deregister')))))) : h('p', { class: 'muted' }, 'No targets registered.'))))
    }

    /* ------------------------------------------------------------------ key pairs */
    if (tab === 'keys') {
      const { keyPairs } = await api('GET', '/api/compute/keypairs')
      const name = h('input', { placeholder: 'my-key', 'aria-label': 'Key pair name' })
      put(body, h('div', { class: 'cp-row' }, name, h('button', { onclick: act(async () => {
        const k = await api('POST', '/api/compute/keypairs', { name: name.value })
        dlg('Save your private key now', (close) => h('div', {}, h('p', {}, 'This is the only time the private key is shown. It is not stored by RD Cloude.'), h('pre', { class: 'cp-key' }, k.privateKey),
          h('div', { class: 'cp-row' }, h('button', { onclick: () => download(new Blob([k.privateKey], { type: 'text/plain' }), `${k.name}.pem`) }, 'Download .pem'), h('button', { class: 'sec', onclick: () => { close(); rerender() } }, 'I have saved it'))))
      }) }, 'Create key pair')),
        keyPairs.length ? h('table', { class: 'cp-table' }, h('thead', {}, h('tr', {}, ['Name', 'Fingerprint', 'Public key', ''].map((x) => h('th', {}, x)))), h('tbody', {}, keyPairs.map((k) => h('tr', {}, h('td', {}, k.name), h('td', {}, h('code', {}, k.fingerprint)), h('td', {}, h('code', {}, `${k.publicKey.slice(0, 40)}…`)), h('td', {}, h('button', { class: 'sec', onclick: act(async () => { await api('DELETE', `/api/compute/keypairs/${k.id}`); rerender() }) }, 'Delete')))))) : h('p', { class: 'muted' }, 'No key pairs.'))
    }
    void fmtBytes
  },
}
