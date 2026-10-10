# RD Cloude

One platform combining an **AI assistant**, **cloud infrastructure** and a **drive**.
Zero dependencies — just Node.js 20+.

```bash
cd rd-cloude
npm start          # http://localhost:3000
npm test
```

Env: `PORT`, `RD_DATA_DIR` (default `./data`), `ANTHROPIC_API_KEY` (optional, enables a real model; otherwise an offline stub replies), `RD_MODEL`.

## Features (MVP)

| Area | What works |
|---|---|
| Accounts | Register/login (scrypt), sessions, API keys (`rdk_…`, shown once, revocable), per-user data isolation, rate limiting |
| AI assistant | Conversations, projects with custom instructions/knowledge, model provider (Anthropic API or offline stub), token metering |
| Artifacts | Code blocks in replies are saved automatically; editable with version history |
| Compute | Launch small/medium/large instances; start/stop/terminate; uptime metered per hour (**simulated** — no real VMs) |
| Storage | Buckets and objects (nested keys, prefix listing) |
| Database | Document collections: CRUD + equality queries |
| Drive | Versioned files, download of any version, public share links |
| Billing | Usage & estimated cost per service (`/api/billing/usage`, `/api/billing/prices`) |
| Console | Web UI at `/` covering all of the above |

## API

All `/api/*` routes need `Authorization: Bearer <session token or rdk_ key>` except `/api/auth/*`, `/api/health` and public share links `/s/:token`.
See `src/*.js` — routes are declared next to their handlers.

## Not built yet (roadmap)

Streaming responses, file attachments in chat, real VM/container provisioning, VPC/networking, IAM roles & teams, SSO/2FA, email verification, payments, SQL databases, serverless functions, monitoring/logs, SDKs, Postgres instead of the JSON file store.
Data is stored in a single JSON file — fine for development, not for production.
