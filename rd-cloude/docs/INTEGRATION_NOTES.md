# Integration notes

How the pieces fit together, who owns what, and what a new module must do. Generated tables below were produced from the source tree (`grep` over route registrations, collection names and `RD_*` reads) at the time of writing; re-derive them when in doubt.

## Boot order and wiring (`src/app.js`)

1. `createDb(dataDir)` (src/db.js): lock, snapshot + WAL replay, secret-key file.
2. Core areas register directly, in this order: `authRoutes` → `aiRoutes` → `driveRoutes` → `billingRoutes`.
3. Every `src/modules/*.js` exporting `register(router, db, ctx)` is imported **alphabetically**: audit, compute, database, functions, invoices, network, notifications, observability, openapi, orgs, plans, security, sql, storage. With `strictModules` (tests, `RD_STRICT_MODULES=1`) a broken module aborts boot; otherwise it is logged, listed in `ctx.loadErrors` and shown on `/api/status`.
4. Consequences of the order:
   * A module that loads **before** `security.js` cannot call `ctx.scopes.register` (it does not exist yet); queue the rule instead: `(ctx.scopeRules ??= []).push(['/api/network', 'compute'])`. Scope matching is on path-segment boundaries.
   * `ctx.net` (network) is created after `compute`; compute therefore resolves it lazily on first request.
   * `ctx.quotas`, `ctx.notify` and `ctx.billing` come from `plans`/`notifications`/`invoices`; services call them optionally (`ctx.quotas?.enforce(...)`).
5. `ctx.gcBlobs`, `ctx.loadErrors` are attached after module loading; the HTTP server is created last. `server.on('close')` emits `shutdown` and closes the database.

Request pipeline: `hooks.onRequest` (security headers, CORS, request id; runs for every request, even 404s) → router match (static files for unmatched non-API GETs) → authentication (session or API key) → rate limit (per key / user / client IP) → `hooks.beforeRoute` (API-key scope check, quotas, tracing, org checks) → body read (skipped for `stream` routes, left raw for `raw` routes) → handler → response; `hooks.onRequestEnd` fires when the response finishes (metrics, request log, API-request metering, audit capture).

## Route ownership

| File | Routes | Prefixes |
| --- | ---: | --- |
| `src/auth.js` | 22 | `/api/auth` ×17, `/api/keys` ×3, `/api/me` ×2 |
| `src/ai.js` | 46 | `/api/conversations` ×16, `/api/artifacts` ×13, `/api/projects` ×9, `/api/ai` ×3, `/api/shared` ×2, `/api/search`, `/preview`, `/share` |
| `src/drive.js` | 39 | `/api/drive` ×38, `/s` |
| `src/billing.js` | 2 | `/api/billing` ×2 |
| `src/modules/audit.js` | 2 | `/api/audit` ×2 |
| `src/modules/compute.js` | 34 | `/api/compute` ×34 |
| `src/modules/database.js` | 25 | `/api/db` ×23, `/api/public` ×2 |
| `src/modules/functions.js` | 20 | `/api/functions` ×20 |
| `src/modules/invoices.js` | 17 | `/api/billing` ×17 |
| `src/modules/network.js` | 29 | `/api/network` ×29 |
| `src/modules/notifications.js` | 3 | `/api/notifications` ×3 |
| `src/modules/observability.js` | 25 | `/api/monitoring` ×21, `/api/status`, `/api/live`, `/api/ready`, `/metrics` |
| `src/modules/openapi.js` | 1 | `/api/openapi.json` |
| `src/modules/orgs.js` | 19 | `/api/orgs` ×19 |
| `src/modules/plans.js` | 13 | `/api/billing` ×12, `/api/plans` |
| `src/modules/security.js` | 6 | `/api/dev` ×2, `/api/account` ×2, `/auth` ×2 |
| `src/modules/sql.js` | 22 | `/api/sql` ×22 |
| `src/modules/storage.js` | 51 | `/api/buckets` ×41, `/pub` ×3, `/site` ×3, `/api/storage` ×2, `/presigned` ×2 |
| `src/app.js` | 2 | `/api/health`, `/api/ui-modules` |
(Counts are literal registrations; the functions HTTP trigger `/fn/*` and a few method loops are registered with `r.add` inside their modules.) The generated list of every operation is at `/api/openapi.json` and `/docs.html`.

