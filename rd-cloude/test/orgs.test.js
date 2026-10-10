// Organizations, roles, invites and the access helper. Run: node --test test/orgs.test.js
import { test } from 'node:test'
import http from 'node:http'
import assert from 'node:assert/strict'
import { startTestApp } from './helpers.js'
import { authState, devOutbox } from '../src/auth.js'
import { canAccess, orgRole, listOrgIds, PERMISSIONS } from '../src/modules/orgs.js'

process.env.RD_DEV_OUTBOX = '1'
const PW = 'correct horse battery'


// app.js keeps ONE per-IP rate-limit table for the whole process (300 requests/min), so a long suite would trip it.
// Every app therefore talks from its own loopback source address (127.0.x.y is all "localhost" on Linux).
let nextLoopback = 2
function bindClient(app) {
  const n = nextLoopback++
  const localAddress = `127.0.${(n >> 8) & 255}.${n & 255}`
  const target = new URL(app.base)
  const base = `http://127.0.0.1:${target.port}`
  function call(method, path, { body, raw, headers = {}, token } = {}) {
    return new Promise((resolve, reject) => {
      const payload = raw !== undefined ? Buffer.from(raw) : body !== undefined ? Buffer.from(JSON.stringify(body)) : null
      const h = {
        'user-agent': 'node', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(payload ? { 'content-length': payload.length } : {}), ...headers,
      }
      const req = http.request({ host: '127.0.0.1', port: target.port, path, method, localAddress, headers: h }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          const type = res.headers['content-type'] || ''
          const data = type.includes('json') ? (buf.length ? JSON.parse(buf.toString()) : null) : type.startsWith('text/') ? buf.toString() : buf
          resolve({ status: res.statusCode, headers: new Headers(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v])), data })
        })
      })
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }
  async function register(email = `u${Math.random().toString(36).slice(2, 8)}@rd.dev`, password = 'password123') {
    const r = await call('POST', '/api/auth/register', { body: { email, password } })
    if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.data)}`)
    return { token: r.data.token, user: r.data.user, call: (m, p, o = {}) => call(m, p, { token: r.data.token, ...o }) }
  }
  return { base, call, register }
}

async function withApp(fn) {
  const app = { ...(await startTestApp()) }
  Object.assign(app, bindClient(app), { close: app.close })
  const st = authState(app.db)
  const clock = { t: Date.now(), tick(ms) { clock.t += ms } }
  st.now = () => clock.t
  try { await fn({ ...app, st, clock }) } finally { await app.close() }
}
const mailsTo = (app, to, kind) => devOutbox(app.db).filter((m) => m.to === to && (!kind || m.tags?.kind === kind))
const tokenOf = (mail) => /token: (\S+)/i.exec(mail.text)[1]

/** Owner + members of an org, one registered user per role. */
async function team(app, prefix = 't') {
  const owner = await app.register(`${prefix}-owner@rd.dev`, PW)
  const org = (await owner.call('POST', '/api/orgs', { body: { name: 'Acme' } })).data
  const out = { owner, org }
  for (const role of ['admin', 'member', 'viewer']) {
    const u = await app.register(`${prefix}-${role}@rd.dev`, PW)
    const inv = await owner.call('POST', `/api/orgs/${org.id}/invites`, { body: { email: u.user.email, role } })
    assert.equal(inv.status, 201, `invite ${role}`)
    const acc = await u.call('POST', '/api/orgs/invites/accept', { body: { token: inv.data.token } })
    assert.equal(acc.status, 200, `accept ${role}: ${JSON.stringify(acc.data)}`)
    out[role] = u
  }
  return out
}

test('create / list / rename organizations with validation and limits', async () => {
  await withApp(async (app) => {
    const u = await app.register('o1@rd.dev', PW)
    for (const body of [{}, { name: '' }, { name: 'x' }, { name: 'x'.repeat(65) }, { name: 5 }, { name: ['a'] }, { name: 'bad\nname' }]) {
      assert.equal((await u.call('POST', '/api/orgs', { body })).status, 400, JSON.stringify(body))
    }
    assert.equal((await u.call('POST', '/api/orgs', { raw: 'null', headers: { 'content-type': 'application/json' } })).status, 400)
    const org = await u.call('POST', '/api/orgs', { body: { name: '  Acme <b>Inc</b>  ' } })
    assert.equal(org.status, 201)
    assert.equal(org.data.name, 'Acme <b>Inc</b>', 'trimmed; stored as plain text (the UI renders it with textContent)')
    assert.equal(org.data.role, 'owner')
    assert.equal(org.data.memberCount, 1)
    const list = (await u.call('GET', '/api/orgs')).data.organizations
    assert.equal(list.length, 1)
    assert.equal(list[0].id, org.data.id)
    assert.equal((await u.call('PATCH', `/api/orgs/${org.data.id}`, { body: { name: 'Renamed' } })).data.name, 'Renamed')
    assert.equal((await u.call('PATCH', `/api/orgs/${org.data.id}`, { body: { name: 'x' } })).status, 400)
    for (let i = 0; i < 9; i++) assert.equal((await u.call('POST', '/api/orgs', { body: { name: `Org ${i}` } })).status, 201)
    const over = await u.call('POST', '/api/orgs', { body: { name: 'One too many' } })
    assert.equal(over.status, 409, 'at most 10 owned organizations')
  })
})

test('tenant isolation: outsiders get 404 on every organization endpoint, ids from clients are never trusted', async () => {
  await withApp(async (app) => {
    const t = await team(app, 'iso')
    const outsider = await app.register('iso-out@rd.dev', PW)
    const id = t.org.id
    const target = t.member.user.id
    for (const [m, p, body] of [
      ['GET', `/api/orgs/${id}`], ['PATCH', `/api/orgs/${id}`, { name: 'Hacked' }], ['DELETE', `/api/orgs/${id}`, { password: PW }],
      ['GET', `/api/orgs/${id}/members`], ['PATCH', `/api/orgs/${id}/members/${target}`, { role: 'admin' }], ['DELETE', `/api/orgs/${id}/members/${target}`],
      ['POST', `/api/orgs/${id}/leave`, {}], ['POST', `/api/orgs/${id}/transfer`, { userId: outsider.user.id, password: PW }],
      ['GET', `/api/orgs/${id}/invites`], ['POST', `/api/orgs/${id}/invites`, { email: 'x@rd.dev' }], ['DELETE', `/api/orgs/${id}/invites/inv_x`],
    ]) {
      const r = await outsider.call(m, p, { body })
      assert.equal(r.status, 404, `${m} ${p} -> ${r.status}`)
    }
    assert.equal((await outsider.call('GET', '/api/orgs')).data.organizations.length, 0)
    assert.equal((await outsider.call('GET', '/api/orgs/org_nonexistent')).status, 404)
    assert.equal((await t.owner.call('GET', `/api/orgs/${id}`)).data.name, 'Acme', 'nothing changed')
  })
})

test('invitations by token: mail, accept, wrong account, single use, decline, revoke, expiry', async () => {
  await withApp(async (app) => {
    app.st.cfg.sessionIdleMs = app.st.cfg.sessionMaxMs = 365 * 864e5 // the clock jumps days ahead below; keep the sessions alive
    const owner = await app.register('inv-owner@rd.dev', PW)
    const org = (await owner.call('POST', '/api/orgs', { body: { name: 'Acme' } })).data
    const guest = await app.register('guest@rd.dev', PW)
    const stranger = await app.register('stranger@rd.dev', PW)
    const inv = await owner.call('POST', `/api/orgs/${org.id}/invites`, { body: { email: 'Guest@RD.dev', role: 'viewer' } })
    assert.equal(inv.status, 201)
    assert.equal(inv.data.invite.email, 'guest@rd.dev')
    assert.equal(inv.data.invite.status, 'pending')
    assert.equal(inv.data.invite.tokenHash, undefined, 'no secrets in the view')
    assert.match(inv.data.inviteUrl, /#team\/invite\//)
    const mail = mailsTo(app, 'guest@rd.dev', 'org-invite')
    assert.equal(mail.length, 1)
    assert.equal(tokenOf(mail[0]), inv.data.token, 'the mailed token is the one the inviter got')
    assert.ok(!JSON.stringify(app.db.find('org_invites')).includes(inv.data.token), 'only a hash is stored')

    assert.equal((await app.call('POST', '/api/orgs/invites/accept', { body: { token: inv.data.token } })).status, 401, 'sign-in required')
    const peek = await guest.call('POST', '/api/orgs/invites/preview', { body: { token: inv.data.token } })
    assert.deepEqual(peek.data, { orgName: 'Acme', role: 'viewer', invitedBy: 'inv-owner', expiresAt: inv.data.invite.expiresAt })
    const nope = await stranger.call('POST', '/api/orgs/invites/preview', { body: { token: inv.data.token } })
    assert.equal(nope.status, 403)
    assert.ok(!nope.data.error.includes('guest@'), 'the invited address is masked')
    assert.equal((await stranger.call('POST', '/api/orgs/invites/preview', { body: { token: 'nonsense' } })).status, 404)
    assert.equal((await guest.call('POST', '/api/orgs/invites/accept', { body: { token: 'nonsense' } })).status, 404)
    assert.equal((await guest.call('POST', '/api/orgs/invites/accept', { body: {} })).status, 404)
    assert.equal((await stranger.call('POST', '/api/orgs/invites/accept', { body: { token: inv.data.token } })).status, 403, 'the invitation is bound to the invited address')
    assert.equal((await stranger.call('GET', '/api/orgs')).data.organizations.length, 0)
    const ok = await guest.call('POST', '/api/orgs/invites/accept', { body: { token: inv.data.token } })
    assert.equal(ok.status, 200)
    assert.equal(ok.data.role, 'viewer')
    assert.equal((await guest.call('POST', '/api/orgs/invites/accept', { body: { token: inv.data.token } })).status, 404, 'single use')
    assert.equal((await guest.call('GET', `/api/orgs/${org.id}`)).data.members.length, 2)
    assert.equal((await owner.call('GET', `/api/orgs/${org.id}/invites`)).data.invites.length, 0, 'accepted invites are no longer pending')

    // already a member
    const again = await owner.call('POST', `/api/orgs/${org.id}/invites`, { body: { email: 'guest@rd.dev' } })
    assert.equal(again.status, 409)

    // decline
    const i2 = (await owner.call('POST', `/api/orgs/${org.id}/invites`, { body: { email: 'stranger@rd.dev' } })).data
    assert.equal((await stranger.call('POST', '/api/orgs/invites/decline', { body: { token: i2.token } })).status, 200)
    assert.equal((await stranger.call('POST', '/api/orgs/invites/accept', { body: { token: i2.token } })).status, 404)

    // revoke, then re-invite replaces the old link
    const i3 = (await owner.call('POST', `/api/orgs/${org.id}/invites`, { body: { email: 'stranger@rd.dev' } })).data
    assert.equal((await owner.call('GET', `/api/orgs/${org.id}/invites`)).data.invites.length, 1)
    assert.equal((await owner.call('DELETE', `/api/orgs/${org.id}/invites/${i3.invite.id}`)).status, 200)
    assert.equal((await stranger.call('POST', '/api/orgs/invites/accept', { body: { token: i3.token } })).status, 404, 'revoked')
    const i4 = (await owner.call('POST', `/api/orgs/${org.id}/invites`, { body: { email: 'stranger@rd.dev' } })).data
    const i5 = (await owner.call('POST', `/api/orgs/${org.id}/invites`, { body: { email: 'stranger@rd.dev' } })).data
    assert.equal((await stranger.call('POST', '/api/orgs/invites/accept', { body: { token: i4.token } })).status, 404, 're-invite invalidates the earlier link')

    // expiry (7 days)
    app.clock.tick(8 * 864e5)
    assert.equal((await stranger.call('POST', '/api/orgs/invites/accept', { body: { token: i5.token } })).status, 410)
    assert.equal((await owner.call('GET', `/api/orgs/${org.id}/invites`)).data.invites.length, 0)
  })
})

test('invitations by address require a verified email; listing is private', async () => {
  await withApp(async (app) => {
    const owner = await app.register('v-owner@rd.dev', PW)
    const org = (await owner.call('POST', '/api/orgs', { body: { name: 'Acme' } })).data
    const squatter = await app.register('victim@rd.dev', PW) // registered but never proved the mailbox
    const inv = (await owner.call('POST', `/api/orgs/${org.id}/invites`, { body: { email: 'victim@rd.dev', role: 'member' } })).data
    const list = await squatter.call('GET', '/api/orgs/invites')
    assert.deepEqual(list.data, { invites: [], emailVerified: false })
    assert.equal((await squatter.call('POST', `/api/orgs/invites/${inv.invite.id}/accept`)).status, 404, 'unverified accounts cannot accept by id')
    // verify the mailbox through the real flow
    const vmail = mailsTo(app, 'victim@rd.dev', 'verify-email').at(-1)
    assert.equal((await app.call('POST', '/api/auth/verify-email', { body: { token: tokenOf(vmail) } })).status, 200)
    const mine = (await squatter.call('GET', '/api/orgs/invites')).data
    assert.equal(mine.invites.length, 1)
    assert.equal(mine.invites[0].orgName, 'Acme')
    assert.equal(mine.invites[0].role, 'member')
    assert.equal(mine.invites[0].tokenHash, undefined)
    const other = await app.register('other@rd.dev', PW)
    app.db.update('users', other.user.id, { emailVerified: true })
    assert.equal((await other.call('GET', '/api/orgs/invites')).data.invites.length, 0, "others do not see someone else's invitations")
    assert.equal((await other.call('POST', `/api/orgs/invites/${inv.invite.id}/accept`)).status, 404)
    assert.equal((await squatter.call('POST', `/api/orgs/invites/${inv.invite.id}/accept`)).status, 200)
    assert.equal(listOrgIds(app.db, squatter.user.id).length, 1)
  })
})

test('invite permissions and validation', async () => {
  await withApp(async (app) => {
    const t = await team(app, 'perm')
    const id = t.org.id
    const inv = (u, body) => u.call('POST', `/api/orgs/${id}/invites`, { body })
    assert.equal((await inv(t.member, { email: 'n1@rd.dev' })).status, 403, 'members cannot invite')
    assert.equal((await inv(t.viewer, { email: 'n1@rd.dev' })).status, 403)
    assert.equal((await t.member.call('GET', `/api/orgs/${id}/invites`)).status, 403)
    assert.equal((await inv(t.admin, { email: 'n1@rd.dev', role: 'admin' })).status, 403, 'only the owner invites admins')
    assert.equal((await inv(t.admin, { email: 'n1@rd.dev', role: 'viewer' })).status, 201)
    assert.equal((await inv(t.owner, { email: 'n2@rd.dev', role: 'admin' })).status, 201)
    assert.equal((await inv(t.owner, { email: 'n3@rd.dev', role: 'owner' })).status, 400, 'ownership only moves through transfer')
    assert.equal((await inv(t.owner, { email: 'n3@rd.dev', role: 'root' })).status, 400)
    assert.equal((await inv(t.owner, { email: 'n3@rd.dev', role: ['admin'] })).status, 400)
    assert.equal((await inv(t.owner, { email: 'not-an-email' })).status, 400)
    assert.equal((await inv(t.owner, { email: { a: 1 } })).status, 400)
    assert.equal((await inv(t.owner, {})).status, 400)
    assert.equal((await inv(t.owner, { email: 'n4@rd.dev' })).data.invite.role, 'member', 'default role')
    assert.equal((await t.member.call('DELETE', `/api/orgs/${id}/invites/inv_x`)).status, 403)
    assert.equal((await t.admin.call('DELETE', `/api/orgs/${id}/invites/inv_missing`)).status, 404)
    // an invite id from a different org is not deletable through this one
    const other = (await t.owner.call('POST', '/api/orgs', { body: { name: 'Other' } })).data
    const foreign = (await t.owner.call('POST', `/api/orgs/${other.id}/invites`, { body: { email: 'n5@rd.dev' } })).data.invite
    assert.equal((await t.owner.call('DELETE', `/api/orgs/${id}/invites/${foreign.id}`)).status, 404)
  })
})

test('invitations die with the authority of whoever sent them', async () => {
  await withApp(async (app) => {
    const t = await team(app, 'auth')
    const id = t.org.id
    const mk = async (email) => {
      const g = await app.register(email, PW)
      const inv = (await t.admin.call('POST', `/api/orgs/${id}/invites`, { body: { email, role: 'viewer' } })).data
      return { g, inv }
    }
    const a = await mk('guest-a@rd.dev')
    const b = await mk('guest-b@rd.dev')
    assert.equal((await t.owner.call('PATCH', `/api/orgs/${id}/members/${t.admin.user.id}`, { body: { role: 'member' } })).status, 200, 'owner demotes the admin')
    assert.equal((await a.g.call('POST', '/api/orgs/invites/accept', { body: { token: a.inv.token } })).status, 404, 'a demoted admin no longer vouches for anyone')
    assert.equal((await t.owner.call('GET', `/api/orgs/${id}/invites`)).data.invites.length, 0)
    await t.owner.call('PATCH', `/api/orgs/${id}/members/${t.admin.user.id}`, { body: { role: 'admin' } })
    const c = await mk('guest-c@rd.dev')
    assert.equal((await t.admin.call('POST', `/api/orgs/${id}/leave`)).status, 200)
    assert.equal((await c.g.call('POST', '/api/orgs/invites/accept', { body: { token: c.inv.token } })).status, 404, 'nor does one who left')
    assert.equal((await b.g.call('POST', '/api/orgs/invites/accept', { body: { token: b.inv.token } })).status, 404)
    // the owner's own invitations are unaffected
    const own = (await t.owner.call('POST', `/api/orgs/${id}/invites`, { body: { email: 'guest-d@rd.dev' } })).data
    const d = await app.register('guest-d@rd.dev', PW)
    assert.equal((await d.call('POST', '/api/orgs/invites/accept', { body: { token: own.token } })).status, 200)
  })
})

test('invite abuse limits: pending cap, full org, per-org hourly cap, token guessing', async () => {
  await withApp(async (app) => {
    const owner = await app.register('lim-owner@rd.dev', PW)
    const org = (await owner.call('POST', '/api/orgs', { body: { name: 'Acme' } })).data
    for (let i = 0; i < 100; i++) app.db.insert('org_invites', { orgId: org.id, email: `p${i}@rd.dev`, role: 'member', status: 'pending', invitedBy: owner.user.id, tokenHash: 'x', expiresAt: new Date(app.clock.t + 1e9).toISOString() })
    assert.equal((await owner.call('POST', `/api/orgs/${org.id}/invites`, { body: { email: 'extra@rd.dev' } })).status, 409, 'pending invitation cap')
    app.db.removeWhere('org_invites', () => true)
    for (let i = 0; i < 99; i++) app.db.insert('org_members', { orgId: org.id, userId: `use_fake${i}`, role: 'member' })
    assert.equal((await owner.call('POST', `/api/orgs/${org.id}/invites`, { body: { email: 'full@rd.dev' } })).status, 409, 'organization is full at 100 members')
    app.db.removeWhere('org_members', (m) => m.userId.startsWith('use_fake'))
    app.st.gates.clear()
    let last
    for (let i = 0; i < 51; i++) last = await owner.call('POST', `/api/orgs/${org.id}/invites`, { body: { email: `bulk${i}@rd.dev` } })
    assert.equal(last.status, 429, 'at most 50 invitations per hour per organization')

    const guesser = await app.register('guesser@rd.dev', PW)
    let status
    for (let i = 0; i < 21; i++) status = (await guesser.call('POST', '/api/orgs/invites/accept', { body: { token: `guess-${i}`.padEnd(30, 'x') } })).status
    assert.equal(status, 429, 'token guessing is rate limited')
  })
})

test('roles: who may promote, demote and remove whom', async () => {
  await withApp(async (app) => {
    const t = await team(app, 'role')
    const id = t.org.id
    const patch = (u, target, role) => u.call('PATCH', `/api/orgs/${id}/members/${target.user.id}`, { body: { role } })
    const del = (u, target) => u.call('DELETE', `/api/orgs/${id}/members/${target.user.id}`)

    assert.equal((await patch(t.member, t.viewer, 'member')).status, 403, 'members cannot change roles')
    assert.equal((await patch(t.viewer, t.member, 'viewer')).status, 403)
    assert.equal((await patch(t.admin, t.member, 'admin')).status, 403, 'admins cannot create admins')
    assert.equal((await patch(t.admin, t.viewer, 'member')).data.role, 'member')
    assert.equal((await patch(t.admin, t.viewer, 'viewer')).data.role, 'viewer')
    assert.equal((await patch(t.admin, t.owner, 'viewer')).status, 403, 'nobody touches the owner role')
    assert.equal((await patch(t.owner, t.owner, 'admin')).status, 400, 'not even the owner demotes themselves this way')
    assert.equal((await patch(t.admin, t.admin, 'viewer')).status, 400, 'no self role changes')
    assert.equal((await patch(t.owner, t.member, 'owner')).status, 400)
    assert.equal((await patch(t.owner, t.member, 'god')).status, 400)
    assert.equal((await patch(t.owner, t.member, undefined)).status, 400)
    assert.equal((await patch(t.owner, { user: { id: 'use_nobody' } }, 'member')).status, 404)
    assert.equal((await patch(t.owner, t.member, 'admin')).data.role, 'admin')
    assert.equal((await patch(t.admin, t.member, 'viewer')).status, 403, 'admins cannot demote other admins')
    assert.equal((await patch(t.owner, t.member, 'member')).data.role, 'member')

    assert.equal((await del(t.member, t.viewer)).status, 403, 'members cannot remove')
    assert.equal((await del(t.admin, t.owner)).status, 403)
    assert.equal((await del(t.admin, t.admin)).status, 200, 'DELETE on yourself is leaving, which any non-owner may do')
  })
})

test('roles: removal and leaving', async () => {
  await withApp(async (app) => {
    const t = await team(app, 'rm')
    const id = t.org.id
    const del = (u, target) => u.call('DELETE', `/api/orgs/${id}/members/${target.user.id}`)
    assert.equal((await del(t.member, t.viewer)).status, 403)
    assert.equal((await del(t.admin, t.owner)).status, 403, 'the owner cannot be removed')
    const events = []
    app.ctx.events.on('org.member.removed', (e) => events.push(e))
    assert.equal((await del(t.admin, t.viewer)).status, 200, 'admin removes a viewer')
    assert.equal((await t.viewer.call('GET', `/api/orgs/${id}`)).status, 404, 'removed members lose all access')
    assert.deepEqual(events.map((e) => [e.userId, e.reason]), [[t.viewer.user.id, 'removed']])
    assert.equal((await del(t.owner, { user: { id: 'use_nobody' } })).status, 404)
    // leaving
    assert.equal((await t.owner.call('POST', `/api/orgs/${id}/leave`)).status, 409, 'the owner must transfer or delete first')
    assert.equal((await del(t.owner, t.owner)).status, 409)
    assert.equal((await t.member.call('POST', `/api/orgs/${id}/leave`)).status, 200)
    assert.equal((await t.member.call('GET', `/api/orgs/${id}`)).status, 404)
    assert.equal((await t.member.call('POST', `/api/orgs/${id}/leave`)).status, 404, 'already gone')
    assert.equal((await del(t.owner, t.admin)).status, 200, 'the owner can remove an admin')
    assert.equal((await t.owner.call('GET', `/api/orgs/${id}/members`)).data.members.length, 1)
  })
})

test('ownership transfer and organization deletion need password confirmation', async () => {
  await withApp(async (app) => {
    const t = await team(app, 'own')
    const id = t.org.id
    const xfer = (u, body) => u.call('POST', `/api/orgs/${id}/transfer`, { body })
    assert.equal((await xfer(t.admin, { userId: t.admin.user.id, password: PW })).status, 403, 'only the owner transfers')
    assert.equal((await xfer(t.owner, { userId: t.admin.user.id, password: 'wrong-password' })).status, 403)
    assert.equal((await xfer(t.owner, { userId: t.admin.user.id })).status, 400)
    assert.equal((await xfer(t.owner, { password: PW })).status, 400)
    assert.equal((await xfer(t.owner, { userId: t.owner.user.id, password: PW })).status, 400, 'already the owner')
    assert.equal((await xfer(t.owner, { userId: 'use_nobody', password: PW })).status, 404, 'target must be a member')
    const ok = await xfer(t.owner, { userId: t.admin.user.id, password: PW })
    assert.equal(ok.status, 200)
    assert.equal(ok.data.role, 'admin', 'the previous owner becomes an admin')
    assert.equal(orgRole(app.db, t.admin.user.id, id), 'owner')
    assert.equal(orgRole(app.db, t.owner.user.id, id), 'admin')
    assert.equal((await t.owner.call('GET', `/api/orgs/${id}`)).data.ownerId, t.admin.user.id)
    assert.equal(app.db.find('org_members', (m) => m.orgId === id && m.role === 'owner').length, 1, 'exactly one owner')

    // deletion
    const deleted = []
    app.ctx.events.on('org.deleted', (e) => deleted.push(e))
    assert.equal((await t.owner.call('DELETE', `/api/orgs/${id}`, { body: { password: PW } })).status, 403, 'former owner cannot delete')
    assert.equal((await t.admin.call('DELETE', `/api/orgs/${id}`, { body: {} })).status, 400, 'password required')
    assert.equal((await t.admin.call('DELETE', `/api/orgs/${id}`, { body: { password: 'wrong-password' } })).status, 403)
    assert.equal((await t.admin.call('DELETE', `/api/orgs/${id}`, { body: { password: PW } })).status, 200)
    assert.equal(deleted.length, 1)
    assert.equal(deleted[0].orgId, id)
    assert.equal(deleted[0].memberIds.length, 4)
    assert.equal(app.db.find('org_members', (m) => m.orgId === id).length, 0)
    assert.equal(app.db.find('org_invites', (m) => m.orgId === id).length, 0)
    for (const u of [t.owner, t.member, t.viewer, t.admin]) assert.equal((await u.call('GET', `/api/orgs/${id}`)).status, 404)
  })
})

test('canAccess: personal resources, org roles, ex-members and bad input', async () => {
  await withApp(async (app) => {
    const t = await team(app, 'acl')
    const id = t.org.id
    const outsider = await app.register('acl-out@rd.dev', PW)
    const shared = { userId: t.member.user.id, orgId: id }
    const personal = { userId: t.member.user.id }
    const can = (u, res, perm) => canAccess(app.db, u.user.id, res, perm)

    // personal: only the owner, every permission
    for (const perm of Object.keys(PERMISSIONS)) {
      assert.equal(can(t.member, personal, perm), true, perm)
      assert.equal(can(t.owner, personal, perm), false, `${perm}: org owners do not get other people's personal data`)
      assert.equal(can(outsider, personal, perm), false)
    }
    // org matrix
    const matrix = {
      viewer: { read: true, write: false, delete: false, admin: false, owner: false },
      member: { read: true, write: true, delete: false, admin: false, owner: false },
      admin: { read: true, write: true, delete: true, admin: true, owner: false },
      owner: { read: true, write: true, delete: true, admin: true, owner: true },
    }
    for (const [role, perms] of Object.entries(matrix)) for (const [perm, expected] of Object.entries(perms)) assert.equal(can(t[role], shared, perm), expected, `${role} ${perm}`)
    assert.equal(can(outsider, shared, 'read'), false)
    assert.equal(can(t.owner, shared), true, 'permission defaults to read')
    assert.equal(can(t.owner, shared, 'nuke'), false, 'unknown permissions deny')
    assert.equal(can(t.owner, null, 'read'), false)
    assert.equal(can(t.owner, 'string', 'read'), false)
    assert.equal(canAccess(app.db, null, shared, 'read'), false)
    assert.equal(canAccess(app.db, undefined, personal, 'read'), false)
    assert.equal(canAccess(app.db, 'use_x', { userId: undefined }, 'read'), false, 'no owner, no org: nobody')

    // the creator does not keep access to an org resource after leaving the org
    await t.member.call('POST', `/api/orgs/${id}/leave`)
    assert.equal(can(t.member, shared, 'read'), false)
    assert.equal(can(t.member, personal, 'read'), true, 'but personal resources stay theirs')
    // demotion takes effect immediately
    await t.owner.call('PATCH', `/api/orgs/${id}/members/${t.admin.user.id}`, { body: { role: 'viewer' } })
    assert.equal(can(t.admin, shared, 'write'), false)
    assert.equal(can(t.admin, shared, 'read'), true)

    // wiring on ctx for other modules
    assert.equal(app.ctx.access.canAccess(t.owner.user.id, shared, 'delete'), true)
    assert.equal(app.ctx.access.orgRole(t.owner.user.id, id), 'owner')
    assert.equal(app.ctx.access.orgRole(outsider.user.id, id), null)
    assert.deepEqual(app.ctx.access.listOrgIds(t.owner.user.id), [id])
    assert.deepEqual(app.ctx.access.listOrgIds(outsider.user.id), [])
    assert.deepEqual(app.ctx.access.ROLES, ['viewer', 'member', 'admin', 'owner'])
  })
})

