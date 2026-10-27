# Qorlla Workplace v4.2 - v4.5 release report

_Generated 2026-10-27T01:05:48.125Z by `node cert/build-workplace-report.mjs` from the evidence files. Statements below are read from those files; anything not executed is marked NOT EXECUTED or BLOCKED._

## 1. Decision

| Release | Code gate (executed tests) | Production gate |
|---|---|---|
| v4.2 AI Meeting Intelligence | **PASS** | **BLOCKED** |
| v4.3 AI Receptionist and Phone | **PASS** | **BLOCKED** |
| v4.4 QorllaMate, Notes and Productivity | **PASS** | **BLOCKED** |
| v4.5 Billing and Enterprise Launch | **PASS** | **BLOCKED** |

**Overall: PASS for staging / test-double environments; BLOCKED for production launch.** Production is blocked, not failed, because the external dependencies cannot be exercised without credentials, accounts, hardware and approvals that this work does not have (section 8). Nothing was deployed.

## 2. Exact version tested

- Git SHA: `e9878003952817b2216c251506e639b34bbe1238`
- Branch: `feature/qorlla-workplace-v4.5`
- Runner finished: 2026-10-27T00:51:50.041Z
- Source tree at certification: clean
- Working tree now (`git status --porcelain`): 25 entries (certification output files and this report are untracked evidence)

## 3. What was implemented

- **v4.2 AI Meeting Intelligence** - host-attested consent (recordings are never processed), leased job queue with fenced writes and backoff, Meet chat export through a read-only secret, reports with decisions/topics/action items, server-side visibility levels, bearer-link shares, PDF/DOCX export, usage ledger and plan quota, transcript retention purge.
- **v4.3 AI Receptionist and Phone** - profiles, business hours/closures, routing rules and keypad menus, signature-verified provider webhooks, voicemail with recording-notice gate and AI summaries, escalation acknowledgement, click-to-call and browser dialer token, appointment booking with conflict-free slots, minutes metering, analytics. **Off by default.**
- **v4.4 QorllaMate, Notes and Productivity** - private-by-default notes with notebooks and search, documents/sheets/slides with immutable versions, optimistic concurrency and explicit sharing, AI drafts, assistant threads whose actions are human-approved proposals.
- **v4.5 Billing and Enterprise Launch** - plan upgrade/downgrade with proration and period-end scheduling, admin-initiated refunds, opt-in usage-based AI billing with price snapshots, platform admin console, Enterprise sales workflow, kill switches, health alerts and a token-protected metrics endpoint, per-user rate limits.

## 4. Migrations

- `qorlla-portal/sql/001_portal.sql`
- `qorlla-portal/sql/002_billing.sql` (rollback: `sql/rollback/002_billing.down.sql`)
- `qorlla-portal/sql/003_roles.sh`
- `qorlla-portal/sql/004_meeting_ai.sql` (rollback: `sql/rollback/004_meeting_ai.down.sql`)
- `qorlla-portal/sql/005_phone.sql` (rollback: `sql/rollback/005_phone.down.sql`)
- `qorlla-portal/sql/006_workspace_tools.sql` (rollback: `sql/rollback/006_workspace_tools.down.sql`)
- `qorlla-portal/sql/007_billing_launch.sql` (rollback: `sql/rollback/007_billing_launch.down.sql`)

Up/down/up behaviour, idempotency and constraint checks are executed by `tests/migrations.test.mjs`.

## 5. API contract

`docs/API_CONTRACT.md` is generated from the route registrations (141 routes, each with its access class). Regenerate with `node cert/gen-api-contract.mjs`.

## 6. Automated test results

Node test suites against real PostgreSQL (Stripe, Twilio and the language model are labelled test doubles): **168 passed, 0 failed** (168 tests per the TAP summary).

| Suite | Tests | Result |
|---|---|---|
| authentication & authorization | 13 | PASS |
| billing launch: plan changes, refunds, usage billing, admin console | 20 | PASS |
| subscription lifecycle | 19 | PASS |
| MAIN <-> portal identity contract (real MAIN auth module) | 7 | PASS |
| backend entitlement enforcement, sales inquiries | 5 | PASS |
| abuse limits: per-user rate limits on costly endpoints and request sizes that match the schemas | 3 | PASS |
| AI meeting intelligence | 27 | PASS |
| PostgreSQL migration and rollback | 8 | PASS |
| telephony routing (pure logic) | 7 | PASS |
| AI receptionist and phone (API + webhooks against PostgreSQL) | 33 | PASS |
| document content (pure) | 2 | PASS |
| notes, documents and QorllaMate (API against PostgreSQL) | 24 | PASS |