## Collections (database tables) by owner

| Owner | Collections |
| --- | --- |
| `src/auth.js` | `users`, `sessions`, `apiKeys`, `auth_tokens` |
| `src/ai.js` | `projects`, `conversations`, `messages`, `artifacts`, `ai_knowledge`, `ai_prompts`, `ai_shares` |
| `src/drive.js` | `files`, `shares`, `drive_folders`, `drive_uploads`, `drive_acl`, `drive_activity`, `drive_share_log` |
| `src/billing.js` + `plans.js` + `invoices.js` | `usage`, `billing_state`, `bill_subs`, `bill_plan_changes`, `bill_overrides`, `bill_budgets`, `bill_adjustments`, `bill_credits`, `bill_redemptions`, `bill_invoices`, `bill_payments`, `bill_pm`, `bill_settings`, `bill_events` |
| `notifications.js` | `notifications` |
| `audit.js` | `audit_log`, `audit_state` |
| `orgs.js` | `org_orgs`, `org_members`, `org_invites` |
| `storage.js` | `buckets`, `objects`, `st_uploads`, `st_parts`, `st_state` |
| `database.js` | `docs`, `db_meta` |
| `sql.js` | `sql_databases`, `sql_history`, `sql_saved`, `sql_snapshots`, `sql_migrations` |
| `functions.js` | `fn_functions`, `fn_invocations`, `fn_jobs`, `fn_kv` |
| `compute.js` | `instances`, `cmp_volumes`, `cmp_snapshots`, `cmp_keypairs`, `cmp_asgs`, `cmp_lbs` |
| `network.js` | `net_vpcs`, `net_subnets`, `net_routetables`, `net_igws`, `net_eips`, `net_sgs` |
| `observability.js` | `obs_channels`, `obs_alerts`, `obs_alert_events`, `obs_checks`, `obs_results`, `obs_deliveries` |

Rules: every row carries `userId` (organization-shared rows also `orgId`); account deletion purges **every** collection generically by `userId` plus blob ids found in nested arrays/objects (`security.js`), so a new collection needs no deletion code as long as it follows that shape. Client-chosen ids in `docs` are stored as a per-collection `xid`; internal ids are random.

## Blob owners

Blob ids are referenced from: `drive` (file versions, upload parts), `storage` (object chunks, multipart parts), `ai` (image attachments on messages). Each registers in `ctx.blobRefs`; `ctx.gcBlobs` refuses to run unless all of them are present. SQL databases are plain files owned by the SQL module, not blobs.

## Events (`ctx.events`)

