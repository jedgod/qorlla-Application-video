# Full-stack certification - exact SHA 810e196349e00bd68befcf4b43ccdb3df80a3ae3 (the commit now on GitHub main)

Frozen record. Separate from `8b3f76c`, `86b39ba`, `c88ccbe`, `19442d4` and `72e7f6e` (each has its own report). Source tree clean at start; the files changed afterwards are this run's own outputs.

## Fingerprints
docker-compose.yml 55b265f7ec4a720e; nginx config 453644575c7ed58e (unchanged since `19442d4`). Images: workspace-signaling-engine 7ae72033b9ce, qorlla-portal fa3828bdeb8e, meet 3552366c53db, meet-sync-worker e8ea69fed2e3.

## PASS (certification run: 12 checks passed, 0 failed)
* **Browser E2E through the nginx HTTPS origin: 44 passed, 0 failed, 0 flaky, 0 skipped** (executed, not a zero-test run): pricing/checkout/webhook (TEST DOUBLE), portal auth and authorization, billing, documents/sheets/slides, phone (telephony OFF), navigation/mobile/tablet, Meet under /meet/, meeting-to-report (TEST DOUBLE), the guest flow over HTTPS, direct-URL/WebSocket bypass refusals, PostgreSQL-stored passcode lock surviving a real MAIN container restart, recovery allowance across a restart, the deployed application role append-only on security events, the corrected `/login.html` test and the repaired notes-search test.
* **Portal node:test suites: 168 / 168.**
* **PostgreSQL lockout/permission suites (U-LOCKOUT-PG): 13 / 13.** Stress (`cert/LOCKOUT_PG_STRESS.json`): 90 attempts, **5 comparisons (budget 5): security held**; outcomes locked 8, busy 82, wrong 0, **unavailable 0**; p95 1895 ms, p99 1934 ms, max pool wait 1707 ms. Latency across the three runs on this host: p95 971 / 1843 / 1895 ms - slower on the last two; an operational observation about a deliberate single-row burst, not a capacity figure.
* Stack checks D01-D09 and D07 restart resilience: PASS. The container build includes the scheduler, sidebar, home and meeting-action code (qorlla.html, workplace.js, server.js).
* Root Playwright suite against standalone MAIN, run on this exact code before the stack run: **131 / 131**.

## FAIL
None in this run.

## NOT EXERCISED THROUGH THE STACK (honest scope of "newest features covered")
The portal E2E contains no tests for the newest MAIN features. They are covered **only** by the root suite against standalone MAIN over HTTP (131/131), not through nginx HTTPS or the containerised MAIN:
* the scheduler (quick card, full event dialog, repeat series, invitations, edit and delete effects on the live meeting);
* the home sidebar fit and the removal of the Billing card;
* the meeting "..." menu, chat button, copy meeting link and start meeting.
They run in the container image (it builds and starts, all checks pass) but their behaviour is not asserted over HTTPS. Stack-level tests for them are a recommended follow-up commit.
Also not run: production-like load/capacity, backup/restore for this SHA, real mail delivery (invitation and reset mail were only tested through the local SMTP sink in the root suite).

## BLOCKED (no evidence; never inferred from test doubles)
Real AI model, Stripe test-mode transactions, Twilio calling, real SMTP delivery, physical-device certification, independent security review, production-like load testing, approved backup and recovery operations, real-provider billing and telephony activation.

## Decision at this SHA
Functional and security regression for the stack-tested scope: PASS (no failures). The newest UI features are verified at root-suite level only (see above). **Production release: FAIL/BLOCKED** on the blocked/not-run items. Nothing was pushed by this run, merged, deployed, billed or telephony-enabled.