### Deployment checks (unified Docker stack: MAIN, Meet, portal, three PostgreSQL databases, nginx/TLS)

- **D01 PASS** - docker compose config is valid and every long-running service has a restart policy - 7 services: dashboard-client-proxy, main-db, meet, meet-db, meet-sync-worker, qorlla-portal, workspace-signaling-engine
- **D02 PASS** - unified stack builds and every service becomes healthy (main, portal, meet, databases, nginx) - main-db=healthy meet=healthy meet-db=healthy meet-sync-worker=running qorlla-portal=healthy workspace-signaling-engine=healthy dashboard-client-proxy=healthy
- **D03 PASS** - single HTTPS entry point: only nginx listens on public interfaces; app services bind loopback or nothing - only dashboard-client-proxy (nginx) is published on 0.0.0.0
- **D04 PASS** - containers run unprivileged; structured JSON logs from portal and nginx; no secrets in logs - 4 portal and 1 nginx JSON lines parsed
- **D05 PASS** - least-privilege roles: portal role can only touch the portal schema
- **D06 PASS** - portal fails closed (503) while authentication is not operational, and answers 401 once configured - 503 ["MAIN_AUTH_ISSUER","MAIN_AUTH_JWKS_URL","PORTAL_ALLOWED_ORIGIN","MAIN_INTROSPECTION_URL + PORTAL_INTROSPECTION_SECRET (>=32 chars)"]
- **D07 PASS** - restart resilience: portal and nginx restart cleanly and the site keeps serving
- **D08 PASS** - a platform admin can be provisioned (configuration only) and the console + metrics are not reachable by anyone else - admin id configured; /internal/metrics is not routed publicly
- **D09 PASS** - metrics are served inside the private network only, with the bearer token, as Prometheus text with no secrets - 9 gauges

### Browser E2E (Chromium against the unified HTTPS origin, real MAIN sign-in, real PostgreSQL)

**39 passed, 0 not passed** of 39.

- PASS `billing-launch.spec.js` - upgrade now, schedule a downgrade, cancel it; usage panel says no pay-as-you-go prices exist
- PASS `billing-launch.spec.js` - the platform console is invisible to ordinary users and works for the configured admin: overview, health, refund, sales workflow, kill switch
- PASS `meet-route.spec.js` - Meet UI loads under /meet/, redirects /meet, and its assets and API are prefix-aware
- PASS `meet-route.spec.js` - internal bridge, recovery and readiness endpoints are not reachable even with the right secret header
- PASS `meet-route.spec.js` - two browsers meet under /meet/: websocket upgrade on the prefixed path, chat both ways, passcode, refresh and rejoin
- PASS `meeting-ai.spec.js` - host consents, builds a report from the real Meet chat, assigns work, shares, exports, and revokes - with permissions enforced throughout
- PASS `meeting-ai.spec.js` - plan limit: the Basic plan allows 3 AI reports a month and the dashboard explains it
- PASS `navigation.spec.js` - every internal link on the pricing page, the portal and the apps menu resolves (no dead product/sidebar links)
- PASS `navigation.spec.js` - [I07] header and product links on the pricing page are same-origin routes to the portal
- PASS `navigation.spec.js` - [I08][I09] sidebar items work from the keyboard and open real portal pages
- PASS `navigation.spec.js` - apps menu opens, items are reachable by Tab, and Escape closes it and restores focus
- PASS `navigation.spec.js` - highlights expand/collapse by mouse and keyboard
- PASS `navigation.spec.js` - phone layout: pricing and portal pages do not overflow horizontally and purchase controls stay reachable
- PASS `navigation.spec.js` - tablet layout: pricing and portal pages do not overflow horizontally and purchase controls stay reachable
- PASS `navigation.spec.js` - legacy pages keep working: /index.html (built-in meetings), /chat.html, /qorlla.html, /login.html
- PASS `navigation.spec.js` - [I01][I02][I03] the catalogue is same-origin only: no CORS grants, GET-only, private endpoints closed
- PASS `phone.spec.js` - the phone page states that telephony is off, shows an empty history, and public webhooks refuse to run
- PASS `phone.spec.js` - receptionist: create a profile, set business hours, enable it, add rules, and book an appointment against the hours
- PASS `phone.spec.js` - the workspace owner sees the manager-only phone sections
- PASS `portal.spec.js` - signed-out visitors get a sign-in prompt on private pages and the API answers 401
- PASS `portal.spec.js` - sign up in MAIN -> portal onboarding -> workspace -> notes with plan quota; second user cannot see the data
- PASS `portal.spec.js` - plan limit is enforced and explained in the UI
- PASS `portal.spec.js` - an expired portal token is renewed silently from the live MAIN session; sign-out ends access at once
- PASS `portal.spec.js` - tampered / garbage portal cookies are refused (and MAIN has no session to renew from)
- PASS `portal.spec.js` - billing page: owner sees plan and invoices area; billing details stay hidden from plain members
- PASS `pricing.spec.js` - [I04][I05] displayed prices equal the database-backed API (monthly and annual), with computed saving
- PASS `pricing.spec.js` - [I06] annual/monthly switch works with the mouse and the keyboard and exposes its state
- PASS `pricing.spec.js` - seat count changes the displayed total
- PASS `pricing.spec.js` - [I13] a price change in PostgreSQL shows on the page after reload; nothing is cached or hard-coded
- PASS `pricing.spec.js` - [I14] annual billing is disabled (not invented) when a plan has no annual price row
- PASS `pricing.spec.js` - [I15] catalogue unavailable => explicit "unavailable" state, buying disabled, NO fallback prices; Retry recovers
- PASS `pricing.spec.js` - when the server says checkout is not available, purchase buttons are disabled with an explanation
- PASS `pricing.spec.js` - [I12] Enterprise "Contact sales" creates a real inquiry in PostgreSQL (and the honeypot does not)
- PASS `pricing.spec.js` - signed-out visitors who click Buy are sent to sign in and come back to pricing
- PASS `pricing.spec.js` - [I10] signed-in Buy creates a SERVER-SIDE checkout with the database price; the redirect alone activates nothing; a verified webhook does
- PASS `workspace.spec.js` - notes are private by default, searchable and filed in notebooks; a colleague in the same workspace sees none of it
- PASS `workspace.spec.js` - documents: create, edit with version history and restore, optimistic-concurrency conflict, and sharing as read-only
- PASS `workspace.spec.js` - sheets and slides edit and persist; AI draft is labelled and private (test-double model)
- PASS `workspace.spec.js` - QorllaMate proposes, the user approves, and only then does the note exist; email stays blocked (test-double model)

