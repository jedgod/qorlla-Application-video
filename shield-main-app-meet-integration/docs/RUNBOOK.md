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

---

# Workplace v4.2 - v4.5 operations

Everything below is OFF or inert by default. Nothing in this section charges a customer, places a call or sends an email until an operator
completes the matching checklist **and** sets the matching configuration.

## 1. Migrations and rollback

| Migration | Adds | Roll back with | Data lost on rollback |
|---|---|---|---|
| `004_meeting_ai.sql` | consents, jobs, transcripts, reports, action items, shares, usage ledger | `sql/rollback/004_meeting_ai.down.sql` | AI reports, transcripts, consents, shares |
| `005_phone.sql` | receptionist profiles/hours/routes, numbers, calls, voicemails, appointments, telephony events | `sql/rollback/005_phone.down.sql` | call history, voicemails, appointments |
| `006_workspace_tools.sql` | notebooks, note visibility/search, documents + versions + permissions, assistant threads/tasks | `sql/rollback/006_workspace_tools.down.sql` | assistant history, notebooks, documents (notes are kept) |
| `007_billing_launch.sql` | plan changes, refund requests, usage prices/overage, kill switches, platform audit, sales workflow | `sql/rollback/007_billing_launch.down.sql` | plan-change history, usage prices, overage records, notes on leads |

* Fresh installs apply them through `docker-compose.yml` (`docker-entrypoint-initdb.d`, in numeric order, before `003_roles.sh` grants privileges).
* **Existing databases** are migrated by running the files in order as the database owner (`psql -v ON_ERROR_STOP=1 -f ...`). Every file is idempotent. Take a backup first (`pg_dump -Fc`).
* Roll back in **reverse** order (007 -> 004). Each rollback file is idempotent and restores the previous schema exactly (verified by `tests/migrations.test.mjs`).
* `004` refuses to run unless Meet's `public.portal_meeting_directory` view exists (apply `meet-sync/sql/006_meeting_directory.sql` first).
* After adding tables on an existing database re-run `sql/003_roles.sh`-style grants (or `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA portal TO qorlla_portal_app;` plus the few `DELETE` grants listed in that script).

## 2. Telephony (v4.3) - enablement checklist

Telephony stays **OFF** unless `TELEPHONY_ENABLED=true`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, a public origin **and**
`TELEPHONY_COMPLIANCE_ACK=confirmed-numbers-consent-and-regulatory-review` are all set. While off, every provider webhook answers 503, numbers cannot be activated, and the call history is empty - nothing is simulated.

Before setting the acknowledgement, someone accountable must have confirmed:

1. The phone numbers are provisioned in the provider account and registered for the intended use (SMS/voice registration, caller-ID rules for the countries involved).
2. Recording / voicemail consent law for every jurisdiction callers may be in has been reviewed. The product plays the profile's *recording notice* before every voicemail beep and ignores any recording callback for a call where no notice was played, but it cannot decide what notice your jurisdictions require.
3. Emergency-calling limits are understood (the product never dials emergency or premium-rate numbers and cannot be relied on for emergency calls).
4. Outbound destination policy: international calling is off unless `TELEPHONY_ALLOW_INTERNATIONAL=true`. Set per-account spend limits at the provider.

Provider console configuration (replace `https://HOST` with `PORTAL_ALLOWED_ORIGIN`): voice webhook for each number `POST https://HOST/api/v1/telephony/voice/inbound`, status callback `POST https://HOST/api/v1/telephony/voice/status`; for the browser dialer create an API key + TwiML application whose voice URL is `POST https://HOST/api/v1/telephony/voice/outbound`, and set `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_TWIML_APP_SID`.
Webhook authenticity is the provider's `X-Twilio-Signature` over the **public URL built from configuration** - make sure `PORTAL_ALLOWED_ORIGIN` is exactly the URL the provider calls.

First live verification (not yet done - see the release report): place one inbound call to a test number, leave a voicemail, check the transcript/summary, place one click-to-call, then confirm minutes metering matches the provider's usage page.

