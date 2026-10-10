# Security, identity, organizations and audit

Zero dependencies (`node:crypto` only). Owners of this area: `src/auth.js` (identity core), `src/modules/security.js`
(headers, CORS, scope enforcement, export/delete), `src/modules/orgs.js`, `src/modules/audit.js`,
`public/ui/security.js` + `team.js`. Tests: `test/security.test.js`, `test/orgs.test.js`.

## What it does

| Area | Summary |
|---|---|
| Sign-in | scrypt passwords, constant-time failure path, throttling per account+IP with exponential backoff, IP-wide and in-flight caps |
| 2FA | TOTP (RFC 6238, verified against the RFC vectors), `otpauth://` URI, two-step login, 10 single-use recovery codes stored as keyed hashes |
| Sessions | list / revoke one / revoke others, rotation on password change, idle (7 d) + absolute (30 d) expiry, max 10 per user |
| Passwords | length 8-256, common-password denylist, reset by emailed single-use token, change with re-authentication |
| Email | verification token at sign-up, pluggable `ctx.mailer`, dev outbox, notices for password / 2FA changes and for sign-ins from a new device or address |
| API keys | optional scopes and expiry, `lastUsedAt` / `lastUsedIp`, enforced centrally in `hooks.beforeRoute` |
| Organizations | owner / admin / member / viewer, email invites, transfer, `canAccess()` for other modules |
| Audit | per-user, HMAC hash-chained log fed by events and automatic request capture, cursor API, verification endpoint |
| Headers | strict CSP, `no-store` on the API, HSTS when HTTPS is indicated, configurable CORS with preflight, request-id sanity |
| Your data | `GET /api/account/export`, `DELETE /api/account` (purges every collection and blob) |

## HTTP API

All bodies are JSON objects (anything else is `400`). Errors are `{ "error": "..." }`. "session" = a token from sign-in
(not an API key). Unless noted, routes require `Authorization: Bearer <token>`.

### Sign-in and account

| Route | Notes |
|---|---|
| `POST /api/auth/register` `{email,password,name?}` | public. `201 {user, token, warnings?}`. Sends a verification mail |
| `POST /api/auth/login` `{email,password,code?}` | public. `200 {user, token}`. With 2FA on and no `code`: **`401 {error, twoFactorRequired:true, challenge, expiresIn:300, methods}`** |
| `POST /api/auth/login/2fa` `{challenge,code}` | public. `code` = 6-digit TOTP or a recovery code. `200 {user, token, usedRecoveryCode?, recoveryCodesRemaining?}` |
| `POST /api/auth/logout` | removes the calling session |
| `GET /api/me` | `{user, via, scopes}`; `PATCH /api/me {name}` |
| `GET /api/auth/sessions` | `[{id, device, ip, lastIp, createdAt, lastSeenAt, expiresAt, mfa, current}]` |
| `DELETE /api/auth/sessions/:id`, `POST /api/auth/sessions/revoke-others` | session only |
| `POST /api/auth/password/change` `{currentPassword,newPassword}` | session only. Rotates: all sessions replaced, returns the new `token` |
| `POST /api/auth/password/forgot` `{email}` | public. Always `202` (no account enumeration); mail is sent after the response |
| `POST /api/auth/password/reset` `{token,password}` | public. Single use, 30 min, signs every session out |
| `POST /api/auth/verify-email` `{token}` (public), `POST /api/auth/verify-email/resend` | 24 h token, one resend per minute |

A `401` for the 2FA challenge is deliberate: credentials are not yet sufficient, and an unmodified client then shows
`error` instead of mistaking the response for a session. Clients that want one round trip send `code` with the password.

### Two-factor authentication

