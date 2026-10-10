// Organizations: members, roles (owner/admin/member/viewer), email invites, ownership transfer, and the access helper
// other modules use to share resources with an org. See docs/security.md ("Organizations").
import crypto from 'node:crypto'
import { HttpError } from '../http.js'
import {
  initAuth, withDocs, bodyObj, str, normEmail, confirmPassword, confirmSecondFactor, emitAudit, sendMail, appUrl, sha, rateGate, tx, many, one,
} from '../auth.js'

export const ROLES = ['viewer', 'member', 'admin', 'owner']
const rank = (role) => ROLES.indexOf(role)
/** Lowest role that holds each permission. */
export const PERMISSIONS = { read: 'viewer', write: 'member', delete: 'admin', admin: 'admin', owner: 'owner' }

const LIMITS = { ownedOrgs: 10, memberships: 50, members: 100, pendingInvites: 100, inviteTtlMs: 7 * 864e5 }

/** The user's role in the org, or null when not a member. */
export function orgRole(db, userId, orgId) {
  if (typeof userId !== 'string' || typeof orgId !== 'string') return null
  return many(db, 'org_members', 'userId', userId).find((m) => m.orgId === orgId)?.role ?? null
}
export function listOrgIds(db, userId) {
  return typeof userId === 'string' ? many(db, 'org_members', 'userId', userId).map((m) => m.orgId) : []
}

/**
 * May `userId` perform `permission` (read | write | delete | admin | owner) on `resource`?
 * `resource` is any record carrying { userId, orgId? }:
 *  - without orgId the resource is personal: only its owning user may touch it (every permission);
 *  - with orgId the resource belongs to that organization: access follows the user's CURRENT org role
 *    (viewer: read, member: +write, admin: +delete/admin, owner: all). The creating user gets no extra rights once they
 *    leave the org or are demoted, so removing a member really removes their access.
 * Unknown permissions and missing arguments deny.
 */
export function canAccess(db, userId, resource, permission = 'read') {
  if (!userId || !resource || typeof resource !== 'object') return false
  const need = PERMISSIONS[permission]
  if (!need) return false
  if (!resource.orgId) return resource.userId === userId
  const role = orgRole(db, userId, resource.orgId)
  return role !== null && rank(role) >= rank(need)
}

const DOCS = {
  'GET /api/orgs': 'Organizations you belong to, with your role',
  'POST /api/orgs': 'Create an organization (you become the owner)',
  'GET /api/orgs/invites': 'Pending invitations for your verified email address',
  'POST /api/orgs/invites/preview': 'What an invitation link offers (only for the invited account)',
  'POST /api/orgs/invites/accept': 'Accept an invitation by token',
  'POST /api/orgs/invites/decline': 'Decline an invitation by token',
  'POST /api/orgs/invites/:id/accept': 'Accept an invitation addressed to your verified email',
  'POST /api/orgs/invites/:id/decline': 'Decline an invitation addressed to your verified email',
  'GET /api/orgs/:id': 'Organization details and members (members only)',
  'PATCH /api/orgs/:id': 'Rename (admin+)',
  'DELETE /api/orgs/:id': 'Delete the organization (owner, password confirmation)',
  'GET /api/orgs/:id/members': 'List members',
  'PATCH /api/orgs/:id/members/:userId': 'Change a member role (admin+; only the owner touches admins)',
  'DELETE /api/orgs/:id/members/:userId': 'Remove a member (admin+) or yourself (leave)',
  'POST /api/orgs/:id/leave': 'Leave the organization (not the owner)',
  'POST /api/orgs/:id/transfer': 'Transfer ownership to a member (owner, password confirmation)',
  'GET /api/orgs/:id/invites': 'Pending invitations (admin+)',
  'POST /api/orgs/:id/invites': 'Invite by email; the token is mailed and returned once (admin+)',
  'DELETE /api/orgs/:id/invites/:inviteId': 'Revoke an invitation (admin+)',
}