### Meet + MAIN certification on this branch (C01-C24, R01-R05)

Result file written 2026-10-27T00:58:33.277Z for SHA `e9878003952817b2216c251506e639b34bbe1238`: **38 PASS, 0 FAIL** of 38 recorded checks.

### Meet side, same commit: security, proxy and browser suites

- Meet/MAIN security checks (SEC01-SEC15, `cert/run-security.mjs`): 15 PASS, 0 FAIL of 15 (SHA `e9878003952817b2216c251506e639b34bbe1238`)
- nginx proxy certification (P01-P12, `cert/run-proxy-cert.mjs`): 11 PASS, 0 FAIL of 11 (SHA `e9878003952817b2216c251506e639b34bbe1238`)
- Meet/MAIN browser suite (`npx playwright test`, root `tests/`): 25 passed
- **NOT EXECUTED on this branch:** the v3.9.2 load runner (`cert/run-load.mjs`) and backup/restore runner (`cert/run-backup-restore.mjs`). Their earlier results belong to the Meet release branch; they were not re-run here and nothing in this report claims them.

### Branch integration (Part G)

- The Workplace work lives on `feature/qorlla-workplace-v4.5` (a chain of feature branches v4.1 -> v4.5); the Meet release branch `release/qorlla-meet-v3.9.2-production-closure` was **not modified**. Its tip was merged INTO the Workplace branch so the Workplace branch runs the identical Meet code; the first attempt (branched from an older Meet commit) failed two Meet security checks until that merge, which is why this is recorded.
- Meet certification after integration: C01-C24/R01-R05/RC01-RC08, SEC01-SEC15, P01-P12 and the browser suite above, all on SHA `e9878003952817b2216c251506e639b34bbe1238`.
- `stash@{N}: wip/portal-v4 ...` was inspected, **not applied**. It contains the first (v4.0) pricing-page wiring and the original portal-v4 pack. Everything useful in it was already re-implemented in v4.1 in a safer form (same-origin routes instead of a `?portal=` URL remembered in localStorage and a cross-origin catalogue, database-backed annual prices, working checkout). Applying it would have re-introduced a link-injection risk and removed the annual-price support. It remains untouched in the repository stash list (note: a `git rebase --autostash` created an extra `autostash` entry above it that only holds line-ending noise, so the WIP stash is now `stash@{1}`).

