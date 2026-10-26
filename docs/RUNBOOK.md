# Qorlla Workplace v4.1 - deployment and rollback runbook

## 0. What runs
`docker-compose.yml` (project directory = repo root): `dashboard-client-proxy` (nginx, the only public service), `workspace-signaling-engine` (MAIN), `qorlla-portal`, `meet`, `meet-sync-worker`, `main-db` (PostgreSQL: MAIN sync tables in `public`, portal tables in schema `portal`), `meet-db`. Everything except nginx binds to the private Docker network or `127.0.0.1`.

## 1. First deployment
1. Copy `.env.example` to `.env` and set (generate each secret independently, 32+ random chars; keys are base64 of 32 bytes):
   `PUBLIC_ORIGIN=https://your.domain` (no trailing slash), `PUBLIC_URL=$PUBLIC_ORIGIN`, `MEET_PUBLIC_URL=$PUBLIC_ORIGIN/meet/`,
   `MAIN_DB_PASSWORD`, `QORLLA_APP_DB_PASSWORD`, `PORTAL_DB_PASSWORD`, `MEET_DB_PASSWORD`, `MEET_APP_DB_PASSWORD`,
   `QORLLA_BRIDGE_SECRET`, `PORTAL_INTROSPECTION_SECRET`, `MEET_JWT_SECRET`, `RECOVERY_ESCROW_KEY`, `QORLLA_VAULT_KEY`, `ENCRYPT_KEY` (strongly recommended).
   **Back up the keys separately from database backups** (see `cert/V3_9_2_BACKUP_RESTORE.md`).
2. TLS: place `server.pem` + `server.key` in `deploy/certs/` and set `PROXY_TLS_CONF=./deploy/nginx/tls.conf`, `PROXY_HTTP_CONF=./deploy/nginx/http-redirect.conf`, `PROXY_MAIN_PORT=80`, `PROXY_MAIN_TLS_PORT=443`.
3. `docker compose up -d --build --wait`. All services must report `healthy` (`docker compose ps`).
4. Smoke test: `https://your.domain/healthz`, `/pricing/` (prices visible), `/login.html` -> sign in -> `/app/notes` (create workspace), `/meet/`.
5. Billing stays **off** (`BILLING_ENABLED=false`): the pricing page shows prices with disabled Buy buttons and "Contact sales" works.

### Existing databases
The `docker-entrypoint-initdb.d` scripts run only on an **empty** database volume. For an existing `main-db`, apply by hand (as the database owner), in order:
`qorlla-portal/sql/001_portal.sql`, `qorlla-portal/sql/002_billing.sql`, then create the role with `qorlla-portal/sql/003_roles.sh` (set `POSTGRES_USER`, `POSTGRES_DB`, `PORTAL_DB_PASSWORD`). Take a backup first.
Existing MAIN data volumes created by earlier releases were written by root: `chown -R 1000:1000` the volume before starting the non-root image.

## 2. Enabling payments (needs explicit authorization - not done by this repo)
1. Confirm the prices in `portal.plan_prices` (`UPDATE ... SET amount_cents=...`; they are what customers are charged).
2. In Stripe **test mode**: create a webhook endpoint `https://your.domain/api/v1/billing/webhook` for `checkout.session.completed`, `checkout.session.expired`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`; copy the signing secret.
3. Set `BILLING_ENABLED=true`, `STRIPE_SECRET_KEY=sk_test_...`, `STRIPE_WEBHOOK_SECRET=whsec_...`; `docker compose up -d qorlla-portal`.
4. Run a real test-mode purchase (card 4242...), confirm: plan becomes active only after the webhook, invoice appears, replaying the event in the Stripe dashboard does nothing, cancelling works, a failed payment (card 4000 0000 0000 0341) shows `past_due`. **Record the result before step 5.**
5. Live mode additionally needs `STRIPE_SECRET_KEY=sk_live_...`, a live webhook secret and `BILLING_LIVE_AUTHORIZED=yes-i-authorize-real-payments`. Do this only with written authorization.
6. Periodically (or from cron) run `POST /api/v1/billing/reconcile` for workspaces with open questions; the portal also runs an expiry sweep every 15 minutes.

## 3. Operations
* **Rotate the MAIN signing key** (identity tokens): call `auth.portalTokens.rotate()` (restart-free in a maintenance script) - old tokens stay valid 24 h via the retired public key. If using `PORTAL_JWT_PRIVATE_KEY_PEM`, replace the secret and restart MAIN (tokens signed with the old key stop verifying: users silently re-authenticate within 15 minutes).
* **Rotate `PORTAL_INTROSPECTION_SECRET`**: change in `.env`, `docker compose up -d workspace-signaling-engine qorlla-portal` (brief 503s on private endpoints).
* **Rotate `QORLLA_BRIDGE_SECRET`**: stop `meet-sync-worker`, change, restart `meet`, then the worker.
* **Logs**: `docker compose logs -f qorlla-portal dashboard-client-proxy` (JSON lines; request ids correlate nginx and portal via `X-Request-Id`).
* **Restore**: see `cert/V3_9_2_BACKUP_RESTORE.md` - back up `main-db`, `meet-db` and the MAIN data volume together, with the application stopped.

## 4. Rollback
* **Application**: `git checkout <previous tag>` and `docker compose up -d --build`. The previous release ignores the new tables; the pricing page of that release shows its built-in prices.
* **Database (billing schema)**: backup first, then `psql -U qorlla_main -d qorlla_main -f qorlla-portal/sql/rollback/002_billing.down.sql`. This **drops invoices, refunds, checkout sessions, provider events and sales inquiries**; `billing` roles become `member`; workspaces and notes are untouched. Verified by `tests/migrations.test.mjs` (up -> down -> up).
* **Turn billing off without rollback**: `BILLING_ENABLED=false` (checkout and webhooks answer 503; existing subscriptions keep their recorded state).
* **Disable the portal only**: stop `qorlla-portal`; nginx returns 502 for `/app/` and `/api/v1/` while MAIN, Meet and the old pages keep working.
