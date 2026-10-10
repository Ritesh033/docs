// Security console: sign-in security, two-factor auth, sessions, API keys, activity log, data export / deletion.
// Also exports mountAccountPage() for the standalone /auth/account page (password reset / email verification links).
// No innerHTML, no inline styles: every node is built with h() (see docs/ARCHITECTURE.md "UI modules").

const TABS = [
  ['overview', 'Overview'], ['password', 'Password'], ['2fa', 'Two-factor'], ['sessions', 'Sessions'],
  ['keys', 'API keys'], ['activity', 'Activity'], ['data', 'Your data'],
]

const SERVICES = [
  ['ai', 'AI & projects'], ['storage', 'Object storage'], ['compute', 'Compute & networking'], ['drive', 'Drive'],
  ['db', 'Databases'], ['billing', 'Billing & usage'], ['orgs', 'Organizations'], ['audit', 'Audit log'],
]

const ACTIONS = {
  'auth.login': 'Signed in', 'auth.login.failed': 'Failed sign-in attempt', 'auth.logout': 'Signed out', 'auth.register': 'Account created',
  'auth.password.change': 'Password changed', 'auth.password.reset': 'Password reset', 'auth.password.reset_requested': 'Password reset requested',
  'auth.email.verified': 'Email verified', 'auth.2fa.setup': 'Two-factor setup started', 'auth.2fa.enabled': 'Two-factor enabled',
  'auth.2fa.disabled': 'Two-factor disabled', 'auth.2fa.failed': 'Failed verification code', 'auth.2fa.recovery_regenerated': 'Recovery codes regenerated',
  'auth.key.create': 'API key created', 'auth.key.revoke': 'API key revoked', 'auth.session.revoke': 'Session revoked',
  'auth.session.revoke_others': 'Other sessions revoked', 'account.export': 'Data exported', 'account.profile.update': 'Profile updated',
  'access.denied': 'Access denied', 'http.delete': 'Deleted a resource', 'org.create': 'Organization created', 'org.delete': 'Organization deleted',
  'org.rename': 'Organization renamed', 'org.invite.create': 'Invitation sent', 'org.invite.accept': 'Invitation accepted', 'org.invite.decline': 'Invitation declined',
  'org.invite.revoke': 'Invitation revoked', 'org.member.joined': 'Member joined', 'org.member.role': 'Member role changed', 'org.role.changed': 'Your role changed',
  'org.member.remove': 'Member removed', 'org.removed': 'Removed from an organization', 'org.leave': 'Left an organization',
  'org.transfer': 'Ownership transferred', 'org.ownership.received': 'Ownership received',
}
const FILTERS = [['', 'Everything'], ['auth.login*', 'Sign-ins'], ['auth.*', 'Security changes'], ['org.*', 'Organizations'], ['access.denied', 'Denied requests'], ['http.delete', 'Deletions']]

function kit(lib) {
  const { h } = lib
  const uid = () => `sec-${Math.random().toString(36).slice(2, 9)}`
  const card = (title, ...kids) => h('section', { class: 'sec-card' }, title ? h('h2', { class: 'sec-h' }, title) : null, ...kids)
  const field = (label, input, hint) => {
    input.id = input.id || uid()
    return h('div', { class: 'sec-field' }, h('label', { for: input.id }, label), input, hint ? h('small', { class: 'sec-hint' }, hint) : null)
  }
  const msg = () => h('p', { class: 'sec-msg', role: 'status', 'aria-live': 'polite' })
  const say = (m, text, kind = 'info') => { m.textContent = text ?? ''; m.className = `sec-msg sec-${kind}` }
  const badge = (text, kind = 'muted') => h('span', { class: `sec-badge sec-${kind}` }, text)
  /** Wrap a submit/click handler: prevents default, shows failures inline next to the form. */
  const run = (m, fn) => async (e) => {
    e?.preventDefault?.()
    say(m, '')
    try { await fn(e) } catch (err) { say(m, err.message, 'bad') }
  }
  const copy = async (text, label = 'Copied') => {
    try { await navigator.clipboard.writeText(text); lib.toast(label) } catch { lib.toast('Copy failed: select the text and copy it manually', 'error') }
  }
  const password = (name, label, extra = {}) => field(label, h('input', { type: 'password', name, autocomplete: extra.autocomplete ?? 'current-password', required: true, maxlength: 256, ...extra.attrs }), extra.hint)
  // data-label lets the stylesheet turn rows into stacked cards on narrow screens
  const table = (head, rows) => {
    for (const tr of rows) [...tr.children].forEach((td, i) => td.setAttribute('data-label', head[i] ?? ''))
    return h('div', { class: 'sec-scroll' }, h('table', { class: 'sec-table' },
      h('thead', {}, h('tr', {}, ...head.map((x) => h('th', { scope: 'col' }, x)))), h('tbody', {}, ...rows)))
  }
  return { h, card, field, msg, say, badge, run, copy, password, table }
}

