// Settings: profile name, appearance (theme), keyboard shortcuts and links to the account-level views.
import { icon } from '/icons.js'

async function render(el, _arg, lib) {
  const { h, api, act, toast, getTheme, setTheme } = lib
  const { user } = await api('GET', '/api/me')
  lib.state.me = user

  // ---- profile ---------------------------------------------------------------------------------------------------
  const name = h('input', { id: 'set-name', value: user.name ?? '', maxlength: '80', autocomplete: 'name' })
  const save = h('button', { type: 'submit' }, 'Save')
  const profile = h('form', { class: 'set-card', onsubmit: act(async (e) => {
    e.preventDefault()
    save.disabled = true
    try {
      const r = await api('PATCH', '/api/me', { name: name.value.trim() })
      lib.state.me = r.user ?? { ...user, name: name.value.trim() }
      toast('Profile saved', 'ok')
      window.dispatchEvent(new Event('rd:rerender'))
    } finally { save.disabled = false }
  }) },
  h('h2', {}, 'Profile'),
  h('label', { for: 'set-name' }, 'Display name'), name,
  h('p', { class: 'muted' }, 'Email: ', h('b', {}, user.email), user.emailVerified ? '' : ' (not verified)', user.twoFactorEnabled ? ' · two-factor on' : ''),
  h('div', { class: 'row' }, save))

  // ---- appearance -------------------------------------------------------------------------------------------------
  const themes = [['auto', 'System', 'Follow your device setting', 'auto'], ['light', 'Light', 'Bright background', 'sun'], ['dark', 'Dark', 'Easier on the eyes at night', 'moon']]
  const group = h('div', { class: 'set-themes', role: 'radiogroup', 'aria-label': 'Theme' })
  const paint = () => {
    const cur = getTheme()
    group.replaceChildren(...themes.map(([id, label, hint, ico]) => h('button', { type: 'button', class: `set-theme${cur === id ? ' on' : ''}`, role: 'radio', 'aria-checked': String(cur === id), onclick: () => setTheme(id) },
      icon(ico), h('b', {}, label), h('span', {}, hint))))
  }
  paint()
  const onTheme = () => { if (el.isConnected) paint() }
  window.addEventListener('rd:theme', onTheme)
  const appearance = h('section', { class: 'set-card' }, h('h2', {}, 'Appearance'), group)

  // ---- shortcuts + links --------------------------------------------------------------------------------------------
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
  const shortcuts = h('section', { class: 'set-card' }, h('h2', {}, 'Keyboard'),
    h('dl', { class: 'set-keys' },
      h('dt', {}, h('kbd', {}, mod), ' + ', h('kbd', {}, 'K')), h('dd', {}, 'Open the command palette: jump to any page or run an action'),
      h('dt', {}, h('kbd', {}, 'Esc')), h('dd', {}, 'Close dialogs, menus and the mobile navigation'),
      h('dt', {}, h('kbd', {}, 'Tab')), h('dd', {}, 'Move between controls; the “Skip to content” link appears first')))
  const links = h('section', { class: 'set-card' }, h('h2', {}, 'Account'),
    h('ul', { class: 'set-links' }, ...[
      ['#security', 'security', 'Security', 'Password, two-factor authentication, sessions, audit log'],
      ['#keys', 'keys', 'API keys', 'Scoped keys for the API and CLI'],
      ['#usage', 'usage', 'Usage & billing', 'Plan, quotas, budgets, invoices'],
      ['#team', 'team', 'Team', 'Organizations, members and roles'],
      ['/docs.html', 'prompts', 'API reference', 'Every endpoint with curl examples (OpenAPI at /api/openapi.json)'],
    ].map(([href, ico, label, hint]) => h('li', {}, h('a', { href }, icon(ico), h('span', {}, h('b', {}, label), h('small', {}, hint)))))))

  el.append(h('div', { class: 'page-head' }, h('h1', {}, 'Settings')), h('div', { class: 'set-grid' }, profile, appearance, shortcuts, links))
}

export default { id: 'settings', title: 'Settings', group: 'Account', order: 5, keywords: 'profile appearance theme dark light preferences', render }