## 3. Billing launch (v4.1 + v4.5) - go-live gate

Online billing is available only when `BILLING_ENABLED=true`, a secret key and a webhook secret are present, and (for a **live** key) `BILLING_LIVE_AUTHORIZED=yes-i-authorize-real-payments`. Checklist before authorising a live key:

1. Complete a full **test-mode** run against the real provider: checkout, paid invoice, renewal, failed payment, cancellation, plan upgrade (proration), scheduled downgrade, refund, month-end overage invoice item. Compare each against the provider dashboard.
2. Confirm the webhook endpoint (`/api/v1/billing/webhook`) is registered for: `checkout.session.completed`, `checkout.session.expired`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`.
3. Review `plan_prices` (the database is the only price source) and decide whether to publish any usage price (`PUT /api/v1/admin/billing/usage-prices/:feature`). **No usage price exists by default**; without one nobody can be billed beyond a plan.
4. Name the platform administrators: `PLATFORM_ADMIN_USER_IDS=<MAIN user id>,<...>`.
5. Rehearse the kill switches (section 4) and the rollback (section 1).

Plan-change semantics: upgrades and added seats take effect immediately (provider charges the proration; `plan_changes` row `requested` -> `applied` only after the provider is re-read and matches the price snapshot the customer saw). Downgrades, fewer seats and billing-cycle changes are `scheduled` for the period end and are sent to the provider ~30 minutes before renewal with no proration. A change that the provider has not confirmed within 24 hours is marked `failed`; the plan never changes without provider confirmation.

## 4. Kill switches and monitoring (v4.5)

Platform admins (`/app/admin`, or the API under `/api/v1/admin`) can switch off, without a deploy, within seconds on every replica:

| Switch | Effect when OFF |
|---|---|
| `checkout` | new checkouts answer 503 `feature_disabled` |
| `plan_changes` | change-plan and scheduled changes pause |
| `ai` | QorllaMate, AI drafts and meeting-AI job creation answer 503; AI workers stop claiming jobs (queued jobs resume when ON) |
| `overage_billing` | usage beyond a plan is no longer allowed; month-end invoicing pauses |

Switching a feature OFF requires a reason and is written to `portal.platform_audit`.

Monitoring:

* `GET /api/v1/admin/health` returns alerts (critical: provider events stuck > 10 min, rejected/unmatched provider events in 24 h; warning: refund or plan change not confirmed, past-due subscriptions, AI queues stalled > 15 min, sales leads unanswered > 24 h; info: switches that are OFF, billing enabled but unavailable).
* `GET /internal/metrics` (Prometheus text) exists only when `METRICS_TOKEN` (>= 24 chars) is set, requires `Authorization: Bearer <token>`, and is **not routed by nginx** - scrape it from inside the private network (`docker compose exec qorlla-portal ...` or a sidecar). Suggested alert rules: `qorlla_billing_events_unprocessed > 0 for 10m`, `qorlla_billing_events_rejected_24h > 0`, `qorlla_ai_oldest_queued_seconds > 900`, `qorlla_sales_inquiries_new > 0 for 24h`, `qorlla_billing_available == 0` while billing is expected on.
* Structured JSON logs (`docker compose logs qorlla-portal`) include `ALERT` lines for price mismatches and checkout re-use.

## 5. Deploy / rollback

1. Back up both databases. 2. Apply migrations (section 1). 3. `docker compose build qorlla-portal && docker compose up -d`. 4. Verify `/api/v1/health`, `/pricing/`, `/app/`, `/meet/`. 5. Keep the new capabilities dark: telephony off, billing per section 3, `ai` switch ON only after `AI_LLM_API_KEY` is configured.
Rollback: switch the affected feature OFF, `docker compose up -d` the previous image tag, then (only if the schema must go back) run the matching rollback SQL in reverse order. Data created by a newer release is lost by the rollback SQL - export first.


## Meeting passcode lockout (MAIN) - upgrade and rollback

* **What it adds**: tables `meeting_passcode_attempts`, `meeting_passcode_reservations`, `meeting_passcode_events` in the MAIN database (`meet-sync/sql/008_passcode_lockout.sql`). Policy and behaviour: `docs/PASSCODE_POLICY.md`.
* **Fresh volumes** get the migration automatically (`docker-entrypoint-initdb.d`). **Existing databases**: apply it once, as the database owner, BEFORE starting the new MAIN version: `psql -U qorlla_main -d qorlla_main -f meet-sync/sql/008_passcode_lockout.sql`. It is idempotent and upgrades an earlier revision in place. Until it is applied, protected meeting joins answer 503 (the application never falls back to memory); unprotected meetings are unaffected.
* **Standalone MAIN** (no `DATABASE_URL`) uses `DATA_DIR/auth/passcode-lockout.json` (encrypted when `ENCRYPT_KEY` is set) with an exclusive lock directory beside it. Run ONE MAIN process per data directory on one host; several instances need PostgreSQL. `LOCKOUT_STORE=file|postgres` forces a mode.
* **Rollback**: stop the new MAIN version first, then `DROP TABLE IF EXISTS public.meeting_passcode_reservations; DROP TABLE IF EXISTS public.meeting_passcode_events; DROP TABLE IF EXISTS public.meeting_passcode_attempts;`. An older MAIN that predates the lockout ignores these tables. Rolling back loses the lock history; any active locks end.
* **Operating**: a host can lift a lock from the meeting screen (3 per hour per host and meeting). To inspect: `SELECT kind, reason, at FROM public.meeting_passcode_events WHERE meeting_id = '...' ORDER BY id DESC`. Events and logs contain no passcodes, host keys or addresses.
* **Security-event retention** (owner role only, never the application role): `SELECT public.prune_passcode_events(90);` deletes rejected-request records older than 90 days (minimum 2) and logs the run in `public.meeting_passcode_maintenance`. It never deletes `locked` or `cleared_by_host` events. Verify the application role stays append-only after any role change: `SELECT has_table_privilege('qorlla_app','public.meeting_passcode_events','DELETE');` must be `f` (effective, including inherited roles); re-running `008_passcode_lockout.sql` fails loudly if it is not.
* **Guest pages through the proxy**: nginx routes `/guest`, `/guest.js` and `/auth/` to MAIN (they were missing before this change).

## Meet recording consent (v4.7) - upgrade and rollback
Apply `qorlla-meet-video/sql/v4_7_recording_consent.sql` before `005_app_role.sql` (compose mounts it as `005b_recording_consent.sql`); on an existing database run it once as the owner, then re-run 005_app_role to make consents/audit append-only. Rules, endpoints and limits: `docs/MEET_RECORDING_POLICY.md`. Rollback: stop Meet, drop the three `recording_*` tables.

## Meet recording storage (v4.0.3) - configuration, upgrade and rollback
Required to be able to record at all (otherwise `POST .../recording/start` answers 503): `RECORDING_MASTER_KEYS` (JSON `{"k1":"<base64 32 bytes>"}`), `RECORDING_ACTIVE_KEY_ID`, `RECORDING_STORE_DIR` (a private directory on a persistent volume, backed up like any data that must survive restarts). Optional: `RECORDING_ADMIN_SECRET` (enables the legal-hold admin endpoint), `RECORDING_RETENTION_DEFAULT_DAYS`, `RECORDING_MAX_BYTES`, `RECORDING_LINK_SECONDS`, `HOST_RECONNECT_GRACE_MS`, `MEETING_RATE_LIMIT`.
Apply `qorlla-meet-video/sql/v4_9_recording_storage.sql` as the owner after v4_7 and before 005_app_role (compose mounts it). **Back up the master keys separately from the recordings; losing a key makes its recordings unrecoverable.** Rollback: stop Meet, drop the new tables/columns listed at the top of the SQL file; the object directory can then be deleted.
Acceptance tests: `scripts/start-recording-test-meet.cjs` (test Meet with short clocks on :3310), then `E2E_BASE=http://localhost:3310 E2E_MEET_PATH=/ npx playwright test -c qorlla-portal/e2e/playwright.config.cjs meet-recording-storage`; and `node --test tests/recording-store.test.mjs`.