/* ------------------------------------------------------------------ overview */
async function overview(box, lib, k) {
  const { h } = k
  const [{ user }, tfa, { sessions }, { keys }, fails] = await Promise.all([
    lib.api('GET', '/api/me'), lib.api('GET', '/api/auth/2fa'), lib.api('GET', '/api/auth/sessions'), lib.api('GET', '/api/keys'),
    lib.api('GET', '/api/audit?action=auth.login.failed&limit=20').catch(() => ({ entries: [] })),
  ])
  const week = Date.now() - 7 * 864e5
  const recentFails = fails.entries.filter((e) => Date.parse(e.ts) > week).length
  const fullKeys = keys.filter((x) => !x.revoked && !x.scopes && !(x.expiresAt && Date.parse(x.expiresAt) < Date.now()))
  const checks = []
  const m = k.msg()
  checks.push({
    ok: user.emailVerified, title: 'Email address verified',
    detail: user.emailVerified ? user.email : `${user.email} has not been verified yet. Password reset and invitations rely on it.`,
    action: user.emailVerified ? null : h('button', { class: 'sec', type: 'button', onclick: k.run(m, async () => { await lib.api('POST', '/api/auth/verify-email/resend'); k.say(m, 'Verification email sent. Check your inbox.', 'ok') }) }, 'Resend email'),
  })
  checks.push({
    ok: tfa.enabled, title: 'Two-factor authentication', detail: tfa.enabled ? `On since ${lib.fmtDate(tfa.enabledAt)}` : 'Off. A stolen password alone is enough to sign in.',
    action: h('a', { class: 'sec-link', href: '#security/2fa' }, tfa.enabled ? 'Manage' : 'Turn on'),
  })
  checks.push({
    ok: sessions.length <= 3, title: `${sessions.length} active session${sessions.length === 1 ? '' : 's'}`, detail: 'Sign out devices you no longer use.',
    action: h('a', { class: 'sec-link', href: '#security/sessions' }, 'Review'),
  })
  checks.push({
    ok: fullKeys.length === 0, title: fullKeys.length ? `${fullKeys.length} API key${fullKeys.length === 1 ? ' has' : 's have'} full access` : 'API keys are limited',
    detail: fullKeys.length ? 'Keys without scopes can do everything the account can. Prefer scoped keys with an expiry.' : 'No unrestricted keys.',
    action: h('a', { class: 'sec-link', href: '#security/keys' }, 'Review'),
  })
  checks.push({
    ok: recentFails === 0, title: recentFails ? `${recentFails} failed sign-in attempt${recentFails === 1 ? '' : 's'} this week` : 'No failed sign-ins this week',
    detail: recentFails ? 'If this was not you, change your password and turn on two-factor.' : 'Nothing unusual.',
    action: h('a', { class: 'sec-link', href: '#security/activity' }, 'Activity'),
  })

  const name = h('input', { name: 'name', value: user.name, maxlength: 80, required: true, autocomplete: 'name' })
  const pm = k.msg()
  box.append(
    k.card('Security checkup', h('ul', { class: 'sec-checks' }, ...checks.map((c) => h('li', { class: 'sec-check' },
      k.badge(c.ok ? 'OK' : 'Attention', c.ok ? 'ok' : 'warn'), h('div', { class: 'sec-check-body' }, h('strong', {}, c.title), h('span', { class: 'sec-muted' }, c.detail)), c.action ?? null))), m),
    k.card('Profile', h('form', { class: 'sec-form', onsubmit: k.run(pm, async () => { await lib.api('PATCH', '/api/me', { name: name.value }); k.say(pm, 'Saved.', 'ok') }) },
      k.field('Display name', name), k.field('Email', h('input', { value: user.email, readonly: true, 'aria-readonly': 'true' })),
      h('div', { class: 'sec-actions' }, h('button', { type: 'submit' }, 'Save'), pm))),
  )
}