test('organization activity is written to the audit logs of everyone affected', async () => {
  await withApp(async (app) => {
    const t = await team(app, 'aud')
    const id = t.org.id
    await t.owner.call('PATCH', `/api/orgs/${id}/members/${t.member.user.id}`, { body: { role: 'admin' } })
    await t.owner.call('DELETE', `/api/orgs/${id}/members/${t.viewer.user.id}`)
    const ownerLog = (await t.owner.call('GET', '/api/audit?limit=200')).data.entries.map((e) => e.action)
    for (const a of ['org.create', 'org.invite.create', 'org.member.role', 'org.member.remove']) assert.ok(ownerLog.includes(a), `${a} in ${ownerLog}`)
    const memberLog = (await t.member.call('GET', '/api/audit?limit=200')).data.entries.map((e) => e.action)
    assert.ok(memberLog.includes('org.invite.accept') && memberLog.includes('org.role.changed'))
    const viewerLog = (await t.viewer.call('GET', '/api/audit?limit=200')).data.entries.map((e) => e.action)
    assert.ok(viewerLog.includes('org.removed'))
    const log = (await t.owner.call('GET', '/api/audit?action=org.member.joined')).data.entries
    assert.equal(log.length, 3, 'inviter is told when invitations are accepted')
    // scope enforcement applies to the organizations API
    const readKey = (await t.owner.call('POST', '/api/keys', { body: { scopes: ['orgs:read'] } })).data.secret
    assert.equal((await app.call('GET', '/api/orgs', { token: readKey })).status, 200)
    assert.equal((await app.call('POST', '/api/orgs', { token: readKey, body: { name: 'Nope' } })).status, 403)
  })
})