## Scheduled meetings: Start (organiser) and Join (invitees) go straight into Qorlla Meet
`meet-launch.js` registers a meeting with Meet once (server to server, `QORLLA_BRIDGE_SECRET`, Meet reachable via `MEET_INTERNAL_URL` or `MEET_PROBE_URL`), keeps Meet's host credential in `data/meet-links.json` (encrypted when `ENCRYPT_KEY` is set; never sent to a browser), and joins people on their behalf. The browser receives the session in the URL **fragment** (`#qs=`), which Meet stores and removes at once. Organiser: `POST /api/meetings/:id/meet-launch` (host only). Invitees: `POST /api/guest/sessions` returns `meet.url` after the password check. If Meet is not reachable the old built-in room is used. **Direct mode is off when `DATABASE_URL` is set** (the PostgreSQL meet-sync worker then owns registrations and host credentials; that path is not changed by this and is untested here). Passwords are stored hashed: `PUT /api/meetings/:id/passcode` (host only) sets one, and it can only be displayed at the moment it is generated. Tests: `tests/meet-handoff.spec.js` (needs `node scripts/start-recording-test-meet.cjs`).

## Meet admission control and the organiser's pre-meeting screen (v4.0.2b)
`sql/v4_10_admission.sql` (compose mounts it; `npm run dev:stack` applies it) adds `meetings.waiting_room / join_before_host / lock_on_host_join` and `participants.admission / wait_reason`. Meet ENFORCES them: a waiting (or denied) person can only call `GET /api/meetings/:id/admission`; every other route and the socket refuse them. Hosts admit or deny with `GET .../waiting` and `POST .../admit`, and change policy with `PATCH .../settings`. Guests who only waited for an absent host are admitted automatically when the host joins; `lock_on_host_join` locks when the host connects. Workplace APIs (host only, also under `/api/v1`): `GET /api/meetings/:id/preflight`, `GET .../invitation`, `PATCH .../settings`, `POST .../start` (idempotent per `requestId`). Meetings that never used the start screen keep the old behaviour (no waiting room). If Meet is unavailable a meeting with a waiting room is NOT started or joined through the basic room (it has no waiting room). Not implemented: restricting a meeting to a named invitee list (needs per-invitee identity).