/* ------------------------------------------------------------------ password */
async function passwordTab(box, lib, k) {
  const { h } = k
  const m = k.msg()
  const cur = k.password('currentPassword', 'Current password')
  const next = k.password('newPassword', 'New password', { autocomplete: 'new-password', attrs: { minlength: 8 }, hint: 'At least 8 characters. Longer is better: try three or four unrelated words.' })
  const again = k.password('confirm', 'Repeat new password', { autocomplete: 'new-password' })
  const val = (f) => f.querySelector('input').value
  box.append(k.card('Change password',
    h('p', { class: 'sec-muted' }, 'Changing your password signs out every other device. You stay signed in here.'),
    h('form', { class: 'sec-form', onsubmit: k.run(m, async (e) => {
      if (val(next) !== val(again)) throw new Error('The new passwords do not match')
      const r = await lib.api('POST', '/api/auth/password/change', { currentPassword: val(cur), newPassword: val(next) })
      lib.state.token = r.token
      try { localStorage.setItem('rd_token', r.token) } catch { /* private mode: the in-memory token still works */ }
      e.target.reset()
      k.say(m, r.warnings?.length ? `Password changed. Note: ${r.warnings[0]}.` : 'Password changed. Other devices were signed out.', r.warnings?.length ? 'warn' : 'ok')
    }) }, cur, next, again, h('div', { class: 'sec-actions' }, h('button', { type: 'submit' }, 'Change password'), m))),
  k.card('Forgot your password?', h('p', { class: 'sec-muted' }, 'If you cannot sign in, you can request a reset link by email from the '),
    h('a', { class: 'sec-link', href: '/auth/account#mode=forgot' }, 'password reset page'), '.'))
}

