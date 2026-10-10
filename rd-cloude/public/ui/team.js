// Organizations: members, roles, invitations, ownership. Backend: src/modules/orgs.js (docs/security.md).
// DOM is built with h() only (no innerHTML, no inline styles).

const RANK = { viewer: 0, member: 1, admin: 2, owner: 3 }
const ROLE_HELP = {
  owner: 'Full control, including deleting the organization',
  admin: 'Manage members and invitations',
  member: 'Create and edit shared resources',
  viewer: 'Read-only access',
}

function kit(lib) {
  const { h } = lib
  const uid = () => `team-${Math.random().toString(36).slice(2, 9)}`
  const card = (title, ...kids) => h('section', { class: 'team-card' }, title ? h('h2', { class: 'team-h' }, title) : null, ...kids)
  const field = (label, input, hint) => {
    input.id = input.id || uid()
    return h('div', { class: 'team-field' }, h('label', { for: input.id }, label), input, hint ? h('small', { class: 'team-muted' }, hint) : null)
  }
  const msg = () => h('p', { class: 'team-msg', role: 'status', 'aria-live': 'polite' })
  const say = (m, text, kind = 'info') => { m.textContent = text ?? ''; m.className = `team-msg team-${kind}` }
  const badge = (text, kind = 'muted') => h('span', { class: `team-badge team-${kind}` }, text)
  const run = (m, fn) => async (e) => {
    e?.preventDefault?.()
    say(m, '')
    try { await fn(e) } catch (err) { say(m, err.message, 'bad') }
  }
  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); lib.toast('Copied') } catch { lib.toast('Copy failed: select the text and copy it manually', 'error') }
  }
  const table = (head, rows) => {
    for (const tr of rows) [...tr.children].forEach((td, i) => td.setAttribute('data-label', head[i] ?? ''))
    return h('div', { class: 'team-scroll' }, h('table', { class: 'team-table' },
      h('thead', {}, h('tr', {}, ...head.map((x) => h('th', { scope: 'col' }, x)))), h('tbody', {}, ...rows)))
  }
  const roleBadge = (role) => badge(role, role === 'owner' ? 'ok' : role === 'admin' ? 'warn' : 'muted')
  return { h, card, field, msg, say, badge, run, copy, table, roleBadge }
}

/* ------------------------------------------------------------------ list */
async function listView(el, lib, k) {
  const { h } = k
  const [{ organizations }, inv] = await Promise.all([lib.api('GET', '/api/orgs'), lib.api('GET', '/api/orgs/invites')])
  const m = k.msg()
  const name = h('input', { name: 'name', minlength: 2, maxlength: 64, required: true, placeholder: 'e.g. Acme Engineering', autocomplete: 'organization' })
  const answer = (id, accept) => k.run(m, async () => {
    const r = await lib.api('POST', `/api/orgs/invites/${id}/${accept ? 'accept' : 'decline'}`)
    lib.toast(accept ? 'Invitation accepted' : 'Invitation declined')
    if (accept) location.hash = `#team/${r.id}`
    else lib.rerender()
  })
  el.append(h('div', { class: 'team-root' },
    h('h1', {}, 'Team'),
    h('p', { class: 'team-muted' }, 'Organizations hold the people you work with and the role each has (owner, admin, member, viewer). Roles are enforced by the platform; individual services opt in to sharing resources with an organization, so check each service for what is shared today.'),
    inv.invites.length ? k.card('Invitations for you', k.table(['Organization', 'Role', 'Invited by', ''], inv.invites.map((i) => h('tr', {},
      h('td', {}, h('strong', {}, i.orgName ?? 'Unknown')), h('td', {}, k.roleBadge(i.role)), h('td', {}, i.invitedBy ?? ''),
      h('td', { class: 'team-actions' }, h('button', { type: 'button', onclick: answer(i.id, true) }, 'Accept'), h('button', { class: 'sec', type: 'button', onclick: answer(i.id, false) }, 'Decline')))))) : null,
    !inv.emailVerified ? h('p', { class: 'team-muted' }, 'Verify your email address (Security > Overview) to see invitations addressed to it here. Invitation links you received by email work regardless.') : null,
    k.card('Your organizations', organizations.length
      ? h('ul', { class: 'team-orgs' }, ...organizations.map((o) => h('li', {}, h('a', { class: 'team-org', href: `#team/${o.id}` },
        h('strong', {}, o.name), h('span', { class: 'team-muted' }, `${o.memberCount} member${o.memberCount === 1 ? '' : 's'}`), k.roleBadge(o.role)))))
      : h('p', { class: 'team-muted' }, 'You are not in any organization yet.')),
    k.card('Create an organization', h('form', { class: 'team-form', onsubmit: k.run(m, async () => {
      const o = await lib.api('POST', '/api/orgs', { name: name.value })
      location.hash = `#team/${o.id}`
    }) }, k.field('Name', name), h('div', { class: 'team-actions' }, h('button', { type: 'submit' }, 'Create'), m))),
  ))
}