## Meeting History (v4.11)
Apply `qorlla-meet-video/sql/v4_11_history.sql` (compose mounts it; dev:stack applies it) so Meet records connection sessions; MAIN pulls them for the Activity Report. Details: `docs/MEETING_HISTORY.md`. Tests: `tests/history.spec.js` (the Meet-hosted case needs `node scripts/start-recording-test-meet.cjs`).

## Free-plan meeting time limit (v4.12)
A meeting whose host is not exempt runs `FREE_MEETING_LIMIT_MIN` minutes (default 30), then a `FREE_MEETING_GRACE_MIN` grace period (default 10) with reminders at 30, 35 and 39 minutes, then it is closed for everyone with "Upgrade to have full access to Qorlla packages" and a link to `/pricing?reason=meeting-limit`. Applies to the built-in room (MAIN timers) and Meet-hosted meetings (MAIN registers `limitMs/graceMs`; Meet enforces them: `sql/v4_12_limit.sql`, `server/limit.mjs`). Exempt hosts: `MEETING_LIMIT_EXEMPT_USERS` (comma list, trailing `*` = prefix) or an account `plan` of pro/business/enterprise. `FREE_MEETING_LIMIT_MIN=0` turns it off. Real billing is NOT connected: nothing here grants a plan after payment, so until the portal writes plans onto accounts, operators exempt paying customers through the env list. Meet shows `UPGRADE_URL` (default `/pricing?reason=meeting-limit`; set it to an absolute URL when Meet and the pricing page are on different hosts). The limit is counted from when the first person connected. Tests: `tests/meeting-limit.spec.js` (units of 500 ms via `MEETING_LIMIT_UNIT_MS`).