/* ------------------------------------------------------------------ two-factor */
async function twofaTab(box, lib, k) {
  const { h } = k
  const groups = (s) => s.match(/.{1,4}/g).join(' ')

  const intro = () => {
    const m = k.msg()
    const pw = k.password('password', 'Confirm your password')
    return k.card('Two-factor authentication',
      h('p', {}, 'Add a second step to sign-in: a 6-digit code from an authenticator app (Google Authenticator, 1Password, Authy, Aegis...). Codes are standard TOTP (RFC 6238).'),
      h('form', { class: 'sec-form', onsubmit: k.run(m, async () => { showSecret(await lib.api('POST', '/api/auth/2fa/setup', { password: pw.querySelector('input').value })) }) },
        pw, h('div', { class: 'sec-actions' }, h('button', { type: 'submit' }, 'Set up two-factor'), m)))
  }

  const showSecret = (d) => {
    const m = k.msg()
    const code = h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9 ]{6,7}', maxlength: 7, required: true, placeholder: '123456' })
    box.replaceChildren(k.card('Set up your authenticator',
      h('ol', { class: 'sec-steps' },
        h('li', {}, 'Open your authenticator app and add a new time-based account.'),
        h('li', {}, 'On a phone with the app installed, tap ', h('a', { class: 'sec-link', href: d.otpauthUri }, 'this setup link'), '. Otherwise choose "enter a setup key" and type:',
          h('div', { class: 'sec-secret', 'aria-label': 'Setup key' }, h('code', {}, groups(d.secret)),
            h('button', { class: 'sec', type: 'button', onclick: () => k.copy(d.secret, 'Setup key copied') }, 'Copy')),
          h('small', { class: 'sec-hint' }, `Account: ${d.account} - Issuer: ${d.issuer} - ${d.digits} digits, ${d.period}s, ${d.algorithm}`)),
        h('li', {}, 'Enter the 6-digit code the app shows to confirm.')),
      h('form', { class: 'sec-form', onsubmit: k.run(m, async () => {
        const r = await lib.api('POST', '/api/auth/2fa/enable', { code: code.value })
        showCodes(r.recoveryCodes)
      }) }, k.field('Verification code', code), h('div', { class: 'sec-actions' }, h('button', { type: 'submit' }, 'Verify and turn on'),
        h('button', { class: 'sec', type: 'button', onclick: () => draw() }, 'Cancel'), m))))
    code.focus()
  }

  const codesBlock = (codes) => h('div', {},
    h('ul', { class: 'sec-codes' }, ...codes.map((c) => h('li', {}, h('code', {}, c)))),
    h('div', { class: 'sec-actions' },
      h('button', { class: 'sec', type: 'button', onclick: () => k.copy(codes.join('\n'), 'Recovery codes copied') }, 'Copy all'),
      h('button', { class: 'sec', type: 'button', onclick: () => lib.download(new Blob([`RD Cloude recovery codes\n${new Date().toISOString()}\n\n${codes.join('\n')}\n`], { type: 'text/plain' }), 'rd-cloude-recovery-codes.txt') }, 'Download')))

  const showCodes = (codes, title = 'Two-factor is on. Save your recovery codes') => {
    const done = h('button', { type: 'button', disabled: true, onclick: () => draw() }, 'Done')
    const ack = h('input', { type: 'checkbox', id: 'sec-ack', onchange: () => { done.disabled = !ack.checked } })
    box.replaceChildren(k.card(title,
      h('p', {}, 'Each code works once if you lose your authenticator. Store them somewhere safe (a password manager, not this device only). They are shown only now.'),
      codesBlock(codes), h('div', { class: 'sec-ack' }, ack, h('label', { for: 'sec-ack' }, 'I have saved these recovery codes')), h('div', { class: 'sec-actions' }, done)))
  }

  const enabledView = (st) => {
    const low = st.recoveryCodesRemaining <= 2
    const m1 = k.msg()
    const m2 = k.msg()
    const regenPw = k.password('password', 'Password')
    const regenCode = k.field('Authenticator or recovery code', h('input', { name: 'code', autocomplete: 'one-time-code', required: true, maxlength: 16 }))
    const offPw = k.password('password', 'Password')
    const offCode = k.field('Authenticator or recovery code', h('input', { name: 'code', autocomplete: 'one-time-code', required: true, maxlength: 16 }))
    const body = (...f) => ({ password: f[0].querySelector('input').value, code: f[1].querySelector('input').value })
    return h('div', {},
      k.card('Two-factor authentication', h('p', {}, k.badge('On', 'ok'), ` since ${lib.fmtDate(st.enabledAt)}`),
        h('p', {}, k.badge(`${st.recoveryCodesRemaining} of 10 recovery codes left`, low ? 'warn' : 'muted'), low ? ' Generate new codes soon.' : null)),
      k.card('Recovery codes', h('details', {}, h('summary', {}, 'Generate new recovery codes'),
        h('p', { class: 'sec-muted' }, 'This invalidates all previous codes. A fresh authenticator code or an unused recovery code is required (codes already used to sign in cannot be reused: wait for the next one).'),
        h('form', { class: 'sec-form', onsubmit: k.run(m1, async () => { showCodes((await lib.api('POST', '/api/auth/2fa/recovery-codes', body(regenPw, regenCode))).recoveryCodes, 'Your new recovery codes') }) },
          regenPw, regenCode, h('div', { class: 'sec-actions' }, h('button', { type: 'submit' }, 'Generate new codes'), m1)))),
      k.card('Turn off', h('details', {}, h('summary', {}, 'Turn off two-factor authentication'),
        h('p', { class: 'sec-muted' }, 'Your account will be protected by your password alone.'),
        h('form', { class: 'sec-form', onsubmit: k.run(m2, async () => {
          if (!(await lib.confirmDialog('Turn off two-factor authentication?', 'Turn off'))) return
          await lib.api('POST', '/api/auth/2fa/disable', body(offPw, offCode))
          lib.toast('Two-factor authentication is off')
          draw()
        }) }, offPw, offCode, h('div', { class: 'sec-actions' }, h('button', { class: 'sec-danger', type: 'submit' }, 'Turn off'), m2)))))
  }

  async function draw() {
    const st = await lib.api('GET', '/api/auth/2fa')
    box.replaceChildren(st.enabled ? enabledView(st) : intro())
  }
  await draw()
}

