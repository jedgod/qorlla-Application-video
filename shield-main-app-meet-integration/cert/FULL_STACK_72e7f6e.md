# Full-stack certification - exact SHA 72e7f6e95025e6c8031e1990edfa8ecb79358a2c (candidate 4)

Frozen record. Separate from `8b3f76c`, `86b39ba`, `c88ccbe` and `19442d4` (each has its own report). Source tree clean at start; the files changed afterwards are this run's own outputs.

## Fingerprints
docker-compose.yml 55b265f7ec4a720e; nginx config 453644575c7ed58e. Images: workspace-signaling-engine ab9898ae40d3, qorlla-portal 80f6bf6bc5f3, meet 137b47c3d0a9, meet-sync-worker 34108d0b8c6e. Portal migrations 001-007; MAIN database also initialised with `meet-sync/sql/008_passcode_lockout.sql` (append-only security events).

## PASS (certification run: 12 checks passed, 0 failed)
* **Browser E2E through the nginx HTTPS origin: 44 passed, 0 failed, 0 flaky, 0 skipped** (the suite executed; this is not a zero-test run). Includes the guest flow over HTTPS, direct-URL and WebSocket bypass refusals, PostgreSQL-stored lock surviving a real MAIN container restart, the recovery allowance persisted across a restart (2 lifts, restart, new host session, 6 concurrent lifts -> 1 success, 5 refused, 3 recorded), the deployed application role append-only on security events (effective privileges, no inherited roles, real DELETE/UPDATE/TRUNCATE refused), the corrected `/login.html` compatibility test, the repaired notes-search test, pricing/checkout/webhook (TEST DOUBLE), portal auth and authorization, billing, documents/sheets/slides, phone (telephony OFF), navigation/mobile/tablet, Meet under /meet/, meeting-to-report (TEST DOUBLE).
* **Portal node:test suites: 168 / 168.**
* **PostgreSQL lockout suites in the run (U-LOCKOUT-PG): 13 / 13** - persistence, concurrency, attempt release, durable recovery, fail-closed, stress metrics, migration upgrade revoking DELETE/PUBLIC grants, an inherited group grant making the migration fail, the real application role denied DELETE/UPDATE/TRUNCATE/prune, owner-only audited retention that never touches `locked`/`cleared_by_host`.
* Stack checks D01-D09 and D07 restart resilience: PASS.
* Root Playwright suite against standalone MAIN (run before the stack, at the preceding code): 100 / 100 (lockout store tests, real-server restart/concurrency/audit, SMTP-sink reset-flow tests, wiring).

## PostgreSQL stress report (`cert/LOCKOUT_PG_STRESS.json`) - security and availability reported separately
90 concurrent attempts across three pool "instances": **comparisons 5 (budget 5): SECURITY PASS.** Outcomes: wrong 0, locked 8, busy 82, **unavailable 0 (rate 0%): AVAILABILITY PASS for this run.** Latency under this deliberate single-row burst: p95 1843 ms, p99 1943 ms, max pool wait 1540 ms. This is slower than the previous run (p95 971 ms, p99 1002 ms) on the same configuration; latency here depends on the host and is an operational observation, not a pass/fail criterion. It argues for sizing the pool and not treating the figures as a capacity statement (see NOT RUN).

## FAIL
None in this run.

## NOT RUN / not demonstrated
* Production-like load or capacity (the stress run is a correctness check on one hot row; latency varied about 2x between runs).
* Backup/restore for this SHA. Real mail delivery (SMTP-dependent flows were exercised only through the local SMTP sink in the root suite).
* Physical devices and real cameras/microphones.

## BLOCKED (no evidence; never inferred from test doubles)
Real AI model, Stripe test-mode transactions, Twilio calling, real SMTP delivery, physical-device certification, independent security review, production-like load testing, approved backup and recovery operations, real-provider billing and telephony activation.

## Findings status
Remediated and verified (tested scope above): durable passcode lockout (restart, multi-process, PostgreSQL); attempt accounting and release; 128-character cap; durable atomic three-per-hour host recovery keyed to host identity; audited rejected recovery; append-only security events for the application role; nginx routing of /guest and /auth; stale /login.html test; notes-search test race.
Open: no waiting room/host admission in MAIN; Meet and MAIN passcode policies intentionally separate (documented in docs/PASSCODE_POLICY.md); in-memory per-client brake and guest sessions are per process.

## Decision at this SHA
Functional and security regression for the tested scope: PASS. **Production release: FAIL/BLOCKED** until the BLOCKED and NOT RUN items above have real evidence. Nothing was pushed, merged, deployed, billed or telephony-enabled.
