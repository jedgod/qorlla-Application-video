# Full-stack certification - exact SHA 19442d484aed9ab0d0c17538838416763c239049 (candidate 3)

Frozen record. Separate from `8b3f76c` (baseline), `86b39ba` (browser E2E not executed) and `c88ccbe` (41/2). Source tree clean at start.

## Fingerprints
docker-compose.yml 55b265f7ec4a720e; nginx config 453644575c7ed58e (changed: adds /guest, /guest.js, /auth/ routes to MAIN). Images: workspace-signaling-engine d28cca50baed, qorlla-portal 6f50e7cdc15a, meet cf08cc852f2a, meet-sync-worker b2db6a86be21.

## PASS
* Root Playwright suite (standalone MAIN, before this run): 100 / 100. PostgreSQL lockout + permission suites (local, 13): 13 / 13.
* Portal node:test suites: 168 / 168. Stack checks D01-D09 and D07 restart resilience: PASS.
* **PostgreSQL lockout adapter inside the certification run (U-LOCKOUT-PG): 8 / 8**, with stress metrics (`cert/LOCKOUT_PG_STRESS.json`): 90 concurrent attempts across three pool "instances": **5 comparisons (budget 5 - security held)**; outcomes wrong 0, locked 6, busy 84, **unavailable 0**; p95 971.5 ms, p99 1001.7 ms, max pool wait 830.7 ms (visible latency under a deliberate burst on one hot row).
* **Browser E2E through the nginx HTTPS origin: 43 passed, 1 failed (44 run).** Newly passing at this SHA, all through HTTPS and the containerised MAIN + PostgreSQL:
  * Welcome -> Join -> Pre-Join -> meeting; guest cookie Secure, HttpOnly, SameSite=Strict (the nginx routing defect from `c88ccbe` is fixed).
  * Direct-URL and WebSocket bypass attempts refused (no session, wrong-meeting session, passcode field on the socket); REST requires the passcode.
  * Five failures lock the meeting; lock rows and `locked` event in PostgreSQL; **the lock survives a real MAIN container restart**; a correct passcode is refused after it; the host lifts it; the passcode is untouched.
  * **Recovery allowance persisted across a MAIN restart**: two lifts, restart, a NEW host session, six concurrent lifts -> exactly one succeeded, five 429; exactly 3 `cleared_by_host` rows; further requests 429 with Retry-After; minting another host session did not help; rejected requests audited (`rate_limited`).
  * **Deployed application role is append-only on security events**: effective `DELETE/UPDATE/TRUNCATE/REFERENCES/TRIGGER` all false, `SELECT/INSERT` true, no inherited role memberships, no EXECUTE on the retention function, and actual DELETE/UPDATE/TRUNCATE as `qorlla_app` were refused with "permission denied".
  * The corrected `/login.html` compatibility test, pricing/checkout/webhook (test double), portal auth, billing, documents/sheets/slides, phone (telephony OFF), navigation/mobile/tablet, Meet under /meet/, meeting-to-report (test double) all PASS.

## FAIL (1)
* `workspace.spec.js:12` "notes are private by default, searchable ...": **test race, not a product or lockout defect.** After the first search the test waits for text that is already on screen before the filter applies, then types into an input node that the page re-renders away, so the second search never fires. Present in the test since before v4.6; it passed in earlier runs by timing luck. Unrelated to guest/lockout code. To be corrected in the next commit (wait for the search response) and re-run.

## NOT RUN / gaps
* The permission tests for the migration upgrade and an INHERITED group grant (`lockout-pg-security.test.mjs`, 5 tests) ran locally (13/13 with the stress suite) but are not yet part of the certification runner; the deployed-role checks above do run in the stack. To be added.
* Backup/restore and production-like load for this SHA. SMTP-dependent flows were tested only with the local SMTP sink (root suite), never a real provider.

## BLOCKED (no evidence; never inferred from test doubles)
Real AI model, Stripe test-mode transactions, Twilio calling, real SMTP delivery, physical devices, independent security review, production-like load, approved backup/recovery operations.

## Decision at this SHA
Lockout, recovery-allowance persistence and audit append-only findings: remediated and verified through the HTTPS stack. Full-stack: 1 failing (flaky, unrelated) test. Production: FAIL/BLOCKED.