/* ------------------------------------------------------------------ sessions */
async function sessionsTab(box, lib, k) {
  const { h } = k
  const { sessions } = await lib.api('GET', '/api/auth/sessions')
  const m = k.msg()
  const rows = sessions.map((s) => h('tr', {},
    h('td', {}, h('strong', {}, s.device), s.current ? [' ', k.badge('This device', 'ok')] : null, s.mfa ? [' ', k.badge('2FA', 'muted')] : null),
    h('td', {}, s.lastIp ?? s.ip ?? ''), h('td', {}, lib.fmtDate(s.createdAt)), h('td', {}, lib.fmtDate(s.lastSeenAt)),
    h('td', {}, s.current ? h('span', { class: 'sec-muted' }, 'Use Sign out') : h('button', { class: 'sec', type: 'button', onclick: k.run(m, async () => {
      await lib.api('DELETE', `/api/auth/sessions/${s.id}`)
      lib.rerender()
    }) }, 'Sign out'))))
  const others = sessions.filter((s) => !s.current).length
  box.append(k.card('Where you are signed in',
    h('p', { class: 'sec-muted' }, 'Sessions expire after 7 days without activity, or 30 days in total. At most 10 devices stay signed in at once.'),
    k.table(['Device', 'IP address', 'Signed in', 'Last active', ''], rows),
    h('div', { class: 'sec-actions' }, h('button', { class: 'sec', type: 'button', disabled: !others, onclick: k.run(m, async () => {
      if (!(await lib.confirmDialog(`Sign out ${others} other session${others === 1 ? '' : 's'}?`, 'Sign out'))) return
      const r = await lib.api('POST', '/api/auth/sessions/revoke-others')
      lib.toast(`${r.revoked} session${r.revoked === 1 ? '' : 's'} signed out`)
      lib.rerender()
    }) }, 'Sign out all other sessions'), m)))
}