### Certification-harness corrections made on the way (test code only; no product behaviour was changed to make a check pass)

- **RC08** read the escrow immediately after un-pausing Meet's database, racing the worker that legitimately finishes the acknowledgement within a second. It now accepts exactly two end states (still pending with its ciphertext, or acknowledged) and fails on anything else.
- **P10** stopped a host Meet process while nginx was (since the unified compose file) proxying to a dockerised `meet` service, so "Meet down" still answered 200. The proxy runner now points nginx at the host process and starts only the services it needs.
- The runners' fetch wrapper also retries stale keep-alive sockets reported as `UND_ERR_SOCKET` (it already did for `ECONNRESET`); a single such error had failed RC05 once.
- Portal runner: probes of the self-signed test certificate, `D06` output parsing, and the "source tree clean" check (it counted its own evidence files as source) were corrected.
- Real product defects found by the first complete browser run are listed in the security review (F1-F6), e.g. the `/app` redirect loop.
- Observed but not explained: one run of the unit stage reported 24 failures (503 from the portal's fail-closed authentication) while a previous, aborted certification's Docker build was still consuming the machine; the same suites passed in isolation and in the next three complete runs. Treat portal authentication as sensitive to heavy host load.

### Dependency audit

`npm audit --omit=dev` (qorlla-portal): {"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}

## 7. Security findings

See `docs/SECURITY_REVIEW_v4.2-v4.5.md`: six defects found and fixed during certification (including a redirect loop and a cost-abuse gap), the controls proven by tests, and the residual risks. It is the **author's** review, not an independent one.

## 8. Blockers (why production is BLOCKED)

- **v4.2** - Real language-model provider (AI_LLM_API_KEY) was never called: the model in every test is a labelled test double, so summary quality and the real API contract are UNVERIFIED.
- **v4.3** - No real inbound or outbound call has been placed: there is no provider account, provisioned number or compliance sign-off. Telephony is OFF by default and every test uses a labelled Twilio test double.
- **v4.3** - Recording-consent / regulatory review is an operator responsibility and has not been done.
- **v4.4** - The assistant and AI drafts run against a test-double model; no external action exists (email is blocked because no mail provider is configured).
- **v4.5** - Real payments were never collected and the real Stripe API was never called (test double only); plan changes, refunds and overage invoice items are UNVERIFIED against a Stripe test-mode account.
- **v4.5** - Live key use additionally needs BILLING_LIVE_AUTHORIZED and explicit owner approval - not granted.
- **All** - No independent security review or penetration test.
- **All** - No real-device / real-network verification of the browser UI beyond headless Chromium with fake media.
- **All** - No backup schedule / RPO-RTO evidence for the portal databases (the v3.9.2 backup/restore runner covers MAIN and Meet only).
- **All** - Nothing was deployed to any environment, and no real customer, caller or payment was involved.

## 9. Deploy and rollback

See `docs/RUNBOOK.md` (sections 1-5 of "Workplace v4.2 - v4.5 operations"): migration order and rollback SQL, telephony enablement checklist, billing go-live gate, kill switches, metrics and alert rules, rollback procedure. Keep telephony off, billing unauthorised and the `ai` switch off until their checklists are complete.

## 10. Working-tree status

```
M cert/EVIDENCE.md
 M cert/PROXY_EVIDENCE.json
 M cert/PROXY_EVIDENCE.md
 M cert/SECURITY_EVIDENCE.json
 M cert/SECURITY_EVIDENCE.md
 M cert/build-workplace-report.mjs
 M cert/evidence.json
 M cert/screenshots/C12-independent.png
 M cert/screenshots/C12-returned.png
 M cert/screenshots/C13-prefs.png
 M cert/screenshots/C14-passcode.png
 M cert/screenshots/C16-guest.png
 M cert/screenshots/C16-host.png
 M cert/screenshots/C24-pending.png
 M cert/screenshots/P06-proxy-passcode.png
 M cert/screenshots/P07-proxy-guest.png
 M cert/screenshots/P07-proxy-host.png
?? cert/V41_EVIDENCE.json
?? cert/V41_EVIDENCE.md
?? cert/WORKPLACE_V4_5_REPORT.json
?? cert/WORKPLACE_V4_5_REPORT.md
?? cert/e2e-output.txt
?? cert/e2e-results.json
?? cert/npm-audit.json
?? cert/portal-unit.tap
```
