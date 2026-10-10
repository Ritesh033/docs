# RD Cloude architecture & contributor contract

Zero runtime dependencies. Node 22+, ESM, plain JavaScript. Keep it that way: use `node:*` built-ins only
(`node:sqlite`, `node:crypto`, `node:zlib`, `node:worker_threads`, `node:test`, ...). No npm packages, no build step.

## Layout

```
server.js                 entrypoint (PORT, RD_DATA_DIR)
src/app.js                http server, auth/rate-limit/dispatch, module loader, static files
src/http.js               Router, HttpError, body helpers, HANDLED symbol
src/db.js                 document store + blob store (sync API, see below)
src/auth.js ai.js drive.js billing.js     core modules wired explicitly in app.js
src/modules/*.js          feature modules, AUTO-LOADED (alphabetical): export register(router, db, ctx)
public/                   static web console: index.html, app.js (shell), lib.js (helpers), style.css
public/ui/*.js            UI plugin modules, AUTO-LOADED by the shell (see "UI modules")
test/*.test.js            node:test suites; test/helpers.js boots an app
scripts/browser-check.mjs headless-Chromium smoke check
docs/                     documentation
```

## Backend module contract

```js
// src/modules/example.js
import { HttpError, required } from '../http.js'
export async function register(r, db, ctx) {
  r.get('/api/example/:id', ({ user, params, query, body, raw, req, res, auth, requestId, ctx }) => { ... })
}
```

`ctx` = `{ db, router, events (EventEmitter), hooks, config, HANDLED, startedAt }`.

* **Route options** (3rd arg of `r.get/post/put/patch/delete`): `{ public: true }` no auth; `{ optionalAuth: true }` auth if a token is
  sent, else `user` is null; `{ raw: true }` body is NOT JSON-parsed (use `raw` Buffer); `{ stream: true }` body is not read at all and the
  handler owns `req`/`res` (return `ctx.HANDLED` after writing the response, e.g. SSE); `{ meta: {...} }` free-form docs metadata
  (summary, description, request/response examples) used for OpenAPI generation. Patterns support `:param` and a trailing `/*splat`.
* **Handler return values**: plain object -> 200 JSON; `[status, obj]`; `{ binary: Buffer, type, filename?, headers?, status? }`;
  `{ text: string, type?, headers?, status? }`; `{ redirect: url, status? }`; `ctx.HANDLED`. Throw `new HttpError(status, message)`
  (optionally set `err.headers = {...}`) for errors. Async handlers are fine.
* **Hooks** (`ctx.hooks`): `beforeRoute.push(async (rc) => {...})` runs after auth and may throw HttpError (rc = `{req,res,url,requestId,user,auth,route,params}`);
  `onRequestEnd.push((info) => {...})` runs when the response finishes (`info.status`, `info.durationMs`, `info.pattern`, `info.user`, ...). Hooks must be fast and must never throw.
* **Events** (`ctx.events.emit(name, payload)`): cross-module notifications, fire-and-forget. Established names so far:
  `shutdown`. New modules may define `<area>.<verb>` events (e.g. `audit` with `{userId, action, resource, ip, meta}`,
  `usage` is recorded via `record()` from `src/billing.js` instead). Document any event you add at the bottom of this file.
* **Tenant isolation is mandatory**: every record carries `userId`; every read/write/delete by id must verify ownership and answer 404 (not 403)
  for other users' records. Never trust ids from the client. Validate and bound all input (lengths, counts, numeric ranges, name charsets).
  Public (unauthenticated) routes must expose only what was explicitly shared.
* **Errors/limits**: never leak stack traces; keep request bodies bounded (`MAX_BODY` 25 MB default); cap list sizes and support pagination
  (`?limit=&cursor=`) on anything that can grow.
* **Metering**: `record(db, userId, kind, qty)` from `src/billing.js`; add the kind + price to `PRICES` there only if you own billing,
  otherwise tell the billing owner via your final report.
* **Strict loading**: in tests modules load with `strictModules: true` (a broken module throws). In dev a broken module is logged and skipped.

## Database API (`db`, synchronous, in-memory + persisted)

`insert(col, doc)` (adds `id`, `createdAt`), `get(col,id)`, `find(col, pred)`, `findOne(col, pred)`, `update(col,id,patch)` (sets `updatedAt`),
`remove(col,id)`, `removeWhere(col,pred)`, `id(prefix)`, `putBlob/getBlob/deleteBlob(blobId, buf)`, `flush()`.
Collections are created on demand; **prefix your collection names with your module name** to avoid clashes (`fn_functions`, `net_vpcs`).
Existing core collections: users, sessions, apiKeys, projects, conversations, messages, artifacts, instances, buckets, objects, files, shares, docs, usage.

## UI modules (`public/ui/*.js`)

```js
export default { id: 'functions', title: 'Functions', group: 'Cloud', order: 50, render(el, arg, lib) { ... } }
// or export default [ {...}, {...} ]
```
`id` is the `#hash` route (`#functions/abc` -> `arg = 'abc'`). A module whose `id` matches a built-in view in `public/app.js` replaces it.
`group` is `AI` | `Cloud` | `Account` (new groups allowed). `lib` = `{ h, api, toast, act, download, confirmDialog, promptDialog, rerender, fmtBytes, fmtDate, state }`
(see `public/lib.js`). **Never** put user-controlled strings in `innerHTML`; build DOM with `h()` or `textContent`. Views must work at 360px width,
respect `prefers-color-scheme` (use the CSS variables in `style.css`), be keyboard-accessible (real `<button>`/`<label>`s), and show errors via `toast`/inline messages, not `alert()`.
Re-render with `lib.rerender()`.

## Testing & verification

* `npm test` runs everything (`node --test test/*.test.js`). While working, run only your file: `node --test test/<yours>.test.js`.
* Use `startTestApp()` from `test/helpers.js` (ephemeral port, in-memory data, strict modules); register users with `register()`.
  Test the unhappy paths: auth required, cross-tenant access -> 404, validation errors, limits.
* UI check: start the server on **your own port and data dir** (`PORT=31xx RD_DATA_DIR=<scratch dir> node server.js &`) and run
  `node scripts/browser-check.mjs <port> <hash>...`. Kill your server when done. Other engineers share this working tree concurrently:
  only edit the files you own, never run `git add/commit/checkout/stash/reset`, and don't reformat other people's files.
* Docs: update `docs/<area>.md` for what you built (concise: what it does, API, limits, security notes).

## Event / hook registry
(append new events here)
