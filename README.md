# Airwallex -> ChartMogul Sync (Sevalla)

This service:
1. Receives Airwallex Billing webhooks and enqueues them (web process).
2. Processes queued events and imports invoices / creates subscription events in ChartMogul (worker process).
3. Runs a daily reconciliation that re-imports paid invoices from the last `SYNC_RECONCILE_DAYS` (cron process).

Pricing model for `leadpdfeditor.com`:
- Paid trial: **$1.99 for 1 week**
- Then: **$49.99 per month**

## Sevalla process setup
Configure a single app with these processes:

- `web`: run the webhook endpoint
  - Start command: `npm run start:web` (or `node dist/index-web.js` after build)
  - Public route: `POST /webhooks/airwallex`

- `worker`: process queued webhook events
  - Start command: `npm run start:worker` (or `node dist/index-worker.js`)

- `cron`: daily reconciliation
  - Start command: `npm run start:cron` (or `node dist/index-cron.js`)
  - Schedule: daily (choose time + timezone)

## Required environment variables
Copy `.env.example` to `.env` and fill in:

- `DATABASE_URL` (Postgres recommended)
- `AIRWALLEX_CLIENT_ID`
- `AIRWALLEX_API_KEY`
- `AIRWALLEX_WEBHOOK_SECRET`
- `CHARTMOGUL_API_KEY`
- `CHARTMOGUL_DATA_SOURCE_UUID` (optional; if omitted, the service will create a new data source)

## Initialize database
Run:
`npm run init-db`

## Sandbox validation checklist
1. Deploy code to your Sevalla app (sandbox environment if you have one).
2. Set secrets for sandbox credentials.
3. Run:
   - `npm run smoke-test`
4. Manually trigger a single webhook event in Airwallex (Billing → Webhooks preview/retrigger).
5. Confirm:
   - Worker imports the invoice for the trial (paid) and monthly charge.
   - ChartMogul shows subscriptions and the correct conversion trajectory.

## Production runbook
1. Switch Airwallex credentials/webhook secret to production.
2. Set `BACKFILL_START_DATE` and `BACKFILL_END_DATE` (any **ISO 8601** instant, e.g. `2026-03-12T01:00:00+08:00` or `...Z`). The client converts them to **UTC** for Airwallex (`from_created_at` / `to_created_at` do not accept `+08:00` style directly).
3. Run one-time backfill:
   - `npm run start:backfill`
4. Enable webhooks in Airwallex to deliver Billing events to your Sevalla `web` URL.
5. Enable the Sevalla `cron` schedule (daily reconciliation).

## No data in ChartMogul?
Deploying **web** + **worker** does not load history by itself. ChartMogul only updates when:

1. **Backfill** — You run **`npm run start:backfill`** once (same env as production), with `BACKFILL_START_DATE` / `BACKFILL_END_DATE` set. This is a **separate one-off job**, not the default `web`/`worker` start commands.
2. **Webhooks** — Airwallex must **POST** Billing events to `https://<your-app-host>/webhooks/airwallex` with **`AIRWALLEX_WEBHOOK_SECRET`** matching the secret in Airwallex. Wrong URL, wrong environment (demo vs live), or bad signature → nothing is queued → worker stays idle.
3. **Cron** — Reconciliation re-imports recent paid invoices; it does not replace backfill for old history.

In runtime logs you should see **`Claimed queued webhook events`** after Airwallex delivers webhooks. If the worker only shows **idle** / **`Worker started`**, the queue is empty: fix webhooks and/or run backfill.

## Idempotency + correctness
- Webhook events are deduplicated by Airwallex `event.id`.
- Invoice imports are deduplicated by Airwallex `invoice.id`.
- Reconciliation re-imports the last N days to recover from missed webhooks.


