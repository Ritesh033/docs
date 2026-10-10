// Usage: node scripts/browser-check.mjs <port> [hash ...]
// Registers a fresh user in headless Chromium, visits each #hash view and reports console/page errors
// and any rendered `#view .err` message. Exit code 1 if anything was reported. Uses the globally installed playwright.
import { execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const [port = '3000', ...hashes] = process.argv.slice(2)
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
console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'OK: no problems')
await browser.close()
process.exit(problems.length ? 1 : 0)
