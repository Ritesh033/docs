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

## Database API (`db`, synchronous, in-memory + durable WAL; details in docs/storage-engine.md)

`insert(col, doc)` (adds `id`, `createdAt`; an explicit existing id throws `EDBDUPLICATE`), `get(col,id)`, `find(col, pred)`, `findOne(col, pred)`, `count(col, pred?)`,
`update(col,id,patch)` (sets `updatedAt`; `id` in the patch is ignored; a value of `undefined` unsets the field), `remove(col,id)`, `removeWhere(col,pred)` (predicate required),
`transaction(fn)` (atomic WAL record, rolls back on throw), `collections()`, `id(prefix)`.
Indexes: `index(col, field)`, `findBy(col, field, value)`, `findOneBy(...)`, `dropIndex`, `reindex` - O(1), same ordering as `find()`; **use `findBy(col, 'userId', user.id)` instead of full scans on hot paths**.
Blobs: `putBlob(id, buf)`, `getBlob(id)` (returns `null` if missing - handle it with a 404; throws `BlobCorruptError`/`EBLOBCORRUPT` on checksum failure), `deleteBlob`, `hasBlob`, `statBlob`, `listBlobs`, `verifyBlobs`,
`gcBlobs(isReferenced, {graceMs, dryRun})` (never automatic: modules that store blob ids must be included in the reference set).
Ops: `flush()`, `compact()`, `backup(destDir)` (never pass a client-supplied path), `stats()`, `health()` (`ok:false` = engine poisoned by an I/O error), `close()`.
Rules: **mutate only through insert/update/remove** (editing a returned row in place is not logged and is lost on crash); store JSON-safe values only (no Date/Map/Buffer/NaN);
collection names match `/^[A-Za-z0-9_][A-Za-z0-9_.:@-]{0,127}$/` and should be **prefixed with your module name** (`fn_functions`, `net_vpcs`); blob ids are validated.
Core collections: users, sessions, apiKeys, projects, conversations, messages, artifacts, instances, buckets, objects, files, shares, docs, usage; security adds auth_tokens, org_orgs, org_members, org_invites, audit_log, audit_state; ai adds ai_knowledge, ai_prompts, ai_shares.

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
A module may ship `public/ui/<name>.css` (auto-linked by the shell; prefix every class with your module name, e.g. `.fn-editor`). The server will send a strict CSP
(`script-src 'self'; style-src 'self'`): **no inline `<script>`/`<style>`, no `style="..."` attributes, no `onclick=` attributes**. Set dynamic styles through the CSSOM
(`el.style.width = ...`, or `h('div', {style: {width: '40%'}})`) or CSS classes; add listeners with `h(tag, {onclick})`. SVG presentation attributes (width, fill, d, ...) are fine.

## Testing & verification

* `npm test` runs everything (`node --test test/*.test.js`). While working, run only your file: `node --test test/<yours>.test.js`.
* Use `startTestApp()` from `test/helpers.js` (ephemeral port, in-memory data, strict modules); register users with `register()`.
  Test the unhappy paths: auth required, cross-tenant access -> 404, validation errors, limits.
* UI check: start the server on **your own port and data dir** (`PORT=31xx RD_DATA_DIR=<scratch dir> node server.js &`) and run
  `node scripts/browser-check.mjs <port> <hash>...`. Kill your server when done. Other engineers share this working tree concurrently:
  only edit the files you own, never run `git add/commit/checkout/stash/reset`, and don't reformat other people's files.
* Docs: update `docs/<area>.md` for what you built (concise: what it does, API, limits, security notes).

## Event / hook registry

**Hooks** (`ctx.hooks`): `onRequest(rc)` runs first for EVERY request (even 404/401/static) - used for security headers, CORS and request-id sanitising; `beforeRoute(rc)` after auth; `onRequestEnd(info)` when the response finishes.

**Events** (`ctx.events`):
* `audit` `{userId, action, resource, ip, requestId, req, meta}` - append to the tamper-evident audit log. Pass `req` so the automatic HTTP capture does not duplicate the entry. Use `ctx.audit(userId, action, resource, meta)`.
* `account.export` `{userId, add(name, rows)}`, `account.deleting` `{userId, veto(msg)}`, `account.deleted` `{userId, email}` - rows carrying `userId` are exported/purged generically; anything else (and blobs kept elsewhere) must hook these.
* `org.created`, `org.deleted` `{orgId, memberIds}`, `org.member.added|removed|role_changed`.
* `ai.generation` `{userId, conversationId, messageId, model, provider, status, inputTokens, outputTokens, toolCalls, durationMs}`.
* `notification` `{userId, title, body, level, link, source}` - consumed by the notifications inbox (billing area) once present.
* `shutdown` - server closing.

**ctx fields**: `mailer` (`send({to,subject,text,tags})`), `audit(...)`, `access` `{canAccess, orgRole, listOrgIds, require, filter}` (org-shared records carry `{userId, orgId}`; check with `ctx.access.require(userId, row, 'read|write|delete')`, answering 404 on denial),
`scopes.register(prefix, service)` (API-key scope mapping; unregistered prefixes fall back to global read/write; modules that load before security.js may queue `(ctx.scopeRules ??= []).push([prefix, service])`),
`csp.add(directive, ...values)`, `ai.registerTool({name, description, input_schema, run})`, `quotas.check(userId, kind, qty)` (optional; billing area), `loadErrors`.
`blobRefs` (`Map<module, () => iterable of blob ids>`; every module that stores blob ids registers here) and `gcBlobs({dryRun = true, graceMs})` (fail-closed blob garbage collection; see docs/storage-engine.md).

**Public non-API routes**: `/s/:token` (drive shares), `/share/:token` (shared conversations), `/preview/:ticket` (sandboxed artifact previews), `/auth/account` (account pages), `/pub/*` and `/site/*` (storage), `/fn/*` (functions).
Routes that deliberately serve user HTML must send their own `Content-Security-Policy` via `{ headers }`.
