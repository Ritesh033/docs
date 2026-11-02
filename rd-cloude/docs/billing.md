# Billing, plans, quotas, notifications

Files: `src/billing.js` (metering core), `src/modules/plans.js` (plans, quotas, budgets, forecast, timeseries), `src/modules/invoices.js`
(credits, payment methods, invoices, PDF/HTML), `src/modules/notifications.js` (inbox), `public/ui/billing.js` (+ `public/charts.js`).

## Metering model
Everything billable is a row in `usage` (`{userId, kind, qty, day, ts}`); `record(db, userId, kind, qty, {key?, ts?})` is the only writer
(rejects negative/NaN/odd kinds; `key` makes it idempotent). Per-user in-memory day rollups make quota checks and charts O(1);
raw rows older than `RD_USAGE_RAW_DAYS` (default 62) are folded into one row per (user, kind, day) every 6 h (totals unchanged, hourly resolution only for the raw window).
State-derived usage is metered lazily by `syncDerived()` (before every summary, and by a 60 s sweeper): compute instance hours (delta since `instance.billedHours`) and
storage GB-month (one idempotent row per elapsed day using the current byte count — an approximation of the daily average). Unknown kinds are stored and shown as `unpriced`.

## Plans and quotas
`free` (included usage $5), `pro` ($20, $25 included), `team` ($60, $100 included); paid plans have a one-time 14-day trial. Upgrading after the trial needs a payment method
and creates a prorated adjustment on the next invoice; downgrading credits the unused part. `POST /api/billing/plan/cancel` cancels at period end.
`ctx.quotas` (used by AI, and by modules that want limits): `check(userId, kind, qty) -> {allowed, limit, used, remaining, window, resetAt, reason?}`,
`enforce(...)` (throws HttpError 429/402 with `retry-after`), `usage`, `limits`, `registerGauge(kind, fn)`. Kinds without a plan limit are always allowed.
Windows: `day`, `month`, or `gauge` (current level: `storage.bytes`, `compute.instances`, `sql.databases`). `RD_QUOTAS_DISABLED=1` turns enforcement off.
Budgets (`/api/billing/budgets`) notify once per threshold per month (default 50/80/100 %); with `hardStop` every priced kind is refused (HTTP 402) once the month-to-date cost reaches the budget.

## Invoices and payments
Closed months are invoiced once per user (sweeper every 6 h, `POST /api/billing/invoices/generate` for a past period): subscription fee, priced usage lines, included-usage allowance, adjustments, tax (`/api/billing/settings`), credits (FIFO by expiry).
Rendered as JSON, HTML (escaped, `Content-Security-Policy: sandbox`) and a hand-written PDF 1.4 (Courier text, valid xref). Payments use the **simulated `test` provider** only:
tokens `tok_visa`, `tok_mastercard`, `tok_amex`, `tok_declined`, `tok_insufficient`, `tok_expired`. Anything that looks like a card number (Luhn-valid 13–19 digits anywhere in the body, or keys such as `card`/`number`/`cvc`) is rejected with 400 and never stored.
Add a real provider by assigning `ctx.paymentProviders.<name> = { charge({token, amountCents, idempotencyKey}) }`. Coupons: `WELCOME10`, `LAUNCH25` (override with `RD_COUPONS`).

## Notifications
`ctx.notify(userId, {title, body, level, link, source})` or `ctx.events.emit('notification', {...})`. Max 500 per user (oldest dropped), links must be in-app (`#…` or `/…`).

## Limitations
Compute/storage metering is sampled (sweeper + on read), not event-exact. One currency (USD). The PDF is plain text. No real payment processing, no tax-jurisdiction logic, no org-level billing.