export async function register(router, db, ctx) {
  const st = initAuth(ctx)
  const r = withDocs(router, DOCS)
  ctx.access = {
    ROLES, PERMISSIONS,
    canAccess: (userId, resource, permission) => canAccess(db, userId, resource, permission),
    orgRole: (userId, orgId) => orgRole(db, userId, orgId),
    listOrgIds: (userId) => listOrgIds(db, userId),
  }

  const audit = (rc, userId, action, resource, meta) => emitAudit(ctx, rc.req, rc.requestId, userId, action, resource, meta)
  const membership = (userId, orgId) => many(db, 'org_members', 'userId', userId).find((m) => m.orgId === orgId) ?? null
  const members = (orgId) => many(db, 'org_members', 'orgId', orgId)

  /** Resolve the org and the caller's membership. Non-members get 404 (existence is not revealed); too-low roles get 403. */
  function scope(user, orgId, min = 'viewer') {
    const org = db.get('org_orgs', orgId)
    const me = org && membership(user.id, orgId)
    if (!org || !me) throw new HttpError(404, 'Organization not found')
    if (rank(me.role) < rank(min)) throw new HttpError(403, `This requires the ${min} role or higher`)
    return { org, me }
  }

  const orgView = (org, role) => ({ id: org.id, name: org.name, ownerId: org.ownerId, role, memberCount: members(org.id).length, createdAt: org.createdAt })
  const memberView = (m) => {
    const u = db.get('users', m.userId)
    return { userId: m.userId, email: u?.email ?? null, name: u?.name ?? null, role: m.role, joinedAt: m.createdAt }
  }
  const inviteView = (i) => ({ id: i.id, orgId: i.orgId, email: i.email, role: i.role, status: i.status, invitedBy: i.invitedBy, createdAt: i.createdAt, expiresAt: i.expiresAt })

  /** Invitations a person sent are only as good as their authority: drop them when they leave, are removed or lose admin. */
  const revokeInvitesBy = (orgId, userId) => {
    for (const i of many(db, 'org_invites', 'orgId', orgId)) if (i.invitedBy === userId && i.status === 'pending') db.update('org_invites', i.id, { status: 'revoked' })
  }
  const dropMember = (org, m, reason) => {
    tx(db, () => {
      db.remove('org_members', m.id)
      revokeInvitesBy(org.id, m.userId)
    })
    ctx.events.emit('org.member.removed', { orgId: org.id, userId: m.userId, reason })
  }

  /* ------------------------------------------------------------- orgs */
  r.get('/api/orgs', ({ user }) => ({
    organizations: many(db, 'org_members', 'userId', user.id)
      .map((m) => ({ org: db.get('org_orgs', m.orgId), role: m.role })).filter((x) => x.org).map((x) => orgView(x.org, x.role))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }), { meta: { summary: 'Organizations you belong to' } })

  r.post('/api/orgs', (rc) => {
    const b = bodyObj(rc.body)
    const name = str(b.name, 'name', { min: 2, max: 64 })
    if (many(db, 'org_orgs', 'ownerId', rc.user.id).length >= LIMITS.ownedOrgs) throw new HttpError(409, `You can own at most ${LIMITS.ownedOrgs} organizations`)
    const org = tx(db, () => {
      const o = db.insert('org_orgs', { name, ownerId: rc.user.id })
      db.insert('org_members', { orgId: o.id, userId: rc.user.id, role: 'owner', invitedBy: null })
      return o
    })
    ctx.events.emit('org.member.added', { orgId: org.id, userId: rc.user.id, role: 'owner' })
    ctx.events.emit('org.created', { orgId: org.id, userId: rc.user.id })
    audit(rc, rc.user.id, 'org.create', `org:${org.id}`, { name })
    return [201, orgView(org, 'owner')]
  })

  // --- invitations addressed to me (declared before /api/orgs/:id so "invites" is never read as an id)
  const myInvites = (user) => many(db, 'org_invites', 'email', user.email).filter((i) => i.status === 'pending' && Date.parse(i.expiresAt) > st.now())
  r.get('/api/orgs/invites', ({ user }) => {
    // Listing by address needs a verified email: an unverified signup must not read someone else's invitations.
    if (!user.emailVerified) return { invites: [], emailVerified: false }
    return {
      emailVerified: true,
      invites: myInvites(user).map((i) => ({ id: i.id, orgId: i.orgId, orgName: db.get('org_orgs', i.orgId)?.name ?? null, role: i.role, invitedBy: db.get('users', i.invitedBy)?.name ?? null, expiresAt: i.expiresAt })),
    }
  })

  function respond(rc, inv, accept) {
    const { user } = rc
    if (!inv || inv.status !== 'pending') throw new HttpError(404, 'Invitation not found or no longer valid')
    if (Date.parse(inv.expiresAt) <= st.now()) {
      db.update('org_invites', inv.id, { status: 'expired' })
      throw new HttpError(410, 'This invitation has expired')
    }
    if (inv.email !== user.email) throw new HttpError(403, 'This invitation was sent to a different email address')
    const org = db.get('org_orgs', inv.orgId)
    if (!org) {
      db.update('org_invites', inv.id, { status: 'revoked' })
      throw new HttpError(404, 'Invitation not found or no longer valid')
    }
    if (!accept) {
      db.update('org_invites', inv.id, { status: 'declined', respondedAt: new Date(st.now()).toISOString() })
      audit(rc, user.id, 'org.invite.decline', `org:${org.id}`, {})
      return { ok: true }
    }
    if (membership(user.id, org.id)) {
      db.update('org_invites', inv.id, { status: 'accepted', respondedAt: new Date(st.now()).toISOString() })
      throw new HttpError(409, 'You are already a member of this organization')
    }
    if (members(org.id).length >= LIMITS.members) throw new HttpError(409, 'This organization is full')
    if (listOrgIds(db, user.id).length >= LIMITS.memberships) throw new HttpError(409, `You can belong to at most ${LIMITS.memberships} organizations`)
    tx(db, () => {
      db.insert('org_members', { orgId: org.id, userId: user.id, role: inv.role, invitedBy: inv.invitedBy ?? null })
      db.update('org_invites', inv.id, { status: 'accepted', respondedAt: new Date(st.now()).toISOString() })
    })
    ctx.events.emit('org.member.added', { orgId: org.id, userId: user.id, role: inv.role })
    audit(rc, user.id, 'org.invite.accept', `org:${org.id}`, { role: inv.role })
    if (db.get('users', inv.invitedBy)) audit(rc, inv.invitedBy, 'org.member.joined', `org:${org.id}`, { userId: user.id, role: inv.role })
    return orgView(org, inv.role)
  }
  const byToken = (token) => {
    const raw = typeof token === 'string' ? token.slice(0, 200) : ''
    const h = sha(raw)
    return raw.length >= 20 ? one(db, 'org_invites', 'tokenHash', h) : null
  }
  const guessGate = (rc) => {
    if (!rateGate(st, `invite-token:${rc.user.id}`, 20, 600_000)) throw new HttpError(429, 'Too many attempts, slow down')
  }
  // What does this invitation link offer? Only the invited account may look (so tokens cannot be used to probe organizations).
  r.post('/api/orgs/invites/preview', (rc) => {
    guessGate(rc)
    const inv = byToken(bodyObj(rc.body).token)
    if (!inv || inv.status !== 'pending' || Date.parse(inv.expiresAt) <= st.now()) throw new HttpError(404, 'Invitation not found or no longer valid')
    if (inv.email !== rc.user.email) throw new HttpError(403, `This invitation was sent to ${inv.email.replace(/^(.).*(@.*)$/, '$1***$2')}. Sign in with that address to accept it`)
    return { orgName: db.get('org_orgs', inv.orgId)?.name ?? null, role: inv.role, invitedBy: db.get('users', inv.invitedBy)?.name ?? null, expiresAt: inv.expiresAt }
  })
  r.post('/api/orgs/invites/accept', (rc) => (guessGate(rc), respond(rc, byToken(bodyObj(rc.body).token), true)))
  r.post('/api/orgs/invites/decline', (rc) => (guessGate(rc), respond(rc, byToken(bodyObj(rc.body).token), false)))
  const byId = (rc) => {
    const inv = db.get('org_invites', rc.params.id)
    return inv && rc.user.emailVerified && inv.email === rc.user.email ? inv : null
  }
  r.post('/api/orgs/invites/:id/accept', (rc) => respond(rc, byId(rc), true))
  r.post('/api/orgs/invites/:id/decline', (rc) => respond(rc, byId(rc), false))

  r.get('/api/orgs/:id', ({ user, params }) => {
    const { org, me } = scope(user, params.id)
    return { ...orgView(org, me.role), members: members(org.id).map(memberView) }
  })

  r.patch('/api/orgs/:id', (rc) => {
    const { org } = scope(rc.user, rc.params.id, 'admin')
    const name = str(bodyObj(rc.body).name, 'name', { min: 2, max: 64 })
    const updated = db.update('org_orgs', org.id, { name })
    audit(rc, rc.user.id, 'org.rename', `org:${org.id}`, { from: org.name, to: name })
    return orgView(updated, membership(rc.user.id, org.id).role)
  })

  r.delete('/api/orgs/:id', async (rc) => {
    const { org } = scope(rc.user, rc.params.id, 'owner')
    const b = bodyObj(rc.body)
    await confirmPassword(ctx, rc.req, rc.user, b.password)
    confirmSecondFactor(ctx, rc.req, rc.user, b.code)
    const memberIds = members(org.id).map((m) => m.userId)
    tx(db, () => {
      for (const m of members(org.id)) db.remove('org_members', m.id)
      for (const i of many(db, 'org_invites', 'orgId', org.id)) db.remove('org_invites', i.id)
      db.remove('org_orgs', org.id)
    })
    ctx.events.emit('org.deleted', { orgId: org.id, memberIds })
    for (const uid of memberIds) audit(rc, uid, 'org.delete', `org:${org.id}`, { name: org.name, by: rc.user.id })
    return { ok: true }
  })

  /* ------------------------------------------------------------- members */
  r.get('/api/orgs/:id/members', ({ user, params }) => {
    const { org } = scope(user, params.id)
    return { members: members(org.id).map(memberView).sort((a, b) => rank(b.role) - rank(a.role) || String(a.email).localeCompare(String(b.email))) }
  })

  r.patch('/api/orgs/:id/members/:userId', (rc) => {
    const { org, me } = scope(rc.user, rc.params.id, 'admin')
    const role = bodyObj(rc.body).role
    if (!['viewer', 'member', 'admin'].includes(role)) throw new HttpError(400, role === 'owner' ? 'Use ownership transfer to change the owner' : 'role must be viewer, member or admin')
    const target = membership(rc.params.userId, org.id)
    if (!target) throw new HttpError(404, 'Member not found')
    if (target.userId === rc.user.id) throw new HttpError(400, 'You cannot change your own role')
    if (target.role === 'owner') throw new HttpError(403, 'The owner role can only change through ownership transfer')
    if (me.role === 'admin' && (rank(target.role) >= rank('admin') || role === 'admin')) throw new HttpError(403, 'Only the owner can promote to or change admins')
    if (target.role === role) return memberView(target)
    const updated = tx(db, () => {
      if (rank(role) < rank('admin')) revokeInvitesBy(org.id, target.userId)
      return db.update('org_members', target.id, { role })
    })
    ctx.events.emit('org.member.role_changed', { orgId: org.id, userId: target.userId, from: target.role, to: role })
    audit(rc, rc.user.id, 'org.member.role', `org:${org.id}`, { userId: target.userId, from: target.role, to: role })
    audit(rc, target.userId, 'org.role.changed', `org:${org.id}`, { from: target.role, to: role })
    return memberView(updated)
  })

  function removeOrLeave(rc, org, me, target) {
    if (target.userId === me.userId) {
      if (me.role === 'owner') throw new HttpError(409, 'Owners must transfer ownership or delete the organization before leaving')
      dropMember(org, target, 'left')
      audit(rc, me.userId, 'org.leave', `org:${org.id}`, {})
      return { ok: true }
    }
    if (rank(me.role) < rank('admin')) throw new HttpError(403, 'This requires the admin role or higher')
    if (target.role === 'owner' || rank(target.role) >= rank(me.role)) throw new HttpError(403, 'You cannot remove a member with an equal or higher role')
    dropMember(org, target, 'removed')
    audit(rc, me.userId, 'org.member.remove', `org:${org.id}`, { userId: target.userId, role: target.role })
    audit(rc, target.userId, 'org.removed', `org:${org.id}`, { by: me.userId })
    return { ok: true }
  }
  r.delete('/api/orgs/:id/members/:userId', (rc) => {
    const { org, me } = scope(rc.user, rc.params.id)
    const target = membership(rc.params.userId, org.id)
    if (!target) throw new HttpError(404, 'Member not found')
    return removeOrLeave(rc, org, me, target)
  })
  r.post('/api/orgs/:id/leave', (rc) => {
    const { org, me } = scope(rc.user, rc.params.id)
    return removeOrLeave(rc, org, me, me)
  })

  r.post('/api/orgs/:id/transfer', async (rc) => {
    const { org, me } = scope(rc.user, rc.params.id, 'owner')
    const b = bodyObj(rc.body)
    if (typeof b.userId !== 'string') throw new HttpError(400, 'userId is required')
    const target = membership(b.userId, org.id)
    if (!target) throw new HttpError(404, 'Member not found')
    if (target.userId === rc.user.id) throw new HttpError(400, 'You already own this organization')
    await confirmPassword(ctx, rc.req, rc.user, b.password)
    confirmSecondFactor(ctx, rc.req, rc.user, b.code)
    tx(db, () => {
      db.update('org_members', target.id, { role: 'owner' })
      db.update('org_members', me.id, { role: 'admin' })
      db.update('org_orgs', org.id, { ownerId: target.userId })
    })
    ctx.events.emit('org.member.role_changed', { orgId: org.id, userId: target.userId, from: target.role, to: 'owner' })
    audit(rc, rc.user.id, 'org.transfer', `org:${org.id}`, { to: target.userId })
    audit(rc, target.userId, 'org.ownership.received', `org:${org.id}`, { from: rc.user.id })
    return { ok: true, ...orgView(db.get('org_orgs', org.id), 'admin') }
  })

  /* ------------------------------------------------------------- invites (admin side) */
  r.get('/api/orgs/:id/invites', ({ user, params }) => {
    const { org } = scope(user, params.id, 'admin')
    return { invites: many(db, 'org_invites', 'orgId', org.id).filter((i) => i.status === 'pending').map(inviteView) }
  })

  r.post('/api/orgs/:id/invites', (rc) => {
    const { org, me } = scope(rc.user, rc.params.id, 'admin')
    const b = bodyObj(rc.body)
    const email = normEmail(b.email)
    const role = b.role ?? 'member'
    if (!['viewer', 'member', 'admin'].includes(role)) throw new HttpError(400, 'role must be viewer, member or admin')
    if (role === 'admin' && me.role !== 'owner') throw new HttpError(403, 'Only the owner can invite admins')
    if (!rateGate(st, `invite:${org.id}`, 50, 3_600_000) || !rateGate(st, `invite-user:${rc.user.id}`, 100, 3_600_000)) throw new HttpError(429, 'Too many invitations, try again later')
    const existing = one(db, 'users', 'email', email)
    if (existing && membership(existing.id, org.id)) throw new HttpError(409, 'That person is already a member')
    // re-inviting replaces the previous pending invitation (and invalidates its link); old closed invitations are dropped after 30 days
    const stale = st.now() - 30 * 864e5
    for (const i of many(db, 'org_invites', 'orgId', org.id)) {
      if ((i.email === email && i.status === 'pending') || Date.parse(i.expiresAt) < stale) db.remove('org_invites', i.id)
    }
    if (many(db, 'org_invites', 'orgId', org.id).filter((i) => i.status === 'pending').length >= LIMITS.pendingInvites) throw new HttpError(409, 'Too many pending invitations')
    if (members(org.id).length >= LIMITS.members) throw new HttpError(409, 'This organization is full')
    const token = crypto.randomBytes(24).toString('base64url')
    const inv = db.insert('org_invites', {
      orgId: org.id, email, role, status: 'pending', invitedBy: rc.user.id, tokenHash: sha(token), expiresAt: new Date(st.now() + LIMITS.inviteTtlMs).toISOString(),
    })
    const link = appUrl(`/#team/invite/${token}`)
    sendMail(st, {
      to: email, subject: `${rc.user.name} invited you to ${org.name} on RD Cloude`, tags: { kind: 'org-invite', orgId: org.id },
      text: `${rc.user.name} (${rc.user.email}) invited you to join "${org.name}" as ${role}.\n\nSign in with ${email} and open:\n${link}\n\nInvitation token: ${token}\nThis invitation expires in 7 days. If you do not know ${rc.user.name}, ignore this message.\n`,
    })
    audit(rc, rc.user.id, 'org.invite.create', `org:${org.id}`, { email, role })
    // The token is shown to the inviter once so the link can be shared by hand when no mail transport is configured.
    // It is useless without signing in as the invited address.
    return [201, { invite: inviteView(inv), token, inviteUrl: link }]
  })

  r.delete('/api/orgs/:id/invites/:inviteId', (rc) => {
    const { org } = scope(rc.user, rc.params.id, 'admin')
    const inv = db.get('org_invites', rc.params.inviteId)
    if (!inv || inv.orgId !== org.id) throw new HttpError(404, 'Invitation not found')
    db.update('org_invites', inv.id, { status: 'revoked' })
    audit(rc, rc.user.id, 'org.invite.revoke', `org:${org.id}`, { email: inv.email })
    return { ok: true }
  })

  /* ------------------------------------------------------------- account lifecycle */
  ctx.events.on('account.deleting', ({ userId, veto }) => {
    for (const o of many(db, 'org_orgs', 'ownerId', userId)) {
      if (members(o.id).some((m) => m.userId !== userId)) veto(`You own the organization "${o.name}", which still has other members. Transfer ownership or delete it first.`)
    }
  })
  ctx.events.on('account.deleted', ({ userId, email }) => {
    for (const o of many(db, 'org_orgs', 'ownerId', userId)) {
      tx(db, () => {
        for (const m of members(o.id)) db.remove('org_members', m.id)
        for (const i of many(db, 'org_invites', 'orgId', o.id)) db.remove('org_invites', i.id)
        db.remove('org_orgs', o.id)
      })
      ctx.events.emit('org.deleted', { orgId: o.id, memberIds: [userId] })
    }
    for (const m of many(db, 'org_members', 'userId', userId)) {
      db.remove('org_members', m.id)
      ctx.events.emit('org.member.removed', { orgId: m.orgId, userId, reason: 'account deleted' })
    }
    for (const i of [...many(db, 'org_invites', 'email', email), ...many(db, 'org_invites', 'invitedBy', userId)]) db.remove('org_invites', i.id)
  })
}
