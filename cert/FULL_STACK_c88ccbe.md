# Full-stack certification - exact SHA c88ccbeb9cddf1dbf0a4193340e1be6ea2743d7a (follow-up: attempt release, durable recovery, SMTP tests)

Frozen record, separate from `8b3f76c` (baseline) and `86b39ba` (first lockout patch; browser E2E did not execute). Source tree clean at start.

## Fingerprints
docker-compose.yml 55b265f7ec4a720e; nginx config a6f694eb6944399d (unchanged since the baseline: it has NO route for /guest or /auth, see finding 1). Images: workspace-signaling-engine 86dff038bf71, qorlla-portal 919b7a288e51, meet 85a3aeee313b, meet-sync-worker a87e3b3a9739.

## PASS
* Root Playwright suite (standalone MAIN): 99 / 99 (includes lockout store tests, real-server restart/concurrency, SMTP reset-flow tests, 5 of which are the local SMTP sink checks). PostgreSQL lockout adapter tests: 8 / 8.
* Portal node:test suites: 168 / 168. Stack checks D01-D09 (all PASS, including the new `008` migration initialising cleanly).
* **Browser E2E EXECUTED through the nginx HTTPS origin: 41 passed, 2 failed (43 run).** This includes the corrected `/login.html` compatibility test (now PASS), pricing, checkout/webhook (test double), portal auth/authorization, notes/docs, phone (telephony OFF), billing console, navigation/mobile/tablet, Meet under /meet/ and meeting-to-report (test double), and the HTTPS guest bypass test (no session / wrong-meeting session / passcode field on the socket all refused; REST needs the passcode) and the role-privilege assertion.

## FAIL (2, both in the new `guest-meeting.spec.js`; both are real findings, neither is "test only")
1. **Guest Welcome is not reachable through the unified stack.** `GET /guest/welcome` returns 404 at the nginx origin: `deploy/nginx/snippets/main-locations.conf` has no route for `/guest`, `/guest.js` or `/auth/*` (guest.html/guest.js are not mounted in the proxy either). The guest pages worked only on standalone MAIN. Deployment defect, present since the guest routes were added.
2. **Restart step could not run**: `docker restart qv41-workspace-signaling-engine-1` failed because the MAIN container is named `zoom_core_backend_instance` (`container_name` in docker-compose.yml). Test-harness defect. Consequently the claim "the PostgreSQL lock survives a MAIN container restart" was NOT demonstrated through the stack at this SHA (the lock rows and 429 before the restart were asserted and passed; everything after the restart did not run).

## NOT RUN / NOT DEMONSTRATED at this SHA
* Lock persistence across a real MAIN container restart; recovery allowance across a restart; host recovery through the HTTPS origin.
* Backup/restore and production-like load for this SHA.

## BLOCKED (no evidence; never inferred from test doubles)
Real AI model, Stripe test-mode transactions, Twilio calling, SMTP delivery to a real provider, physical devices, independent security review, production-like load, approved backup/recovery operations.

## Accepted follow-up findings (to be fixed in the next candidate commit)
1. nginx must route `/guest`, `/guest.js`, `/auth/` to MAIN. 2. Correct the MAIN container name in the harness. 3. Recovery allowance across a MAIN restart (2 recoveries, restart, exactly 1 more). 4. Remove DELETE on security events from the application role (including inherited grants) with an upgrade migration and an effective-permission test. 5. PostgreSQL stress test must report outcome counts, comparisons, latency and pool wait.

## Decision at this SHA
Lockout and recovery logic: remediated and verified at store, server-process and PostgreSQL level. Full-stack: NOT yet clean (2 failures, one a genuine routing defect). Production: FAIL/BLOCKED.
