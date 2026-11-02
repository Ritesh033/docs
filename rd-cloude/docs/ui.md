# Console UI

The console is a dependency-free single-page app: `public/index.html` + ES modules, served as static files. There is no build step.

```
public/
  index.html        landing/sign-in, topbar, #nav, <main id="view">, offline banner
  theme-init.js     classic script in <head>: applies localStorage.rd_theme before first paint (no flash)
  style.css         design tokens, shell, shared components (also loaded by the account page and the public share page)
  app.js            shell: auth, routing, command palette, theme, notifications bell, mobile drawer
  lib.js            helpers handed to every view (see below)
  icons.js          stroke icon set built with createElementNS (CSP-safe)
  charts.js         tiny accessible SVG charts (stackedBars, lineChart, sparkline, donut, legend) + ui/charts.css
  markdown.js       sanitising markdown renderer used by the AI views
  ui/<id>.js        one module per area: home, settings, chat, projects, artifacts, compute, network, ...
  ui/<name>.css     stylesheet for that area (every ui/*.css is loaded automatically)
```

## View modules (plugin contract)

`GET /api/ui-modules` lists `public/ui/*.js` and `public/ui/*.css`. The shell imports every module and registers each exported view:

```js
export default {                    // or an array of these
  id: 'sql',                        // route: #sql, #sql/<arg...>
  title: 'SQL', group: 'Cloud',     // nav label and group (Overview | AI | Cloud | Account; unknown groups are appended)
  order: 35,                        // sort within the group
  icon: 'sql',                      // optional, defaults to id (see icons.js); keywords: 'search terms for the palette'
  hidden: false,                    // true = routable but not in nav/palette
  async render(el, arg, lib) { ... }  // el is a fresh <main id="view"> for this navigation
}
```

* `el` is **replaced on every navigation**, so a slow render can only write into a detached element and pollers can stop themselves with `if (!el.isConnected) return`.
* Throwing from `render` shows an error state with a retry button (message in `.err`).
* `lib.rerender()` (or `window.dispatchEvent(new Event('rd:rerender'))`) re-renders the current route without moving focus or scrolling.
* Pages are announced by moving focus to `<main>` (labelled with the view title) and updating `document.title` — views should not steal focus before their first render finishes, but may focus their own controls afterwards.

## Rules that keep the CSP happy (`script-src 'self'; style-src 'self'`)

* No inline `<script>`, `<style>` or `style="…"` attributes in HTML. Style elements from JS through the CSSOM: `h('i', { style: { width: '40%' } })`.
* No `innerHTML` with user data. Build DOM with `h()`; text nodes are escaped.
* SVG is built with `createElementNS` (`icons.js`, `charts.js`).

## Design tokens (`style.css`)

Light is the default; dark follows `prefers-color-scheme` unless the user chose a theme. `<html data-theme="light|dark">` forces one (set by `theme-init.js` and `lib.setTheme`). Per-area stylesheets must use the same three-way pattern for any dark overrides:

```css
@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) .x { … } }
:root[data-theme=dark] .x { … }
```

| token | use |
| --- | --- |
| `--bg --fg --muted --line --panel --panel-2` | surfaces and text (`--muted` ≥ 4.5:1 on `--bg` and `--panel`) |
| `--accent --accent-hover --on-accent --accent-soft` | brand colour; text on an accent fill must use `--on-accent` (white in light, near-black in dark) |
| `--ok --warn --danger --info` and `…-bg` | status text/background pairs (all ≥ 4.5:1) |
| `--focus` | focus ring (`:focus-visible` is styled globally) |
| `--topbar-h --nav-w --radius --shadow --scrim` | layout |
| `--c0 … --c7` | categorical chart palette (`ui/charts.css`) |

Global hover rules use `:where()` so a plugin's own class always wins; do not rely on `button:hover` specificity.

## `lib` helpers

`h, api, toast, act, download, confirmDialog, promptDialog, rerender, fmtBytes, fmtDate, state` (original contract) plus:
`badge(text, kind)`, `emptyState(title, hint, action)`, `spinner()`, `skeleton(lines, style)`, `table(headers, rows, {caption})`, `debounce`, `fmtNumber`, `fmtMoney`, `fmtDuration`, `fmtRelative`, `copyToClipboard`, `getTheme`, `setTheme`.

`api()` throws `Error` with `.status`/`.data` for HTTP errors and `.network = true` for connectivity failures (which also raises the offline banner through the `rd:network` event). A 401 on a non-auth route clears the token and reloads.

Events on `window`: `rd:rerender`, `rd:theme` (detail = `auto|light|dark`), `rd:me` (detail = user), `rd:network` (detail.ok).

## Shell features

* **Command palette** — `Ctrl/⌘ + K` or the Search button. Fuzzy-matches every registered view plus actions (theme, notifications, refresh, sign out). Arrow keys, Home/End, Enter, Esc; ARIA combobox/listbox.
* **Theme** — System → Light → Dark cycle in the topbar and a radio group in Settings; persisted in `localStorage.rd_theme`.
* **Notifications** — bell polls `/api/notifications` every 60 s while the tab is visible; links are only followed when they are in-app hashes.
* **Mobile (≤ 860 px)** — navigation becomes a drawer: focus is moved into it, trapped while open, `Esc`/scrim/navigation closes it, hidden links are not focusable.
* **Accessibility** — skip link, landmarks (`header`, `nav`, `main`), `aria-current="page"`, visible focus rings, reduced-motion support, `role="alert"` for sign-in errors, AA contrast for tokens.

## Home dashboard (`ui/home.js`)

Cards load independently; a failing or forbidden service shows "Unavailable" on its own card instead of blanking the page. Sources: `/api/status`, `/api/compute/instances`, `/api/functions`, `/api/buckets`, `/api/sql`, `/api/drive/usage`, `/api/conversations`, `/api/billing/{forecast,plan,quotas,cost/daily}`, `/api/monitoring/overview`, `/api/audit`.

## Testing the UI

```sh
PORT=4000 RD_DATA_DIR=$(mktemp -d) node server.js &
node scripts/browser-check.mjs 4000                         # every nav view: console/page errors, error states, empty views + keyboard/mobile smoke test
node scripts/browser-check.mjs 4000 '#home' --shots ./shots  # + light/dark × desktop/mobile screenshots
```

The script uses the globally installed Playwright (`npm root -g`) and `CHROMIUM_PATH` (default `/opt/pw-browsers/chromium`).