/* ------------------------------------------------------------------ API keys */
async function keysTab(box, lib, k) {
  const { h } = k
  const m = k.msg()
  const name = h('input', { name: 'name', maxlength: 80, placeholder: 'e.g. CI deploy', autocomplete: 'off' })
  const mode = h('select', { name: 'mode' }, h('option', { value: 'limited' }, 'Limited (recommended)'), h('option', { value: 'full' }, 'Full access (everything this account can do)'))
  const expiry = h('select', { name: 'expiry' }, ...[['', 'Never expires'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['365', '1 year']].map(([v, t]) => h('option', { value: v, selected: v === '90' }, t)))
  const global = h('select', { name: 'global' }, h('option', { value: '' }, 'No blanket access'), h('option', { value: 'read' }, 'Read everything'), h('option', { value: 'write' }, 'Read and write everything'))
  const svc = SERVICES.map(([id, label]) => ({ id, label, sel: h('select', { 'aria-label': label }, h('option', { value: '' }, 'No access'), h('option', { value: 'read' }, 'Read'), h('option', { value: 'full' }, 'Read and write')) }))
  const acct = h('input', { type: 'checkbox', id: 'sec-acct' })
  const limited = h('fieldset', { class: 'sec-scopes' }, h('legend', {}, 'Access'),
    k.field('Everything except account settings', global, 'Blanket read or write across all services. Account, key and password management are never included.'),
    h('div', { class: 'sec-scope-grid' }, ...svc.map((s) => h('div', { class: 'sec-scope' }, h('span', {}, s.label), s.sel))),
    h('div', { class: 'sec-ack' }, acct, h('label', { for: 'sec-acct' }, 'Allow managing keys and account settings (powerful)')))
  const syncMode = () => { limited.hidden = mode.value === 'full' }
  mode.addEventListener('change', syncMode)
  const secretBox = h('div', {})

  const scopesFromForm = () => {
    const out = []
    if (global.value) out.push(global.value)
    for (const s of svc) if (s.sel.value === 'read') out.push(`${s.id}:read`); else if (s.sel.value === 'full') out.push(s.id)
    if (acct.checked) out.push('account')
    return out
  }
  const create = h('form', { class: 'sec-form sec-wide', onsubmit: k.run(m, async () => {
    const body = { name: name.value.trim() || 'default' }
    if (mode.value === 'limited') {
      body.scopes = scopesFromForm()
      if (!body.scopes.length) throw new Error('Choose at least one kind of access, or select Full access')
    } else if (!(await lib.confirmDialog('Create a key with full access? Anyone holding it can do everything your account can, except interactive actions like changing the password.', 'Create'))) return
    if (expiry.value) body.expiresInDays = Number(expiry.value)
    const r = await lib.api('POST', '/api/keys', body)
    secretBox.replaceChildren(h('div', { class: 'sec-card sec-new' }, h('strong', {}, 'Copy your key now. It will not be shown again.'),
      h('div', { class: 'sec-secret' }, h('code', {}, r.secret), h('button', { class: 'sec', type: 'button', onclick: () => k.copy(r.secret, 'Key copied') }, 'Copy')),
      h('small', { class: 'sec-hint' }, 'Use it as: Authorization: Bearer rdk_...')))
    name.value = ''
    await refresh()
  }) }, k.field('Name', name), k.field('Type', mode), k.field('Expires', expiry), limited, h('div', { class: 'sec-actions' }, h('button', { type: 'submit' }, 'Create key'), m))

  const listBox = h('div', {})
  const scopeBadges = (key) => (key.scopes ? key.scopes.map((s) => k.badge(s, 'muted')) : [k.badge('full access', 'warn')])
  async function refresh() {
    const { keys: fresh } = await lib.api('GET', '/api/keys')
    const live = fresh.filter((x) => !x.revoked)
    const rows = live.map((key) => {
      const expired = key.expiresAt && Date.parse(key.expiresAt) < Date.now()
      return h('tr', {},
        h('td', {}, h('strong', {}, key.name), h('div', { class: 'sec-muted' }, `${key.prefix}...`)),
        h('td', { class: 'sec-badges' }, ...scopeBadges(key).flatMap((b) => [b, ' '])),
        h('td', {}, key.expiresAt ? (expired ? k.badge('expired', 'bad') : lib.fmtDate(key.expiresAt)) : 'never'),
        h('td', {}, key.lastUsedAt ? `${lib.fmtDate(key.lastUsedAt)}${key.lastUsedIp ? ` from ${key.lastUsedIp}` : ''}` : 'never used'),
        h('td', {}, h('button', { class: 'sec', type: 'button', onclick: k.run(m, async () => {
          if (!(await lib.confirmDialog(`Revoke "${key.name}"? Anything using it stops working immediately.`, 'Revoke'))) return
          await lib.api('DELETE', `/api/keys/${key.id}`)
          await refresh()
        }) }, 'Revoke')))
    })
    listBox.replaceChildren(live.length ? k.table(['Key', 'Access', 'Expires', 'Last used', ''], rows) : h('p', { class: 'sec-muted' }, 'No active keys.'))
  }
  box.append(k.card('Create an API key', secretBox, create), k.card('Your keys', listBox))
  syncMode()
  await refresh()
}

/* ------------------------------------------------------------------ activity */
async function activityTab(box, lib, k) {
  const { h } = k
  const filter = h('select', { name: 'filter', 'aria-label': 'Filter activity', onchange: () => load(true) }, ...FILTERS.map(([v, t]) => h('option', { value: v }, t)))
  const list = h('ol', { class: 'sec-log' })
  const more = h('button', { class: 'sec', type: 'button', hidden: true, onclick: () => load(false) }, 'Load more')
  const status = k.msg()
  const verifyOut = k.msg()
  let cursor = null
  async function load(reset) {
    if (reset) { cursor = null; list.replaceChildren() }
    const q = new URLSearchParams({ limit: '25' })
    if (filter.value) q.set('action', filter.value)
    if (cursor) q.set('cursor', cursor)
    try {
      const r = await lib.api('GET', `/api/audit?${q}`)
      for (const e of r.entries) {
        list.append(h('li', { class: `sec-log-item${e.action === 'auth.login.failed' || e.action === 'access.denied' ? ' sec-log-warn' : ''}` },
          h('div', {}, h('strong', {}, ACTIONS[e.action] ?? e.action), e.resource ? h('span', { class: 'sec-muted' }, ` ${e.resource}`) : null),
          h('div', { class: 'sec-muted' }, `${lib.fmtDate(e.ts)}${e.ip ? ` - ${e.ip}` : ''}`)))
      }
      cursor = r.nextCursor
      more.hidden = !cursor
      k.say(status, list.children.length ? '' : 'Nothing recorded yet.', 'info')
    } catch (err) { k.say(status, err.message, 'bad') }
  }
  box.append(k.card('Account activity',
    h('p', { class: 'sec-muted' }, 'A tamper-evident record of sign-ins and security-relevant changes. Entries are chained with a keyed hash, so edits or deletions are detected.'),
    h('div', { class: 'sec-actions' }, filter, h('button', { class: 'sec', type: 'button', onclick: k.run(verifyOut, async () => {
      const v = await lib.api('GET', '/api/audit/verify')
      k.say(verifyOut, v.ok ? `Integrity verified: ${v.count} entries, chain intact.` : `Integrity check FAILED at entry ${v.error?.seq}: ${v.error?.reason}.`, v.ok ? 'ok' : 'bad')
    }) }, 'Verify integrity'), verifyOut), list, status, more))
  await load(true)
}

/* ------------------------------------------------------------------ data export / deletion */
async function dataTab(box, lib, k) {
  const { h } = k
  const tfa = await lib.api('GET', '/api/auth/2fa')
  const m1 = k.msg()
  const m2 = k.msg()
  const pw = k.password('password', 'Password')
  const code = k.field('Authenticator or recovery code', h('input', { name: 'code', autocomplete: 'one-time-code', maxlength: 16 }))
  const sure = h('input', { type: 'checkbox', id: 'sec-sure' })
  box.append(
    k.card('Export your data', h('p', { class: 'sec-muted' }, 'Download everything RD Cloude holds about you as one JSON file: profile, conversations, artifacts, metadata of files, buckets, databases, sessions, keys (without secrets) and your activity log. File contents are not included: download them from Drive or Storage. Limited to 5 exports per hour.'),
      h('div', { class: 'sec-actions' }, h('button', { type: 'button', onclick: k.run(m1, async () => {
        const data = await lib.api('GET', '/api/account/export')
        lib.download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `rd-cloude-export-${new Date().toISOString().slice(0, 10)}.json`)
        k.say(m1, 'Export downloaded.', 'ok')
      }) }, 'Download my data'), m1)),
    k.card('Delete account', h('div', { class: 'sec-danger-zone' },
      h('p', {}, 'This permanently deletes your account and everything in it: chats, artifacts, files, buckets, databases, instances, keys and logs. It cannot be undone. Organizations you own must be transferred or deleted first.'),
      h('form', { class: 'sec-form', onsubmit: k.run(m2, async () => {
        if (!sure.checked) throw new Error('Tick the box to confirm')
        if (!(await lib.confirmDialog('Delete your account and all data permanently?', 'Delete everything'))) return
        const body = { password: pw.querySelector('input').value }
        if (tfa.enabled) body.code = code.querySelector('input').value
        await lib.api('DELETE', '/api/account', body)
        try { localStorage.removeItem('rd_token') } catch { /* ignore */ }
        location.hash = ''
        location.reload()
      }) }, pw, tfa.enabled ? code : null,
      h('div', { class: 'sec-ack' }, sure, h('label', { for: 'sec-sure' }, 'I understand this is permanent')),
      h('div', { class: 'sec-actions' }, h('button', { class: 'sec-danger', type: 'submit' }, 'Delete my account'), m2)))),
  )
}

