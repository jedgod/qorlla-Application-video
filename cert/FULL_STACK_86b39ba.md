# Full-stack certification - exact SHA 86b39ba518c255ede6d01549119b9d769b550c5b (first durable-lockout patch)

Frozen record. Separate from the baseline `8b3f76c` (report `cert/FULL_STACK_8b3f76c.md`, evidence commit `2de7720`).
Source tree clean at start. The run's own outputs are committed afterwards as an evidence commit.

## Fingerprints
docker-compose.yml sha256 (first 16): 55b265f7ec4a720e (adds the `008_passcode_lockout.sql` init mount). Images: workspace-signaling-engine a2bac9f8e3ec, qorlla-portal c6689599f5aa, meet 9e02af0e42c6, meet-sync-worker 42a6d12ac196. Portal migrations 001-007 unchanged; MAIN database also initialised with `meet-sync/sql/008_passcode_lockout.sql`.

## PASS
* Root Playwright suite (standalone MAIN, run before this stack run): 87 / 87.
* PostgreSQL lockout adapter against a real database: 5 / 5. File-store, real-server restart and six-process concurrency tests: part of the 87.
* Portal node:test suites: 168 / 168.
* Stack checks D01-D09 (compose valid, all services healthy including with the new migration, single HTTPS entry, unprivileged containers and clean logs, least-privilege roles, fail-closed portal, restart resilience, admin console/metrics not public).

## FAIL
* **Browser E2E did not execute: "0 passed, 0 failed".** Cause is a defect in this commit's own test code: the corrected `/login.html` test in `qorlla-portal/e2e/navigation.spec.js` contained mangled regular expressions (`//qorlla.html/`, `/login.html?standalone=1/`) that Playwright could not parse, which aborts the whole portal E2E run. Not a product defect. Fixed in the follow-up commit.

## NOT RUN at this SHA (because of the above)
* Everything in the portal E2E: pricing, checkout/webhook, portal auth, navigation, Meet under /meet/, meeting-to-report, and the new `guest-meeting.spec.js` (guest/passcode/lockout through the nginx HTTPS origin, PostgreSQL-stored lock, lock surviving a MAIN container restart, role privileges).
* SMTP-dependent password reset tests.

## BLOCKED
Real AI model, Stripe, Twilio, SMTP delivery, physical devices, independent security review, production-like load, approved backup/recovery operations.

## Decision at this SHA
Durable-lockout finding: remediated and tested at unit/integration level against real PostgreSQL and real server processes; NOT yet shown through the HTTPS stack. Production: FAIL/BLOCKED.