test('account deletion: owners with other members are blocked; sole-owner orgs, memberships and invites are cleaned up', async () => {
  await withApp(async (app) => {
    const t = await team(app, 'acc')
    const id = t.org.id
    const blocked = await t.owner.call('DELETE', '/api/account', { body: { password: PW } })
    assert.equal(blocked.status, 409)
    assert.match(blocked.data.error, /Acme/)
    assert.equal((await t.owner.call('GET', '/api/me')).status, 200, 'account untouched')

    // a member leaves via account deletion; their membership disappears
    assert.equal((await t.viewer.call('DELETE', '/api/account', { body: { password: PW } })).status, 200)
    assert.equal(orgRole(app.db, t.viewer.user.id, id), null)
    assert.equal((await t.owner.call('GET', `/api/orgs/${id}/members`)).data.members.length, 3)

    // pending invitations addressed to / sent by the deleted user vanish
    await t.owner.call('POST', `/api/orgs/${id}/invites`, { body: { email: 'acc-member@rd.dev', role: 'viewer' } }) // already a member: 409, nothing created
    const pending = (await t.admin.call('POST', `/api/orgs/${id}/invites`, { body: { email: 'future@rd.dev', role: 'viewer' } })).data
    assert.ok(pending.invite.id)
    assert.equal((await t.admin.call('DELETE', '/api/account', { body: { password: PW } })).status, 200)
    assert.equal(app.db.find('org_invites', (i) => i.invitedBy === t.admin.user.id).length, 0)

    // transfer, then everything can go
    const x = await t.owner.call('POST', `/api/orgs/${id}/transfer`, { body: { userId: t.member.user.id, password: PW } })
    assert.equal(x.status, 200)
    assert.equal((await t.owner.call('DELETE', '/api/account', { body: { password: PW } })).status, 200, 'no longer an owner')
    assert.equal(orgRole(app.db, t.member.user.id, id), 'owner')

    // sole owner: org disappears with the account
    const solo = await app.register('solo@rd.dev', PW)
    const soloOrg = (await solo.call('POST', '/api/orgs', { body: { name: 'Solo' } })).data
    const deleted = []
    app.ctx.events.on('org.deleted', (e) => deleted.push(e.orgId))
    assert.equal((await solo.call('DELETE', '/api/account', { body: { password: PW } })).status, 200)
    assert.equal(app.db.get('org_orgs', soloOrg.id), null)
    assert.deepEqual(deleted, [soloOrg.id])
    assert.equal(app.db.find('org_members', (m) => m.orgId === soloOrg.id).length, 0)
  })
})