const RENDERERS = { overview, password: passwordTab, '2fa': twofaTab, sessions: sessionsTab, keys: keysTab, activity: activityTab, data: dataTab }

const securityView = {
  id: 'security',
  title: 'Security',
  group: 'Account',
  order: 30,
  async render(el, arg, lib) {
    const k = kit(lib)
    const tab = RENDERERS[arg] ? arg : 'overview'
    const box = k.h('div', { class: 'sec-pane' })
    el.append(k.h('div', { class: 'sec-root' },
      k.h('h1', {}, 'Security'),
      k.h('div', { class: 'sec-tabs', role: 'navigation', 'aria-label': 'Security sections' }, ...TABS.map(([id, label]) => k.h('a', { class: `sec-tab${id === tab ? ' on' : ''}`, href: `#security/${id}`, 'aria-current': id === tab ? 'page' : null }, label))),
      box))
    await RENDERERS[tab](box, lib, k)
  },
}

// Replaces the console's built-in "API keys" view (same id) so keys can be created with scopes and an expiry.
const keysView = {
  id: 'keys',
  title: 'API keys',
  group: 'Account',
  order: 10,
  async render(el, arg, lib) {
    const k = kit(lib)
    const box = k.h('div', { class: 'sec-pane' })
    el.append(k.h('div', { class: 'sec-root' }, k.h('h1', {}, 'API keys'),
      k.h('p', { class: 'sec-muted' }, 'Use a key as: Authorization: Bearer rdk_... Limit what it can do and let it expire; revoke it any time.'), box))
    await keysTab(box, lib, k)
  },
}

export default [securityView, keysView]

