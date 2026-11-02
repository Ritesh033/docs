// Usage: node scripts/browser-check.mjs <port> [hash ...] [--shots <dir>] [--no-smoke]
// Registers a fresh user in headless Chromium, visits each #hash view and reports console/page errors
// and any rendered `#view .err` message, then runs a keyboard/accessibility smoke test of the shell (skip link, command palette,
// theme toggle, mobile drawer). With --shots, saves light/dark screenshots at 1280x800 and 390x844 into <dir>.
// Exit code 1 if anything was reported. Uses the globally installed playwright.
import { execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const argv = process.argv.slice(2)
const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return null; const [, v] = argv.splice(i, name === '--shots' ? 2 : 1); return v ?? true }
const shotsDir = flag('--shots')
const noSmoke = flag('--no-smoke')
const [port = '3000', ...hashes] = argv
const globalRoot = execSync('npm root -g').toString().trim()
const { chromium } = await import(pathToFileURL(path.join(globalRoot, 'playwright/index.mjs')).href)
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const problems = []
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_NAME_NOT_RESOLVED|Failed to load resource.*404/.test(m.text()) && problems.push(`console: ${m.text()}`))
const base = `http://localhost:${port}`
await page.goto(base + '/')
await page.click('#toggleMode')
await page.fill('[name=email]', `bc${Date.now()}@rd.dev`)
await page.fill('[name=password]', 'password123')
await page.click('button[type=submit]')
await page.waitForSelector('#app:not([hidden])', { timeout: 10000 })
await page.waitForSelector('#nav a', { timeout: 10000 }).catch(() => problems.push('nav never rendered any links'))
const navLinks = await page.$$eval('#nav a', (as) => as.map((a) => a.hash))
console.log('nav:', navLinks.join(' '))
for (const h of hashes.length ? hashes : navLinks) {
  await page.goto(`${base}/${h.startsWith('#') ? h : '#' + h}`)
  await page.waitForTimeout(400)
  const err = await page.locator('#view .err').first().textContent({ timeout: 500 }).catch(() => null)
  if (err) problems.push(`${h}: view error: ${err}`)
  const empty = (await page.locator('#view').innerText()).trim() === ''
  if (empty) problems.push(`${h}: view rendered empty`)
}

async function check(cond, message) { if (!(await cond())) problems.push(`smoke: ${message}`) }
if (!noSmoke) {
  await page.goto(`${base}/#home`)
  await page.waitForSelector('#view .hm-tile', { timeout: 5000 }).catch(() => problems.push('smoke: home dashboard tiles never rendered'))
  // skip link is first in tab order and moves focus into <main>
  await page.reload() // a fresh document, so the sequential-focus starting point is the top of the page
  await page.waitForSelector('#view .hm-tile', { timeout: 5000 })
  await page.keyboard.press('Tab')
  await check(async () => (await page.evaluate(() => document.activeElement?.id)) === 'skip', 'first Tab stop is not the skip link')
  await page.keyboard.press('Enter')
  await check(async () => (await page.evaluate(() => document.activeElement?.id)) === 'view', 'skip link did not focus main')
  // command palette: open, filter, navigate with the keyboard
  await page.keyboard.press('Control+k')
  await check(() => page.locator('dialog.palette[open]').isVisible(), 'Ctrl+K did not open the command palette')
  await page.keyboard.type('sql')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  await check(async () => (await page.evaluate(() => location.hash)) === '#sql', 'palette did not navigate to #sql')
  await check(async () => (await page.locator('dialog.palette').count()) === 0, 'palette stayed open after selecting')
  await check(async () => /SQL/.test(await page.title()), 'document title not updated on navigation')
  // theme toggle cycles and persists
  const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  await page.click('#themeBtn')
  const after = await page.evaluate(() => [document.documentElement.getAttribute('data-theme'), localStorage.getItem('rd_theme')])
  await check(async () => after[0] !== before && after[0] === after[1], 'theme toggle did not apply/persist a theme')
  await page.evaluate(() => { localStorage.removeItem('rd_theme'); document.documentElement.removeAttribute('data-theme') })
  // mobile drawer: hidden links are not focusable; open traps focus; Esc closes
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${base}/#home`)
  await page.waitForSelector('#menuBtn', { state: 'visible' })
  await page.waitForTimeout(350) // drawer transition
  await check(async () => !(await page.locator('#nav a').first().isVisible()), 'mobile nav links visible while the drawer is closed')
  await page.click('#menuBtn')
  await check(() => page.locator('#nav a').first().isVisible(), 'mobile drawer did not open')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(350)
  await check(async () => !(await page.locator('#nav a').first().isVisible()), 'Esc did not close the mobile drawer')
  await check(async () => (await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)), 'horizontal overflow at 390px on #home')
  await page.setViewportSize({ width: 1280, height: 800 })
}
if (shotsDir) {
  const fs = await import('node:fs')
  fs.mkdirSync(shotsDir, { recursive: true })
  for (const [label, scheme, vp] of [['desktop-light', 'light', { width: 1280, height: 800 }], ['desktop-dark', 'dark', { width: 1280, height: 800 }], ['mobile-light', 'light', { width: 390, height: 844 }], ['mobile-dark', 'dark', { width: 390, height: 844 }]]) {
    await page.emulateMedia({ colorScheme: scheme }); await page.setViewportSize(vp)
    for (const hsh of hashes.length ? hashes : ['#home', '#settings']) {
      await page.goto(`${base}/${hsh.startsWith('#') ? hsh : '#' + hsh}`); await page.waitForTimeout(600)
      await page.screenshot({ path: `${shotsDir}/${label}-${hsh.replace(/\W/g, '') || 'home'}.png`, fullPage: true })
    }
  }
}
console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'OK: no problems')
await browser.close()
process.exit(problems.length ? 1 : 0)
