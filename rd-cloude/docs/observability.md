# Observability

`src/modules/observability.js`, shared SSRF layer `src/ssrf.js`, UI `public/ui/monitoring.js`.

## Logging and tracing
`ctx.log(level, msg, fields)` — structured entries into a bounded ring buffer (`RD_LOG_BUFFER`, default 2000); filtered by `RD_LOG_LEVEL` (`debug|info|warn|error`, default `info`), echoed to stderr as JSON lines when `RD_LOG_STDOUT=1`.
**Everything is redacted before it is stored**: keys that look sensitive (`authorization, token, password, secret, cookie, api key, signature, hash, private …`), `Bearer …` tokens, `rdk_…` API keys and JWT-shaped strings; depth, entry size and string length are bounded.
Inside a request, log lines carry the request id automatically (AsyncLocalStorage). `await ctx.trace('db.query', () => …)` records a span on the current request; requests slower than `RD_SLOW_MS` (1000) produce a `slow request` warning listing their spans.

## Metrics
Collected from `ctx.hooks.onRequestEnd` with O(1) work per request (**0.9 µs/call measured; the test enforces < 50 µs**): counters and latency histograms per `method × route pattern × status class` (route labels come from router patterns, so cardinality is bounded — unknown API paths share `/api/*unmatched`, at most 600 keys), an in-flight gauge (decremented on connection close, never leaks), and per-user rings (`RD_OBS_USER_RING`, default 3000 entries, ≤ 2000 users) used for the per-user views.
`GET /metrics` serves Prometheus text format (0.0.4) **only when `RD_METRICS_TOKEN` is set** (otherwise 404; wrong token 401, constant-time compare). It includes request counters/histograms, in-flight, RSS, heap, event-loop delay (`perf_hooks`), uptime, module load failures and the storage engine's `db.stats()` numbers.

## Per-user views (`/api/monitoring/…`, strictly per user)
* `GET overview?window=1h|24h` — requests, 4xx/5xx, error rate, p50/p95/p99, top endpoints, per-credential breakdown (API key names), time series.
* `GET logs?status=&method=&path=&requestId=&since=&until=&limit=&cursor=` — the user's own request log (no query strings, no credentials), cursor-paginated; `status=500` means the class, `status=404` an exact code.
* **Alerts** `GET/POST/PATCH/DELETE alerts`, `POST alerts/:id/silence`, `GET alerts/history` — rules `error_rate` (%, needs ≥ 10 requests), `latency_p95` (ms, needs ≥ 5), `error_count`, `no_traffic`, window 1–1440 min, ≤ 20 rules. A sweeper (30 s, `ctx.obs.evaluateAlerts(now)` in tests) moves rules between `ok` and `firing`, writes history and sends a notification **once per transition** (silenced rules still record history).
* **Uptime checks** `…/checks` (≤ 10): GET a URL every 1 min–1 h, expected status, timeout ≤ 10 s, results ring (200), uptime % over 24 h. Two consecutive failures → `down` (one notification), first success afterwards → `up` (recovery notification). `POST checks/:id/run` runs one immediately.
* **Webhook channels** `…/channels` (≤ 5): `POST` returns a `whsec_…` secret **once** (stored AES-GCM-encrypted); deliveries are JSON signed with `x-rd-signature: v1=hex(hmac_sha256(secret, timestamp + "." + body))` plus `x-rd-timestamp`/`x-rd-event`, retried 3× with exponential back-off, logged in `…/deliveries`; `POST …/test` sends a test event.

## Outbound request safety
Uptime checks and webhooks use `src/ssrf.js`: http(s) only, no URL credentials, ports 80/443, DNS resolved by the platform and **every** address must be public (loopback, RFC 1918, link-local/metadata, CGNAT, multicast, ULA, IPv4-mapped/NAT64 forms are refused), the connection is pinned to the vetted IP, redirects (≤ 3) are re-validated, responses capped (64 KB checks / 16 KB webhooks), `Set-Cookie` dropped. Policy failures are not retried. `RD_OBS_ALLOW_PRIVATE=1` exists for tests only.

## Status endpoints (public)
`GET /api/status` (database health, event-loop lag, every module loaded or failed with its error, uptime; `degraded` if anything is wrong), `GET /api/live`, `GET /api/ready` (503 when degraded).

## Limitations
Per-user and global metrics live in memory (lost on restart; the request log is a bounded buffer, not an archive); percentiles are computed from the retained window, not from histograms; one process only (no aggregation across instances); the notification inbox and webhooks are the only alert channels (no e-mail/SMS/PagerDuty); the uptime checker probes from the platform host, not from multiple regions.
