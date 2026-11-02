# Serverless functions

`src/modules/functions.js` (API, scheduler, queue, brokers), `src/functions-runner.js` (the process that runs user code), UI `public/ui/functions.js`.

## Programming model
```js
module.exports = async (event, ctx) => ({ hello: event.name })   // or: export default async (event, ctx) => …  /  export async function handler(…)
```
`ctx`: `requestId, functionName, version, alias, memoryMb, getRemainingTimeMs(), log, env, kv, fetch`. `console.*` and `ctx.log` are captured (≤ 200 lines / 64 KB per invocation). `require` is limited to
`crypto util path url querystring string_decoder events assert zlib buffer stream timers perf_hooks`. Results must be JSON (≤ 1 MB). Module-level state survives between invocations while the (warm) process lives, exactly like a warm Lambda container; do not rely on it.
Each function has versions (≤ 50, immutable, `sha256`), aliases (`live` follows new saves; any alias can be pinned), environment variables (≤ 50; **secrets are AES-256-GCM encrypted at rest** with a key derived from the master key, bound to user + function + name, and never returned by the API), memory 64–512 MB and a timeout up to `RD_FN_MAX_TIMEOUT_MS` (30 s).

## Sandbox (read this before running untrusted code in production)
Each function runs in its own **process** (never shared between functions or users), started as
`unshare --net --pid --fork --kill-child -- sh -c 'ulimit …; exec node --permission …'` with an **empty environment** and an empty cwd:

| Layer | What it blocks |
|---|---|
| network namespace | all network access (even loopback to the platform itself); `ctx.fetch` is brokered by the platform instead |
| PID namespace | the function is PID 1 of its own tree: it cannot see or signal any host process |
| Node permission model (`--permission`) | file system (only the runner file is readable), child processes, worker threads, native addons, `process.binding` |
| ulimits | address space (`4×` memory, ≥ 1 GB), open files, core dumps; V8 `--max-old-space-size` |
| host | hard wall-clock SIGKILL of the whole namespace, stdout cap (4 MB), concurrency limits, warm workers recycled after 50 runs and 30 s idle |

The test suite **escapes the `vm` layer on purpose** (`globalThis.process.getBuiltinModule(...)`) and asserts that env, `/etc/passwd`, `/proc`, the temp dir, writes, `execSync`, workers, `process.binding`, loopback connections to the platform's own server, DNS and `kill(hostPid)` all fail.
The `vm`/`require` whitelist is a convenience, **not** a security boundary — the layers above are. `unshare` namespaces and `--permission` are required: without them function execution is **refused (503)** unless `RD_FUNCTIONS_UNSAFE=1` (development only).
**Not covered:** kernel/container-escape vulnerabilities (a hardened multi-tenant deployment should add gVisor/Firecracker/seccomp), CPU time beyond the wall-clock limit, and side channels. The namespace tools need either root or unprivileged user namespaces (`unshare -r`, tried automatically).

## `ctx.kv`
Per-function JSON key-value store (`get/set/delete/list(prefix)`), keys `[A-Za-z0-9_.:/-]{1,128}`, values ≤ 256 KB, ≤ 1000 keys, 10 MB total, ≤ 50 calls per invocation, brokered over stdin/stdout and authorised by the host per function.

## `ctx.fetch` (off by default)
Enable per function with `allowNetwork` + `allowedHosts` (`api.example.com`, `*.example.org`, `host:port`). The platform performs the request: http(s) only, no URL credentials, ports 80/443 unless the allowlist names the port, DNS resolved by the platform and **every** address must be public (loopback, RFC 1918, link-local/metadata `169.254.*`, CGNAT, multicast, ULA, IPv4-mapped/NAT64 forms are blocked), the connection is pinned to the vetted IP, redirects (≤ 3) are re-validated from scratch, request ≤ 1 MB, response ≤ 2 MB, 10 s, ≤ 10 calls per invocation, `Set-Cookie` stripped.

## Triggers
* **API**: `POST /api/functions/:id/invoke {event, alias|version, async}` (sync result with logs/billing, or `202 {jobId}`).
* **HTTP**: `PUT …/trigger {http:{enabled, auth:'apiKey'|'none'}}` exposes `ALL /fn/:id[/*]`. Event = `{method, path, query, headers, body, isBase64}` (**Authorization and Cookie are never forwarded**). The handler may return `{statusCode, headers, body, isBase64}` or any JSON. Responses are hardened: always `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox` (so even `text/html` runs in an opaque origin without scripts and cannot touch the console's storage), content types outside a small allowlist become `application/octet-stream`, only allowlisted headers pass (no `Set-Cookie`, CR/LF injection and `javascript:` redirects dropped). Disabled functions answer 404 like missing ones.
* **Schedule**: 5-field cron in UTC (`*/5 * * * *`, ranges, lists, month/day names, standard dom/dow OR rule), ≤ 10 per user, evaluated every 10 s; missed runs fire once.
* **Async + retries**: persisted queue, at-least-once (jobs in flight at a crash are re-queued), 3 attempts with 1 s / 4 s back-off, then the **dead-letter list** (`GET/DELETE …/dlq`, `POST …/dlq/:id/retry`).

## Limits & metering
Per user 5 (`RD_FN_USER_CONCURRENCY`), per function 5 (`RD_FN_CONCURRENCY`), global 8 (`RD_FN_MAX_CONCURRENCY`) concurrent invocations (sync callers wait ≤ 2 s, then 429); event ≤ 256 KB (HTTP body ≤ 1 MB); ≤ 50 functions per user; 300 invocation records kept per function.
Metering: `functions.invocations` and `functions.gb_seconds` (memory × billed time, 100 ms granularity; timeouts bill the full timeout); the plan quota `functions.invocations` is enforced.

## Limitations
JavaScript only (Node 22), no custom npm packages or layers, no streaming responses, cron is UTC only, warm-pool state is best-effort, `ctx.fetch` returns text bodies only.