/* ------------------------------------------------------------------ invitation landing: #team/invite/<token> */
async function inviteView(el, token, lib, k) {
  const { h } = k
  const m = k.msg()
  const box = h('div', { class: 'team-root' }, h('h1', {}, 'Invitation'))
  el.append(box)
  try {
    const p = await lib.api('POST', '/api/orgs/invites/preview', { token })
    const reply = (accept) => k.run(m, async () => {
      const r = await lib.api('POST', `/api/orgs/invites/${accept ? 'accept' : 'decline'}`, { token })
      lib.toast(accept ? `Welcome to ${p.orgName}` : 'Invitation declined')
      location.hash = accept ? `#team/${r.id}` : '#team'
    })
    box.append(k.card(null, h('p', {}, h('strong', {}, p.invitedBy ?? 'Someone'), ' invited you to join ', h('strong', {}, p.orgName ?? 'an organization'), ' as ', k.roleBadge(p.role), '.'),
      h('p', { class: 'team-muted' }, ROLE_HELP[p.role]),
      h('div', { class: 'team-actions' }, h('button', { type: 'button', onclick: reply(true) }, 'Accept'), h('button', { class: 'sec', type: 'button', onclick: reply(false) }, 'Decline'), m)))
  } catch (e) {
    box.append(k.card(null, h('p', { role: 'alert', class: 'team-bad' }, e.message), h('a', { class: 'team-link', href: '#team' }, 'Back to Team')))
  }
}