/* ------------------------------------------------------------------ standalone page: /auth/account#mode=reset&token=... */
export function mountAccountPage(root, lib) {
  const k = kit(lib)
  const { h } = k
  const params = new URLSearchParams(location.hash.slice(1))
  const mode = ['forgot', 'reset', 'verify', 'signin'].includes(params.get('mode')) ? params.get('mode') : 'forgot'
  const token = params.get('token') ?? ''
  try { history.replaceState(null, '', location.pathname) } catch { /* ignore */ } // keep the token out of the address bar / history
  const home = h('a', { class: 'sec-link', href: '/' }, 'Back to sign in')
  const shell = (title, ...kids) => root.replaceChildren(h('div', { class: 'sec-root sec-narrow' }, h('h1', {}, 'RD Cloude'), k.card(title, ...kids)))

  if (mode === 'verify') {
    const out = h('p', { role: 'status' }, 'Verifying your email address...')
    shell('Email verification', out, home)
    lib.api('POST', '/api/auth/verify-email', { token })
      .then(() => { out.textContent = 'Your email address is verified. Thank you.' })
      .catch((e) => { out.textContent = `${e.message}. Request a new link from the Security page.` })
    return
  }
  const m = k.msg()
  if (mode === 'signin') {
    // Password + second factor in two steps. Stores the session exactly like the console's own sign-in.
    const email = h('input', { type: 'email', name: 'email', required: true, autocomplete: 'username', maxlength: 254 })
    const pw = k.password('password', 'Password')
    const code = h('input', { name: 'code', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: 16 }) // required only once its step is visible
    let challenge = null
    const finish = (r) => {
      try { localStorage.setItem('rd_token', r.token) } catch { /* ignore */ }
      location.replace('/')
    }
    const post = async (path, body) => {
      const res = await lib.api('POST', path, body, { response: true })
      return { status: res.status, data: await res.json().catch(() => ({})) }
    }
    const form = h('form', { class: 'sec-form', onsubmit: k.run(m, async () => {
      if (!challenge) {
        const r = await post('/api/auth/login', { email: email.value, password: pw.querySelector('input').value })
        if (r.data.token) return finish(r.data)
        if (!r.data.twoFactorRequired) throw new Error(r.data.error || 'Sign-in failed')
        challenge = r.data.challenge
        step.hidden = false
        code.required = true
        email.readOnly = true
        pw.hidden = true
        code.focus()
        return k.say(m, 'Enter the 6-digit code from your authenticator app, or a recovery code.', 'info')
      }
      const r = await post('/api/auth/login/2fa', { challenge, code: code.value })
      if (!r.data.token) throw new Error(r.data.error || 'Verification failed')
      finish(r.data)
    }) })
    const step = k.field('Verification code', code)
    step.hidden = true
    form.append(k.field('Email', email), pw, step, h('div', { class: 'sec-actions' }, h('button', { type: 'submit' }, 'Sign in'), m))
    shell('Sign in with two-factor', form, home)
    return
  }
  if (mode === 'reset') {
    const pw = k.password('password', 'New password', { autocomplete: 'new-password', attrs: { minlength: 8 } })
    const again = k.password('confirm', 'Repeat new password', { autocomplete: 'new-password' })
    shell('Choose a new password', h('form', { class: 'sec-form', onsubmit: k.run(m, async (e) => {
      if (pw.querySelector('input').value !== again.querySelector('input').value) throw new Error('The passwords do not match')
      await lib.api('POST', '/api/auth/password/reset', { token, password: pw.querySelector('input').value })
      e.target.replaceWith(h('p', { role: 'status' }, 'Password updated. Every device was signed out; sign in with your new password.'), home)
    }) }, pw, again, h('div', { class: 'sec-actions' }, h('button', { type: 'submit' }, 'Set password'), m)))
    return
  }
  const email = h('input', { type: 'email', name: 'email', required: true, autocomplete: 'email', maxlength: 254 })
  shell('Reset your password', h('p', { class: 'sec-muted' }, 'Enter your account email. If it exists, we send a link that works once for 30 minutes.'),
    h('form', { class: 'sec-form', onsubmit: k.run(m, async (e) => {
      const r = await lib.api('POST', '/api/auth/password/forgot', { email: email.value })
      e.target.replaceWith(h('p', { role: 'status' }, r.message), home)
    }) }, k.field('Email', email), h('div', { class: 'sec-actions' }, h('button', { type: 'submit' }, 'Send reset link'), m)), home)
}