`GET /api/auth/2fa` (status) - `POST /api/auth/2fa/setup {password}` returns `{secret, otpauthUri, ...}` (secret shown once) -
`POST /api/auth/2fa/enable {code}` returns `{recoveryCodes}` (shown once; other sessions are signed out) -
`POST /api/auth/2fa/disable {password, code}` - `POST /api/auth/2fa/recovery-codes {password, code}` (regenerates).
All session only. A TOTP step is accepted once (replay guard), window +-1 step. TOTP secrets are AES-256-GCM encrypted at rest
(bound to the user id); recovery codes are HMAC-SHA256 hashed with a key derived from the master secret.

### API keys

`GET/POST /api/keys`, `DELETE /api/keys/:id` (revokes). `POST` body: `{name?, scopes?, expiresAt? | expiresInDays?}`;
the secret (`rdk_...`) is returned once. Keys **without `scopes` keep full access** (backwards compatible).

Scope model (`requiredScope()` in `src/auth.js`; longest path prefix wins, mapping lives in `SCOPE_RULES`):

| Prefix | Service scope | | Prefix | Service scope |
|---|---|---|---|---|
| `/api/projects` `/conversations` `/artifacts` `/ai` | `ai` | | `/api/billing` `/plans` `/quotas` `/notifications` | `billing` |
| `/api/buckets` `/storage` | `storage` | | `/api/orgs` | `orgs` |
| `/api/compute` `/net` `/functions` | `compute` | | `/api/audit` | `audit` |
| `/api/drive` | `drive` | | `/api/keys` `/auth` `/account` `/sessions` | `account` (protected) |
| `/api/db` `/sql` | `db` | | anything else under `/api/` | none: needs `read` / `write` |

* Scope names: `read`, `write`, each service name (full access to it) and `<service>:read`.
* Method decides the level: `GET/HEAD/OPTIONS` = read, everything else = write. `write` implies `read`.
* `read`/`write` cover every service **except** `account`, which needs `account` (or `account:read` for reads). So a CI key with
  `write` can neither mint keys nor touch credentials.
* A service-scoped key does not reach unmapped (future) modules; global `read`/`write` do. Modules can map their own prefix:
  `ctx.scopes.register('/api/widgets', 'storage')`.
* `GET /api/me` works for every valid key. Static files and `/s/` share links are never key-scoped.
* A scoped key can only mint keys covered by its own scopes and not outliving it. Interactive actions (password change, 2FA,
  session revocation, account deletion) reject **all** API keys, including full-access ones.
* Denied calls answer `403 API key scope insufficient: this endpoint needs "storage" (or "write")` and are audited.

### Account data

