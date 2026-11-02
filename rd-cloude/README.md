# RD Cloude

An AI assistant, cloud infrastructure and a drive in one platform and one console. **Zero dependencies**: Node.js standard library only, no build step, one process, one data directory.

```bash
cd rd-cloude
npm start                      # http://localhost:3000  (create an account on the landing page)
npm test                       # 545 tests, ~45 s
open http://localhost:3000/docs.html   # API reference generated from the router
```

Requires **Node.js ≥ 22.13** (`node:sqlite`, the permission model). Without a model key the assistant answers from an offline stub; set `ANTHROPIC_API_KEY` to use real models.

## What is in the box

| Area | What you get | Docs |
| --- | --- | --- |
| **Console** | Overview dashboard, command palette (`Ctrl/⌘+K`), light/dark/system themes, notifications, responsive + keyboard accessible, API reference | [ui](docs/ui.md) |
| **Accounts & security** | scrypt passwords, sessions with device list, TOTP 2FA + recovery codes, email verification/reset, scoped API keys, organizations with roles and invitations, tamper-evident audit log, strict CSP and security headers, account export and deletion | [security](docs/security.md) |
| **AI assistant** | Streaming chat with models/providers, tools, image + text attachments, projects with instructions and knowledge, artifacts with versions/diffs and sandboxed preview, prompt library with variables, full-text search, share links, token quotas | [ai](docs/ai.md) |
| **Drive** | Folders, trash and restore, versions, full-text search, link shares (password/expiry/limits), per-user sharing (ACL), chunked/resumable uploads, streaming ZIP, quotas | [drive](docs/drive.md) |
| **Object storage** | S3-class buckets: versioning, ACLs, CORS, lifecycle rules, static websites, multipart uploads, presigned URLs, tags, conditional requests and ranges | [storage](docs/storage.md) |
| **Document database** | Query language with operators, indexes + planner, JSON-schema validation, TTL, atomic batches, change streams (SSE), aggregation, NDJSON import/export | [database](docs/database.md) |
| **Managed SQL** | Real SQLite databases (`node:sqlite`), each served by a killable, resource-limited, permission-restricted worker process; guarded SQL, snapshots/restore, migrations, import/export | [sql](docs/sql.md) |
| **Functions** | Serverless JavaScript in a namespace + permission-model sandbox: versions/aliases, KV, SSRF-safe `fetch`, encrypted env vars, HTTP triggers, cron, async queue + dead-letter queue | [functions](docs/functions.md) |
| **Compute & networking** | **Simulated** control plane: instance lifecycle state machine, key pairs, volumes/snapshots, autoscaling, load balancers, VPCs/subnets/route tables/gateways, elastic IPs, security groups with a real rule evaluator | [compute](docs/compute.md) |
| **Billing** | Usage metering (AI tokens, API requests, compute, networking, object storage, SQL, functions), plans (free/pro/team) with quotas, budgets + forecast, invoices (PDF), credits and coupons, simulated payments (tokens only, card numbers are rejected) | [billing](docs/billing.md) |
| **Observability** | Redacted structured logs, Prometheus `/metrics`, per-user monitoring overview and request log, tracing, alert rules, uptime checks, signed webhooks, status page | [observability](docs/observability.md) |
| **Storage engine** | In-memory tables with a write-ahead log, snapshots, crash recovery, optional fsync, single-writer lock, backups and verification | [storage-engine](docs/storage-engine.md) |

> **Honesty note.** Compute and networking model real behaviour (state machines, CIDR maths, firewall evaluation, metering) but **do not start machines**; CPU/memory metrics and consoles are synthetic and labelled as such in the UI. Payments are simulated. The platform is a single node: no clustering or replication.

Architecture and the contract for adding a module: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Route ownership, collections and events: [docs/INTEGRATION_NOTES.md](docs/INTEGRATION_NOTES.md).

## Using the API

```bash
BASE=http://localhost:3000
TOKEN=$(curl -s $BASE/api/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"a-long-passphrase"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

curl -s $BASE/api/buckets -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"name":"photos"}'
curl -s -X PUT $BASE/api/buckets/photos/objects/hello.txt -H "authorization: Bearer $TOKEN" -H 'content-type: text/plain' --data-binary 'hi'
```

Create scoped, expiring API keys (`rdk_…`) under *API keys* in the console. Every endpoint is listed at `/docs.html` and machine-readable at `/api/openapi.json`.

## Configuration