test('account deletion hands org-shared records to the org owner and deletes personal ones', async () => {
  await withApp(async (app) => {
    const t = await team(app, 'heir')
    const solo = await app.register('heir-solo@rd.dev', PW)
    const soloOrg = (await solo.call('POST', '/api/orgs', { body: { name: 'Solo' } })).data
    app.db.insert('zz_items', { userId: t.member.user.id, orgId: t.org.id, name: 'shared' })
    app.db.insert('zz_items', { userId: t.member.user.id, name: 'personal' })
    app.db.insert('zz_items', { userId: solo.user.id, orgId: soloOrg.id, name: 'solo-shared' })
    assert.equal((await t.member.call('DELETE', '/api/account', { body: { password: PW } })).status, 200)
    const left = app.db.find('zz_items')
    assert.deepEqual(left.map((r) => [r.name, r.userId]), [['shared', t.owner.user.id], ['solo-shared', solo.user.id]], 'the shared record survives under the owner; the personal one is gone')
    assert.equal((await solo.call('DELETE', '/api/account', { body: { password: PW } })).status, 200)
    assert.deepEqual(app.db.find('zz_items').map((r) => r.name), ['shared'], 'an org that disappears with its only member takes its records along')
  })
})

test('member listing exposes only contact basics, sorted by role', async () => {
  await withApp(async (app) => {
    const t = await team(app, 'list')
    const { members } = (await t.viewer.call('GET', `/api/orgs/${t.org.id}/members`)).data
    assert.deepEqual(members.map((m) => m.role), ['owner', 'admin', 'member', 'viewer'])
    for (const m of members) assert.deepEqual(Object.keys(m).sort(), ['email', 'joinedAt', 'name', 'role', 'userId'])
    const detail = (await t.viewer.call('GET', `/api/orgs/${t.org.id}`)).data
    assert.equal(detail.role, 'viewer')
    assert.equal(detail.memberCount, 4)
    assert.ok(!JSON.stringify(detail).includes('password'))
    assert.equal((await t.viewer.call('PATCH', `/api/orgs/${t.org.id}`, { body: { name: 'Mine now' } })).status, 403)
    assert.equal((await t.admin.call('PATCH', `/api/orgs/${t.org.id}`, { body: { name: 'Admin rename' } })).data.name, 'Admin rename')
  })
})