`GET /api/account/export` downloads `rd-cloude-export-<date>.json` (5 per hour): profile, sessions, keys (no secrets), org memberships,
audit log, and every collection row owned by the caller (`userId`, plus `messages` via conversations and `shares` via files;
other modules' collections are found through `db.collections()`). No credentials, no blob contents.
`DELETE /api/account {password, code?}` (session only; the code is required when 2FA is on) removes every row owned by the
user in all collections, their blobs, sessions, keys, tokens, audit log and organization memberships. Blocked with `409` while the
user owns an organization that still has other members.

Module hooks (events on `ctx.events`):

* `account.export` `{userId, add(collection, rows)}` - contribute data that does not carry `userId`.
* `account.deleting` `{userId, veto(message)}` - refuse deletion (orgs does).
* `account.deleted` `{userId, email}` - purge what the generic walk cannot see (rows without `userId`, external stores).

## Throttling and password policy

* Failures count per **account+IP** and per **IP** (credential stuffing), and second-factor failures also **per account**.
  Free attempts (default 5 / 30 / 10), then `1s * 2^n` capped at 15 min (`429` + `Retry-After`). A locked key refuses even the
  right password and does not extend itself. Unknown accounts lock exactly like real ones. At most 5 password checks per
  account+IP and 20 per IP run in parallel (a burst of parallel guesses cannot beat the counter).
* Password checks run asynchronously in a 3-slot scrypt pool (bounded queue, `503` beyond it) so floods cannot block the event loop.
* Wrong password on a *confirmation* (change password, 2FA, delete, transfer) answers `403`, not `401` (the console reads `401`
  as "session expired"), and feeds the same lockout.
* Policy: hard limits 8-256 characters. Weakness (denylist of ~250 worst passwords incl. trailing digit/symbol variants, <4 distinct
  characters, simple sequences, containing the email local part) is **blocking when `RD_PASSWORD_POLICY=strict`** (the default when
  `NODE_ENV=production`) and a non-blocking `warnings` array otherwise, because the repository's fixtures use `password123`.
  **Set `NODE_ENV=production` (or `RD_PASSWORD_POLICY=strict`) in real deployments.**

## Organizations (`/api/orgs`)

Roles: `viewer` < `member` < `admin` < `owner` (exactly one owner). Non-members get `404` for everything; members lacking the role get `403`.

| Action | Who |
|---|---|
| create org (max 10 owned), list, read, members | any user / members |
| rename, invite `member`/`viewer`, revoke invites, change member<->viewer, remove members below you | admin+ |
| invite `admin`, promote to / change / remove admins | owner |
| leave | anyone but the owner |
| transfer ownership, delete org | owner, with password (+ code when 2FA is on) |

Routes: `GET/POST /api/orgs`, `GET/PATCH/DELETE /api/orgs/:id`, `GET /api/orgs/:id/members`, `PATCH|DELETE /api/orgs/:id/members/:userId`,
`POST /api/orgs/:id/leave`, `POST /api/orgs/:id/transfer`, `GET/POST /api/orgs/:id/invites`, `DELETE /api/orgs/:id/invites/:inviteId`,
`GET /api/orgs/invites` (mine, needs a verified email), `POST /api/orgs/invites/{preview,accept,decline}` `{token}`,
`POST /api/orgs/invites/:id/{accept,decline}`.

Invitations: 7-day token (stored hashed), mailed to the address and returned once to the inviter (so the link can be shared by hand when no
mail transport exists). Accepting needs the token **and** an account whose email equals the invited address; the by-id variant needs a
verified email. A person's pending invitations are revoked when they leave, are removed or lose admin. Limits: 100 members, 100 pending invites, 50 invites/hour/org, 50 memberships/user.

**Sharing resources with an org (for module authors).** Give your records `{userId, orgId?}` and ask:

```js
import { canAccess } from './orgs.js'          // or ctx.access.canAccess(userId, resource, permission)
canAccess(db, user.id, record, 'read' | 'write' | 'delete' | 'admin' | 'owner')
ctx.access.orgRole(userId, orgId)   // 'owner' | 'admin' | 'member' | 'viewer' | null
ctx.access.listOrgIds(userId)
```

No `orgId` = personal (only `userId`, all permissions). With `orgId`, access follows the caller's **current** role (viewer: read; member: +write;
admin: +delete/admin; owner: all); the creator keeps nothing after leaving. Return `404` when `canAccess` is false. Events:
`org.created`, `org.deleted {orgId, memberIds}` (drop or unshare what you attached), `org.member.added|removed|role_changed`.
**Nothing in the platform shares resources with organizations yet**: membership and roles are real, adoption is up to each module.

## Audit log (`GET /api/audit`, `GET /api/audit/verify`)

Entry: `{seq, ts, action, resource, ip, requestId, meta, prev, hash}`. `hash = HMAC-SHA256(key, [seq, ts, userId, action, resource, ip, requestId, meta, prev])`,
chained per user, with an HMAC-protected head record (`audit_state`) that detects truncation. The key is derived from the master secret,
so rewriting a plain SHA-256 chain is not enough. Verification reports the first bad `seq` and why (modified, missing, truncated, forged head).
Retention: 5000 entries/user (`RD_AUDIT_MAX_PER_USER`); the oldest 10 % are dropped and the verification anchor moves forward.

Query: `?action=auth.*` (trailing `*` = prefix) `&resource=` `&since=` `&until=` `&limit=` (<=200) `&cursor=` (opaque, newest first).

