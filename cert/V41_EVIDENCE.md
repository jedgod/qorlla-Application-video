# Workplace v4.1 certification evidence

- Git HEAD: `e9878003952817b2216c251506e639b34bbe1238` (branch feature/qorlla-workplace-v4.5; source tree clean)
- Result: **11 passed, 0 failed**
- Payment provider = local TEST DOUBLE; real-provider verification is BLOCKED (no account/keys, no authorization to collect payments).

| ID | Result | Check | Detail |
|---|---|---|---|
| U-ALL | PASS | portal node:test suites (auth, billing lifecycle, entitlements, sales, migrations/rollback, real-MAIN contract) | 168 passed, 0 failed |
| D01 | PASS | docker compose config is valid and every long-running service has a restart policy | 7 services: dashboard-client-proxy, main-db, meet, meet-db, meet-sync-worker, qorlla-portal, workspace-signaling-engine |
| D02 | PASS | unified stack builds and every service becomes healthy (main, portal, meet, databases, nginx) | main-db=healthy meet=healthy meet-db=healthy meet-sync-worker=running qorlla-portal=healthy workspace-signaling-engine=healthy dashboard-client-proxy=healthy |
| D03 | PASS | single HTTPS entry point: only nginx listens on public interfaces; app services bind loopback or nothing | only dashboard-client-proxy (nginx) is published on 0.0.0.0 |
| D04 | PASS | containers run unprivileged; structured JSON logs from portal and nginx; no secrets in logs | 4 portal and 1 nginx JSON lines parsed |
| D05 | PASS | least-privilege roles: portal role can only touch the portal schema |  |
| D06 | PASS | portal fails closed (503) while authentication is not operational, and answers 401 once configured | 503 ["MAIN_AUTH_ISSUER","MAIN_AUTH_JWKS_URL","PORTAL_ALLOWED_ORIGIN","MAIN_INTROSPECTION_URL + PORTAL_INTROSPECTION_SECRET (>=32 chars)"] |
| D08 | PASS | a platform admin can be provisioned (configuration only) and the console + metrics are not reachable by anyone else | admin id configured; /internal/metrics is not routed publicly |
| D09 | PASS | metrics are served inside the private network only, with the bearer token, as Prometheus text with no secrets | 9 gauges |
| E2E | PASS | browser E2E: pricing, checkout/webhook, portal auth, navigation, mobile, Meet under /meet/, meeting-to-report | 39 passed, 0 failed |
| D07 | PASS | restart resilience: portal and nginx restart cleanly and the site keeps serving |  |

## Browser E2E test titles
- ok upgrade now, schedule a downgrade, cancel it; usage panel says no pay-as-you-go prices exist
- ok the platform console is invisible to ordinary users and works for the configured admin: overview, health, refund, sales workflow, kill switch
- ok Meet UI loads under /meet/, redirects /meet, and its assets and API are prefix-aware
- ok internal bridge, recovery and readiness endpoints are not reachable even with the right secret header
- ok two browsers meet under /meet/: websocket upgrade on the prefixed path, chat both ways, passcode, refresh and rejoin
- ok host consents, builds a report from the real Meet chat, assigns work, shares, exports, and revokes - with permissions enforced throughout
- ok plan limit: the Basic plan allows 3 AI reports a month and the dashboard explains it
- ok every internal link on the pricing page, the portal and the apps menu resolves (no dead product/sidebar links)
- ok [I07] header and product links on the pricing page are same-origin routes to the portal
- ok [I08][I09] sidebar items work from the keyboard and open real portal pages
- ok apps menu opens, items are reachable by Tab, and Escape closes it and restores focus
- ok highlights expand/collapse by mouse and keyboard
- ok phone layout: pricing and portal pages do not overflow horizontally and purchase controls stay reachable
- ok tablet layout: pricing and portal pages do not overflow horizontally and purchase controls stay reachable
- ok legacy pages keep working: /index.html (built-in meetings), /chat.html, /qorlla.html, /login.html
- ok [I01][I02][I03] the catalogue is same-origin only: no CORS grants, GET-only, private endpoints closed
- ok the phone page states that telephony is off, shows an empty history, and public webhooks refuse to run
- ok receptionist: create a profile, set business hours, enable it, add rules, and book an appointment against the hours
- ok the workspace owner sees the manager-only phone sections
- ok signed-out visitors get a sign-in prompt on private pages and the API answers 401
- ok sign up in MAIN -> portal onboarding -> workspace -> notes with plan quota; second user cannot see the data
- ok plan limit is enforced and explained in the UI
- ok an expired portal token is renewed silently from the live MAIN session; sign-out ends access at once
- ok tampered / garbage portal cookies are refused (and MAIN has no session to renew from)
- ok billing page: owner sees plan and invoices area; billing details stay hidden from plain members
- ok [I04][I05] displayed prices equal the database-backed API (monthly and annual), with computed saving
- ok [I06] annual/monthly switch works with the mouse and the keyboard and exposes its state
- ok seat count changes the displayed total
- ok [I13] a price change in PostgreSQL shows on the page after reload; nothing is cached or hard-coded
- ok [I14] annual billing is disabled (not invented) when a plan has no annual price row
- ok [I15] catalogue unavailable => explicit "unavailable" state, buying disabled, NO fallback prices; Retry recovers
- ok when the server says checkout is not available, purchase buttons are disabled with an explanation
- ok [I12] Enterprise "Contact sales" creates a real inquiry in PostgreSQL (and the honeypot does not)
- ok signed-out visitors who click Buy are sent to sign in and come back to pricing
- ok [I10] signed-in Buy creates a SERVER-SIDE checkout with the database price; the redirect alone activates nothing; a verified webhook does
- ok notes are private by default, searchable and filed in notebooks; a colleague in the same workspace sees none of it
- ok documents: create, edit with version history and restore, optimistic-concurrency conflict, and sharing as read-only
- ok sheets and slides edit and persist; AI draft is labelled and private (test-double model)
- ok QorllaMate proposes, the user approves, and only then does the note exist; email stays blocked (test-double model)