## Email invitations (guest receives Meeting ID, link and passcode)
**What a guest gets:** host, meeting title, topic, time (scheduled meetings), Meeting ID, join link (`PUBLIC_URL`/guest/meeting/<id>/prejoin), agenda, how to join, and the **passcode only if the host supplied it when sending** (passcodes are stored hashed, so they cannot be looked up later; otherwise the email says the meeting is protected and to ask the host). Joining is stated NOT to be consent to recording. Sent from the Start screen (Email invitation > Send; typing a password there sets it and puts it in the email) and from the scheduler invitee list (a meeting created with invitees; that path needs the host's own verified account email, Reply-To is the host).
**Real delivery:** set `SMTP_URL` (e.g. `smtps://user:pass@smtp.provider.com:465`), `SMTP_FROM` (`Qorlla <no-reply@your.domain>`) and `PUBLIC_URL` (`https://your.domain`, required in production so links point at your site) before starting the server; use your provider's SPF/DKIM for your sending domain or mail may land in spam. Limits: 10 invitation sends per hour per address and 20 recipients per send (Start screen); `MAIL_DAILY_LIMIT` (default 20/day) per host for scheduler invitations.
**Local development:** with no `SMTP_URL`, `npm run dev:stack` starts `scripts/dev-mail.cjs`, a catcher: invitations appear at http://localhost:3225/ and are NOT delivered to any inbox. Tests: `tests/invitation-email.spec.js` (local SMTP sink: proves what is sent, not provider delivery).

## Windows Firewall: reaching the dev servers from other devices
Diagnosis on this PC: the firewall is on, the Wi-Fi is classed **Public**, and the `node.exe` that runs the servers (`C:\nvm4w\nodejs\node.exe`) has no inbound allow rule, so other devices are blocked; outgoing mail on 587/465 is NOT blocked (port 25 is, by the network). Fix without turning the firewall off: `powershell -ExecutionPolicy Bypass -File scripts\windows-firewall.ps1` (asks for administrator permission; opens only TCP 3200 and 3300, only from the local subnet; `-Profile Private` limits it to networks you marked Private; `-Remove` undoes it). `npm run dev:stack` prints the address other devices should use. Even then a browser on another device blocks camera and microphone on plain `http://<ip>`: real multi-device meetings need https (the Docker stack with a certificate, or a tunnel). Guests outside your network need a public deployment, not a firewall change.

## Qorlla Phone / meeting dial-in (v4.13) - rules layer only
Apply `qorlla-meet-video/sql/v4_13_phone.sql` (compose mounts it; dev:stack applies it). Config: `PHONE_DIAL_IN_NUMBERS` (JSON list of REAL numbers on the main app: `[{"country":"United States","label":"New York","number":"+12125550100","tollFree":false}]`), Meet: `PHONE_PROVIDER` (`test` = a test double; unset = telephony off), `PHONE_WEBHOOK_SECRET` (16+ chars), optional `PHONE_HASH_KEY`, `PHONE_MAX_FAILS_CALLER/MEETING`, `PHONE_LOCK_MS`, `PHONE_RATE_LIMIT`. Host creates a PIN in Phone > Join Meeting (shown once). **No carrier or media gateway exists here: see `docs/PHONE_V1_RELEASE_GATE.md` before telling anyone this works for real calls.**

## Telephony v2 (carrier numbers, calls, billing)

See `docs/TELEPHONY_V2.md` for architecture, configuration, the evidence rules behind every status, the certification checklist and the honest gap list. Quick facts: the module lives in Meet (`qorlla-meet-video/server/telephony/`), the migration is `sql/v4_14_telephony.sql` (run before `005_app_role.sql`), administrators are `PHONE_ADMIN_USERS` on the main app, and release gates are recorded with `scripts/phone-certify.mjs` (run as the database owner). Nothing is certified by default.