Feeding it: `ctx.audit(userId, action, resource, meta)` or `ctx.events.emit('audit', {userId, action, resource, ip, meta})`. Action names are sanitised to
`[A-Za-z0-9_.:*-]{1,64}`, meta is depth/size-bounded and keys like `password|token|secret|code|hash|authorization|apikey` are redacted.
Automatic capture (`onRequestEnd`, only when no explicit entry was written for the request): every successful `DELETE` and write to
auth/keys/account/orgs/share/invite/member/publish/permission/password-style paths (`http.<method>`), and `403`s (`access.denied`, once per minute per route+IP).
Events recorded by this area: `auth.register|login|login.failed|logout|password.*|email.verified|2fa.*|key.create|key.revoke|session.revoke*`,
`account.export|profile.update`, `org.*`. Failed sign-ins are logged to the *account owner's* log (1st, 5th, 6th, then every 10th).

## Headers, CORS, request hygiene (`src/modules/security.js`)

* HTML/JS/CSS: `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`.
  Widen it from a module with `ctx.csp.add('frame-src', 'blob:')`. `RD_CSP_REPORT_ONLY=1` sends it as report-only.
* `/api/*` and `/s/*`: `default-src 'none'; frame-ancestors 'none'; sandbox` (a served HTML file is inert), plus `Cache-Control: no-store` on `/api`.
  A route that really serves a page returns its own `Content-Security-Policy` via `{ headers }`.
* Always: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `Permissions-Policy`, COOP/CORP `same-origin` on documents.
* HSTS (`max-age=31536000; includeSubDomains`) only when HTTPS is indicated: TLS socket, `RD_HSTS=1`, or `X-Forwarded-Proto: https` **with `RD_TRUST_PROXY` set**.
* CORS is closed unless `RD_CORS_ORIGINS` lists exact origins (`https://app.example,https://x.example`) or `*`. Preflight (`OPTIONS`) is answered with
  `204`, requested headers are reflected only if they look like header names, `Max-Age` 600, `Vary: Origin`, never `Allow-Credentials` (auth is a bearer header).
* `x-request-id`: kept if `[A-Za-z0-9._:=+/-]{1,64}`, otherwise replaced by a UUID (also for logging).
* `RD_ALLOWED_HOSTS` rejects other `Host` headers with `421` (DNS-rebinding defence). Bodies over 64 KB to `/api/{auth,account,keys,orgs,audit}` get `413` before being read.
* Unknown `/api/*` paths are answered by the module (JSON 404 with the same headers).

**How the headers reach every response.** `security.js` registers `ctx.hooks.onRequest` (an *early* hook `fn(rc)`) and also runs in `beforeRoute`.
Until `src/app.js` calls `hooks.onRequest` before routing, responses that never reach `beforeRoute` (401, 429, static files) lack these headers; to cover
the console's HTML meanwhile, the module serves `/` and `*.html` itself (same files, with CSP + ETag). The fallback switches itself off as soon as
the app calls the early hook. See "Integration" below.

## Mail