/* ------------------------------------------------------------------ organization detail */
async function orgView(el, id, lib, k) {
  const { h } = k
  const [{ user: me }, org, tfa] = await Promise.all([lib.api('GET', '/api/me'), lib.api('GET', `/api/orgs/${encodeURIComponent(id)}`), lib.api('GET', '/api/auth/2fa').catch(() => ({ enabled: false }))])
  const myRole = org.role
  const rank = RANK[myRole]
  const isAdmin = rank >= RANK.admin
  const isOwner = myRole === 'owner'
  const m = k.msg()
  const refresh = () => lib.rerender()
  const grantable = isOwner ? ['viewer', 'member', 'admin'] : ['viewer', 'member']
  let loadInvites = async () => {}

  const memberRows = org.members.map((p) => {
    const self = p.userId === me.id
    const editable = isAdmin && !self && p.role !== 'owner' && (isOwner || RANK[p.role] < RANK.admin)
    const removable = isAdmin && !self && p.role !== 'owner' && RANK[p.role] < rank
    const roleCell = editable
      ? h('select', { 'aria-label': `Role of ${p.name ?? p.email}`, onchange: (e) => k.run(m, async () => {
        await lib.api('PATCH', `/api/orgs/${org.id}/members/${p.userId}`, { role: e.target.value })
        lib.toast('Role updated')
        refresh()
      })(e) }, ...grantable.map((r) => h('option', { value: r, selected: r === p.role }, r)))
      : k.roleBadge(p.role)
    return h('tr', {},
      h('td', {}, h('strong', {}, p.name ?? '(deleted user)'), self ? [' ', k.badge('you', 'muted')] : null, h('div', { class: 'team-muted' }, p.email ?? '')),
      h('td', {}, roleCell), h('td', {}, lib.fmtDate(p.joinedAt)),
      h('td', {}, removable ? h('button', { class: 'sec', type: 'button', onclick: k.run(m, async () => {
        if (!(await lib.confirmDialog(`Remove ${p.name ?? p.email} from ${org.name}?`, 'Remove'))) return
        await lib.api('DELETE', `/api/orgs/${org.id}/members/${p.userId}`)
        refresh()
      }) }, 'Remove') : null))
  })

  const sections = [
    h('a', { class: 'team-link', href: '#team' }, '< All organizations'),
    h('h1', {}, org.name, ' ', k.roleBadge(myRole)),
    h('p', { class: 'team-muted' }, ROLE_HELP[myRole]),
    k.card(`Members (${org.members.length})`, k.table(['Member', 'Role', 'Joined', ''], memberRows), m),
  ]

  if (isAdmin) {
    const im = k.msg()
    const email = h('input', { type: 'email', name: 'email', required: true, maxlength: 254, autocomplete: 'off', placeholder: 'colleague@example.com' })
    const role = h('select', { name: 'role' }, ...grantable.map((r) => h('option', { value: r, selected: r === 'member' }, `${r} - ${ROLE_HELP[r]}`)))
    const result = h('div', {})
    const invBox = h('div', {})
    sections.push(k.card('Invite someone',
      h('form', { class: 'team-form', onsubmit: k.run(im, async (e) => {
        const r = await lib.api('POST', `/api/orgs/${org.id}/invites`, { email: email.value, role: role.value })
        result.replaceChildren(h('div', { class: 'team-note' }, h('strong', {}, `Invitation sent to ${r.invite.email}.`),
          h('p', { class: 'team-muted' }, 'If email is not configured on this server, share this link with them yourself. It only works when signed in as that address.'),
          h('div', { class: 'team-secret' }, h('code', {}, r.inviteUrl.startsWith('http') ? r.inviteUrl : `${location.origin}${r.inviteUrl}`), h('button', { class: 'sec', type: 'button', onclick: () => k.copy(r.inviteUrl.startsWith('http') ? r.inviteUrl : `${location.origin}${r.inviteUrl}`) }, 'Copy'))))
        e.target.reset()
        await loadInvites()
      }) }, k.field('Email address', email), k.field('Role', role), h('div', { class: 'team-actions' }, h('button', { type: 'submit' }, 'Send invitation'), im)),
      result, invBox))
    loadInvites = async () => {
      const { invites } = await lib.api('GET', `/api/orgs/${org.id}/invites`)
      invBox.replaceChildren(...(invites.length ? [h('div', {}, h('h3', { class: 'team-h3' }, 'Pending invitations'), k.table(['Email', 'Role', 'Expires', ''], invites.map((i) => h('tr', {},
        h('td', {}, i.email), h('td', {}, k.roleBadge(i.role)), h('td', {}, lib.fmtDate(i.expiresAt)),
        h('td', {}, h('button', { class: 'sec', type: 'button', onclick: k.run(im, async () => { await lib.api('DELETE', `/api/orgs/${org.id}/invites/${i.id}`); await loadInvites() }) }, 'Revoke'))))))] : []))
    }
  }

  // settings
  const settings = []
  if (isAdmin) {
    const rm = k.msg()
    const name = h('input', { name: 'name', value: org.name, minlength: 2, maxlength: 64, required: true })
    settings.push(h('form', { class: 'team-form', onsubmit: k.run(rm, async () => { await lib.api('PATCH', `/api/orgs/${org.id}`, { name: name.value }); lib.toast('Renamed'); refresh() }) },
      k.field('Organization name', name), h('div', { class: 'team-actions' }, h('button', { type: 'submit' }, 'Rename'), rm)))
  }
  if (!isOwner) {
    const lm = k.msg()
    settings.push(h('div', { class: 'team-actions' }, h('button', { class: 'sec', type: 'button', onclick: k.run(lm, async () => {
      if (!(await lib.confirmDialog(`Leave ${org.name}? You will lose access to what it shares.`, 'Leave'))) return
      await lib.api('POST', `/api/orgs/${org.id}/leave`)
      location.hash = '#team'
    }) }, 'Leave organization'), lm))
  }
  const secrets = (label) => {
    const pw = h('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password', maxlength: 256 })
    const code = h('input', { name: 'code', autocomplete: 'one-time-code', maxlength: 16, required: true })
    return { pw, code, fields: [k.field(label, pw), tfa.enabled ? k.field('Authenticator or recovery code', code) : null], body: (extra = {}) => ({ ...extra, password: pw.value, ...(tfa.enabled ? { code: code.value } : {}) }) }
  }
  if (isOwner) {
    const others = org.members.filter((p) => p.userId !== me.id)
    const tm = k.msg()
    const target = h('select', { name: 'userId', required: true }, h('option', { value: '' }, others.length ? 'Choose a member' : 'No other members yet'), ...others.map((p) => h('option', { value: p.userId }, `${p.name ?? ''} <${p.email ?? ''}>`)))
    const t = secrets('Your password')
    settings.push(h('details', {}, h('summary', {}, 'Transfer ownership'),
      h('p', { class: 'team-muted' }, 'The new owner gets full control. You become an admin.'),
      h('form', { class: 'team-form', onsubmit: k.run(tm, async () => {
        if (!target.value) throw new Error('Choose a member first')
        if (!(await lib.confirmDialog('Transfer ownership of this organization?', 'Transfer'))) return
        await lib.api('POST', `/api/orgs/${org.id}/transfer`, t.body({ userId: target.value }))
        lib.toast('Ownership transferred')
        refresh()
      }) }, k.field('New owner', target), ...t.fields, h('div', { class: 'team-actions' }, h('button', { type: 'submit' }, 'Transfer'), tm))))
    const dm = k.msg()
    const d = secrets('Your password')
    settings.push(h('details', {}, h('summary', {}, 'Delete organization'),
      h('p', { class: 'team-muted' }, 'Removes the organization, its memberships and invitations for everyone. Services drop what they shared with it.'),
      h('form', { class: 'team-form', onsubmit: k.run(dm, async () => {
        if (!(await lib.confirmDialog(`Delete ${org.name} for all ${org.members.length} member(s)?`, 'Delete'))) return
        await lib.api('DELETE', `/api/orgs/${org.id}`, d.body())
        lib.toast('Organization deleted')
        location.hash = '#team'
      }) }, ...d.fields, h('div', { class: 'team-actions' }, h('button', { class: 'team-danger', type: 'submit' }, 'Delete organization'), dm))))
  }
  if (settings.length) sections.push(k.card('Settings', ...settings))
  el.append(h('div', { class: 'team-root' }, ...sections))
  if (isAdmin) await loadInvites()
}

export default {
  id: 'team',
  title: 'Team',
  group: 'Account',
  order: 40,
  async render(el, arg, lib) {
    const k = kit(lib)
    if (arg?.startsWith('invite/')) return inviteView(el, arg.slice('invite/'.length), lib, k)
    if (arg) return orgView(el, arg, lib, k)
    return listView(el, lib, k)
  },
}