All settings are environment variables; invalid values fail fast (server) or fall back with a warning (per-service limits). The common ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT`, `HOST` | `3000`, all interfaces | listen address |
| `RD_DATA_DIR` | `./data` | database, WAL, blobs, SQL files, secret key |
| `NODE_ENV=production` | unset | rejects weak passwords (or `RD_PASSWORD_POLICY=strict`) |
| `RD_SECRET_KEY` | generated file in the data dir | master secret (≥ 16 chars) for 2FA secrets, audit HMAC, presigned URLs, function secrets. **Back it up; losing it makes those unreadable** |
| `RD_PUBLIC_URL` | unset | absolute links in emails (the `Host` header is never trusted for this) |
| `RD_TRUST_PROXY` | `0` | number of trusted proxy hops for `X-Forwarded-For/-Proto` |
| `RD_CORS_ORIGINS` | none | comma-separated allowed origins |
| `RD_SMTP_URL`, `RD_MAIL_FROM` | none (mail discarded) | outgoing email; `RD_DEV_OUTBOX=1` keeps mails in memory for development |
| `RD_METRICS_TOKEN` | none | enables Prometheus `/metrics` (answers 404 until set) and is the bearer token it requires |
| `RD_FSYNC` | `batch` | write-ahead-log durability: `always`, `batch` (group commit every 100 ms) or `never` |
| `ANTHROPIC_API_KEY`, `RD_AI_DEFAULT_MODEL`, `RD_AI_PROVIDER` | stub provider | assistant models |
| `RD_RATE_LIMIT` | `300` | API requests per minute per API key / user / client IP |
| `RD_BLOB_GC_HOURS` | `0` (off) | periodic, fail-closed blob garbage collection |
| `RD_SIM_DELAY_MS` | `0` (instant) | simulated control-plane transition time, e.g. `2000` to watch `pending → running` |

Per-service limits (`RD_STORAGE_*`, `RD_DRIVE_*`, `RD_DB_*`, `RD_SQL_*`, `RD_FN_*`, `RD_COMPUTE_*`, `RD_NET_*`, `RD_AI_*`, `RD_LOGIN_*`, …) are documented in each service's doc page; `docs/INTEGRATION_NOTES.md` lists every variable and where it is read.

### Production checklist

1. `NODE_ENV=production`, an explicit `RD_SECRET_KEY` from your secret store, `RD_PUBLIC_URL`, and `RD_SMTP_URL` + `RD_MAIL_FROM`.
2. Terminate TLS in a reverse proxy and set `RD_TRUST_PROXY` to the number of proxies (HSTS is then sent automatically). Set `RD_CORS_ORIGINS` only if browsers on other origins call the API.
3. Persistent data directory on a durable disk; choose `RD_FSYNC` per [storage-engine](docs/storage-engine.md); schedule `npm run backup` (see below).
4. Run **one** process per data directory (a lock enforces it). Lockout counters, rate limits and 2FA challenges are in memory and reset on restart.
5. Functions and SQL need Linux with `unshare` namespaces and the Node permission model for full isolation; the console shows the detected isolation mode and disables execution when it is missing (`RD_FUNCTIONS_UNSAFE=1` overrides, for development only).
6. Set `RD_METRICS_TOKEN` to expose `/metrics` (it is off otherwise) and scrape it from inside your network.

## Operations

```bash
npm run backup -- backup ./backups/$(date +%F)        # hot copy with --live; stop the server for a guaranteed-consistent copy
npm run backup -- verify ./backups/2026-11-02         # checks snapshots, logs and every blob checksum
npm run backup -- restore ./backups/2026-11-02 ./data # verifies, then installs (old dir moved aside, never deleted)
npm run gc-blobs -- ./data                            # dry run; add --apply to delete unreferenced blobs (server stopped)
```

* Health: `GET /api/health` (503 when the database is unhealthy); `GET /api/status` for components; `/metrics` for Prometheus.
* SIGTERM/SIGINT drain in-flight requests (`RD_SHUTDOWN_TIMEOUT_MS`), flush the log and release the lock.

## Development

```bash
npm test                                               # whole suite (strict module loading)
node --test test/storage.test.js                       # one area
node scripts/browser-check.mjs 3000                    # headless-Chromium sweep of every console view (needs a running server + global Playwright)
```

Layout: `server.js` (config + lifecycle), `src/` (engine, auth, AI, drive, billing, router), `src/modules/*.js` (auto-loaded services), `public/` (console: `app.js`, `lib.js`, `ui/*.js` per-service views). Adding a service is one backend module plus one UI module; see the architecture doc.

## Known limits

Single node, single copy of the data; in-memory tables bound the dataset to RAM (the WAL makes it durable, not larger); no SSO/SAML or WebAuthn; compute/network are simulations; the offline AI stub is not a language model. Each service doc ends with its own limitations section.