`ctx.mailer.send({to, subject, text, tags?})` (promise). Default: discards mail with a one-time warning; with `RD_DEV_OUTBOX=1` messages go to a 200-entry ring buffer readable at
`GET /api/dev/outbox?to=&limit=` (**loopback only**, 404 otherwise; `DELETE` clears it). No SMTP client is bundled: assign your own transport to `ctx.mailer` at start-up.
Links in mails are absolute only when `RD_PUBLIC_URL` is set; the `Host` header is never used (reset-link poisoning). Mail failures never fail a request.
The standalone page `/auth/account#mode=forgot|reset|verify|signin` (HTML + `/auth/account.js`, CSP-clean) handles the links in those mails and a two-step sign-in for 2FA accounts.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV=production` / `RD_PASSWORD_POLICY` | standard | `strict` blocks weak passwords |
| `RD_SECRET_KEY` | data-dir `secret.key` | >=16 chars; master secret for TOTP encryption, recovery-code and audit HMACs. In-memory mode: random per process |
| `RD_TRUST_PROXY` | 0 | trusted proxy hops for `X-Forwarded-For` / `-Proto` |
| `RD_SESSION_IDLE_HOURS` / `RD_SESSION_MAX_DAYS` / `RD_MAX_SESSIONS` | 168 / 30 / 10 | session lifetime |
| `RD_LOGIN_FREE_ATTEMPTS` / `RD_LOGIN_IP_FREE_ATTEMPTS` / `RD_2FA_FREE_ATTEMPTS` | 5 / 30 / 10 | failures before locking |
| `RD_LOGIN_BASE_DELAY_MS` / `RD_LOGIN_MAX_DELAY_MS` | 1000 / 900000 | backoff |
| `RD_REGISTER_PER_HOUR` / `RD_MAX_API_KEYS` / `RD_PASSWORD_MIN` | 100 / 50 / 8 | limits |
| `RD_CORS_ORIGINS`, `RD_HSTS`, `RD_ALLOWED_HOSTS`, `RD_CSP_REPORT_ONLY`, `RD_PUBLIC_URL`, `RD_DEV_OUTBOX`, `RD_AUDIT_MAX_PER_USER` | unset | see above |

## Console UI

`#security` (Overview checkup, Password, Two-factor, Sessions, API keys with scope picker, Activity with integrity check, Your data; the same API-keys screen replaces
the built-in `#keys` view so every key can be created with scopes and an expiry) and `#team` (organizations,
members, roles, invites, transfer, delete; `#team/invite/<token>` is the invitation landing page). Both use only `h()`, CSS classes and CSSOM, work at 360 px
(tables become cards) and in dark mode.

## Integration with the rest of the app

Events added: `audit`, `account.export`, `account.deleting`, `account.deleted`, `org.created`, `org.deleted`, `org.member.added|removed|role_changed`.
`ctx` gains `mailer`, `audit`, `access`, `scopes`, `csp`; `hooks` gains `onRequest`. Collections: `auth_tokens`, `org_orgs`, `org_members`, `org_invites`,
`audit_log`, `audit_state`; `users`, `sessions`, `apiKeys` gained fields (`emailVerified`, `totp`, `recoveryCodes`, `knownDevices`, `lastSeenAt`, `scopes`, `expiresAt`...).

## Security notes and honest limitations

* Tokens (sessions, keys, reset, verify, invites) are random 256/192-bit values stored only as SHA-256 hashes; comparisons of secrets use hashing + `timingSafeEqual`.
* The master secret file sits **next to the database**: it protects against a leaked `db.json`/WAL copy, not against someone who owns the whole data directory
  (or its backups). Provide `RD_SECRET_KEY` from the environment/secret store for real separation. Losing it makes 2FA secrets and recovery codes unusable (and the audit chain unverifiable).
* Lockout state, 2FA challenges and rate gates are **in memory**: a restart clears them. Single process only.
* Registration answers `409` for existing addresses (kept for compatibility), so the sign-up form can enumerate accounts; sign-ups are rate limited per IP.
* An account-wide password lockout is deliberately absent (it would let an attacker lock the owner out); distributed guessing is limited per IP only. 2FA guesses *are* limited per account.
* No SMTP transport, no QR code for 2FA enrolment (manual key + `otpauth://` link only), no WebAuthn, no SSO/SAML, no per-org audit log.
* The audit key lives with the data: an attacker with full control of the data directory can forge a chain. Entries of a deleted account are deleted with it.
* Organization sharing is not adopted by any service yet; keys cannot be scoped to an organization.
* `X-Forwarded-For` is trusted only with `RD_TRUST_PROXY`; the app's own per-IP rate limiter uses the raw socket address (see Integration requests in the report).