`shutdown`; `audit` `{userId, action, resource, ip, requestId, req, meta}`; `notification` `{userId, title, body, level, link, source}`; `account.export` `{userId, add}`, `account.deleting` `{userId, veto}`, `account.deleted` `{userId, email}`; `org.created|deleted`, `org.member.added|removed|role_changed`; `ai.generation`. Details: [ARCHITECTURE.md](ARCHITECTURE.md#event--hook-registry).

## Metering kinds

Defined in `PRICES` (`src/billing.js`): `ai.input_tokens`, `ai.output_tokens`, `api.requests`, `compute.{small,medium,large}` (hours), `compute.volume_gb_month`, `network.eip_hour`, `storage.{gb_month,requests,egress_gb}`, `sql.{query,gb_month}`, `functions.{invocations,gb_seconds}`. Derived kinds (compute hours, GB-month gauges) are synthesised lazily and idempotently by `syncDerived` when usage is read, so a restart never double counts.

## Environment variables

Every `RD_*` variable read by the code, and the file(s) that read it. Defaults and meaning are in the service's own doc (storage: [storage.md](storage.md); SQL: [sql.md](sql.md); functions: [functions.md](functions.md); compute/network: [compute.md](compute.md); AI: [ai.md](ai.md); security and mail: [security.md](security.md); engine: [storage-engine.md](storage-engine.md); observability: [observability.md](observability.md)). Standard variables: `PORT`, `HOST`, `NODE_ENV`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`.

| Variable | Read in |
| --- | --- |
| `RD_2FA_FREE_ATTEMPTS` | auth.js |
| `RD_AI_CONTEXT_TOKENS` | ai.js |
| `RD_AI_DAILY_OUTPUT_TOKENS` | ai.js |
| `RD_AI_DEFAULT_MODEL` | providers.js |
| `RD_AI_IDLE_TIMEOUT_MS` | providers.js |
| `RD_AI_INDEX_MAX_POSTINGS` | ai.js |
| `RD_AI_INDEX_USER_POSTINGS` | ai.js |
| `RD_AI_MAX_CONCURRENT` | ai.js |
| `RD_AI_MAX_RETRIES` | providers.js |
| `RD_AI_MAX_TOKENS` | ai.js |
| `RD_AI_MAX_TOOL_ITERATIONS` | ai.js |
| `RD_AI_MODELS` | providers.js |
| `RD_AI_PREVIEW_ALLOW_HOSTS` | ai.js |
| `RD_AI_PROVIDER` | providers.js |
| `RD_AI_TIMEOUT_MS` | providers.js |
| `RD_AI_TOTAL_TIMEOUT_MS` | providers.js |
| `RD_ALLOWED_HOSTS` | security.js |
| `RD_AUDIT_MAX_PER_USER` | audit.js |
| `RD_BLOB_GC_HOURS` | app.js |
| `RD_BLOB_MAX_BYTES` | db.js |
| `RD_COMPUTE_MAX_INSTANCES` | compute.js |
| `RD_COMPUTE_MAX_VOLUMES` | compute.js |
| `RD_COMPUTE_MAX_VOLUME_GB` | compute.js |
| `RD_CORS_ORIGINS` | security.js |
| `RD_COUPONS` | invoices.js |
| `RD_CRASH_ON_UNHANDLED` | server.js |
| `RD_CSP_REPORT_ONLY` | security.js |
| `RD_DATA_DIR` | server.js, backup.mjs, gc-blobs.mjs |
| `RD_DB_MAX_DOCS` | database.js |
| `RD_DB_MAX_DOC_BYTES` | database.js |
| `RD_DEV_OUTBOX` | auth.js, security.js |
| `RD_DRIVE_MAX_VERSIONS` | drive.js |
| `RD_DRIVE_QUOTA_BYTES` | drive.js |
| `RD_DRIVE_TRASH_DAYS` | drive.js |
| `RD_FN_CONCURRENCY` | functions.js |
| `RD_FN_MAX_CONCURRENCY` | functions.js |
| `RD_FN_MAX_FUNCTIONS` | functions.js |
| `RD_FN_MAX_TIMEOUT_MS` | functions.js |
| `RD_FN_USER_CONCURRENCY` | functions.js |
| `RD_FN_WARM_IDLE_MS` | functions.js |
| `RD_FORCE_UNLOCK` | db.js |
| `RD_FSYNC` | server.js, db.js |
| `RD_FSYNC_INTERVAL_MS` | server.js, db.js |
| `RD_FUNCTIONS_ALLOW_PRIVATE` | functions.js |
| `RD_FUNCTIONS_UNSAFE` | functions.js |
| `RD_HSTS` | security.js |
| `RD_KEEP_GENERATIONS` | server.js, db.js |
| `RD_LOCK_LEASE_MS` | server.js, db.js |
| `RD_LOGIN_BASE_DELAY_MS` | auth.js |
| `RD_LOGIN_FREE_ATTEMPTS` | auth.js |
| `RD_LOGIN_IP_FREE_ATTEMPTS` | auth.js |
| `RD_LOGIN_MAX_DELAY_MS` | auth.js |
| `RD_LOG_BUFFER` | observability.js |
| `RD_LOG_LEVEL` | observability.js |
| `RD_LOG_STDOUT` | observability.js |
| `RD_MAIL_FROM` | auth.js |
| `RD_MAX_API_KEYS` | auth.js |
| `RD_MAX_SESSIONS` | auth.js |
| `RD_METRICS_TOKEN` | observability.js |
| `RD_MODEL` | providers.js |
| `RD_NET_MAX_EIPS` | network.js |
| `RD_NET_MAX_VPCS` | network.js |
| `RD_OBS_ALLOW_PRIVATE` | observability.js |
| `RD_OBS_RETRY_MS` | observability.js |
| `RD_OBS_USER_RING` | observability.js |
| `RD_PASSWORD_MIN` | auth.js |
| `RD_PASSWORD_POLICY` | auth.js |
| `RD_PUBLIC_URL` | auth.js, storage.js |
| `RD_QUOTAS_DISABLED` | plans.js |
| `RD_RATE_LIMIT` | app.js |
| `RD_RECOVER` | server.js, db.js |
| `RD_REGISTER_PER_HOUR` | auth.js |
| `RD_SECRET_KEY` | auth.js, security.js |
| `RD_SECURITY_STATIC` | security.js |
| `RD_SESSION_IDLE_HOURS` | auth.js |
| `RD_SESSION_MAX_DAYS` | auth.js |
| `RD_SHUTDOWN_TIMEOUT_MS` | server.js |
| `RD_SIM_DELAY_MS` | compute.js |
| `RD_SLOW_MS` | observability.js |
| `RD_SMTP_ALLOW_PLAINTEXT` | auth.js |
| `RD_SMTP_CA_FILE` | auth.js |
| `RD_SMTP_URL` | auth.js |
| `RD_SNAPSHOT_ON_CLOSE` | db.js |
| `RD_SQL_IDLE_MS` | sql.js |
| `RD_SQL_MAX_DBS` | sql.js |
| `RD_SQL_MAX_DB_BYTES` | sql.js |
| `RD_SQL_MAX_PROCS` | sql.js |
| `RD_SQL_MAX_TIMEOUT_MS` | sql.js |
| `RD_SQL_MEM_MB` | sql.js |
| `RD_SQL_NO_PERMISSION` | sql.js |
| `RD_SQL_TIMEOUT_MS` | sql.js |
| `RD_STORAGE_CHUNK_BYTES` | storage.js |
| `RD_STORAGE_MAX_BUCKETS` | storage.js |
| `RD_STORAGE_MAX_CONCURRENT_UPLOADS` | storage.js |
| `RD_STORAGE_MAX_OBJECTS` | storage.js |
| `RD_STORAGE_MAX_OBJECT_BYTES` | storage.js |
| `RD_STORAGE_MAX_PARTS` | storage.js |
| `RD_STORAGE_MAX_PART_BYTES` | storage.js |
| `RD_STORAGE_MAX_UPLOADS` | storage.js |
| `RD_STORAGE_MIN_PART_BYTES` | storage.js |
| `RD_STORAGE_PRESIGN_SECRET` | storage.js |
| `RD_STORAGE_QUOTA_BYTES` | storage.js |
| `RD_STORAGE_REGIONS` | storage.js |
| `RD_STORAGE_SWEEP_INTERVAL_MS` | storage.js |
| `RD_STORAGE_UPLOAD_TTL_HOURS` | storage.js |
| `RD_STRICT_MODULES` | app.js |
| `RD_STUB_DELAY_MS` | ai.js |
| `RD_TRUST_PROXY` | auth.js |
| `RD_USAGE_RAW_DAYS` | billing.js |
| `RD_WAL_COMPACT_MAX_BYTES` | db.js |
| `RD_WAL_COMPACT_MIN_BYTES` | server.js, db.js |
## Checklist for a new service

1. `src/modules/<name>.js` exporting `register(r, db, ctx)`; prefix collections; every row has `userId`; answer `404` for other tenants' ids; bound all input and list sizes.
2. Metering: add kinds to `PRICES` and call `record(db, userId, kind, qty)`; optional quota via `ctx.quotas?.enforce`.
3. API-key scopes: `ctx.scopes.register(prefix, service)` (or queue in `ctx.scopeRules` when loading before `security.js`).
4. Blob ids? Register in `ctx.blobRefs` **and** add the owner to `BLOB_OWNERS` in `src/app.js`.
5. User HTML/JS served from your routes must carry its own sandboxing CSP (`{ headers }`).
6. UI: `public/ui/<name>.js` (+ `.css`), default-export the view descriptor; use `lib` helpers and the shared tokens (see [ui.md](ui.md)); no inline scripts/styles.
7. Tests in `test/<name>.test.js` using `startTestApp()`; document the area in `docs/<name>.md`; give routes `meta: { summary }` so the API reference reads well.
