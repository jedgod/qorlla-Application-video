# Qorlla Subscription Access - Production Readiness

## Status: HARDENED AND LAB-VERIFIED. NOT PRODUCTION CERTIFIED.

`billing_live=false`. No deployment, no production merge, no live payment collection, no PSTN. This document separates what is
**proven here, with the evidence**, from what **still blocks** a live paid launch. Nothing below is an independent audit or a staging sign-off.

## Evidence summary (2026-11-06, PostgreSQL 16.15, Node 22)

| Evidence | Result |
|---|---|
| Full suite, no database | 43 / 43 pass; the database suites skip with a stated reason |
| Full suite, real PostgreSQL, least-privilege roles | **148 / 148**, run twice in a row (280 s and 247 s) under a heavily loaded host (Docker VM load average 12-16) |
| Concurrency | 60 racing reservations from 4 independent pools for a limit of 3 -> exactly 3; 100 reserve/commit/release cycles against a limit of 25 -> never over; **4 separate OS processes x 25 attempts** against a limit of 10 -> exactly 10; 30 simultaneous HTTP requests for a limit of 3 -> exactly 3 |
| Writer/reader race | A plan change waits for an in-flight reservation and a reservation waits for a pending plan change (also for overrides and for manual SQL, via database triggers) |
| Failover (simulated) | A backend killed mid-reservation -> 503, no partial row, same retry succeeds on a fresh connection, process does not crash; a stuck lock holder -> fail closed within the lock timeout, then recovery |
| Mutation check | 16 deliberate regressions (remove a lock, skip idempotency, unscope a tenant check, open the PSTN gate, grant UPDATE to the runtime role, make audit tables mutable, ...). First pass caught 12; the 4 survivors exposed 2 real test gaps (an exclusive-deadline boundary, the catch-all 503 path) and 1 redundant-layer case. All fixed; **16 / 16 now caught**. |
| Backup / restore rehearsal | `scripts/rehearse-backup-restore.mjs`: populated through the real services, `pg_dump -Fc`, `pg_restore` into a new database: every table identical (row counts and content hashes), append-only triggers, check constraints, lock triggers, migration checksums and role grants intact, and the application works on the restored copy as the least-privilege role, including replaying an old idempotency key |
| Migrations | Idempotent; checksum drift refused; a failing migration rolls back completely; 4 parallel runners apply each file exactly once; non-conforming file names are never executed |

Reproduce: `SUBACC_TEST_ADMIN_URL=<disposable superuser url> npm test`, `npm run rehearse:backup`.

## Original blockers: status

| # | Blocker (from the previous review) | Status | How it is addressed / proven |
|---|---|---|---|
| 1 | Real PostgreSQL migration and constraint validation | **Done (lab)** | `schema.pg.test.js`: every constraint exercised, migrations rehearsed, rollback proven. Found and fixed a showstopper the old code hid: both consumption queries bound 4 parameters to 3 placeholders, so **every metered call would have thrown** |
| 2 | Least-privilege database roles | **Done (lab)** | Schema 004: three group roles, no PUBLIC access, owner-only DDL. `role matrix` tests run 33 forbidden statements as `runtime`, 16 as `billing`, 15 as `admin` (each must fail with permission denied) and 32 permitted ones that must work, plus "no membership = no access" |
| 3 | Webhook signatures over the exact raw body, replay rejection | **Done** | `billingAdapters.js`: HMAC over `timestamp.rawBytes`, constant-time, tolerance window, key rotation; re-serialised or tampered bodies refused; `express.raw()` in the example. A replay with different content is flagged **critical** |
| 4 | Monotonic provider revisions, idempotent transactional inbox, async reconciliation | **Done** | `billing.js`: inbox keyed by (provider, event id); per-customer lock; only a strictly higher revision applies; 20 parallel duplicates -> 1 applied; 12 revisions in random parallel order -> the highest wins; `reconcile()` applies the provider's authoritative state and reports drift |
| 5 | Provider-neutral adapter and durable outbox (no live payment) | **Done (neutral); provider-specific pending** | Neutral event shape + a reference signed-JSON adapter. Outbox written in the same transaction, drained at-least-once with `SKIP LOCKED` (concurrent drainers publish each row once; failures stay queued with their error). **A real provider needs its own adapter and a sandbox run** |
| 6 | Reservation lifecycle: idempotency before denial, retry after commit, long jobs, expiry reconciliation, unique index | **Done** | Idempotency checked first and unique across **all** states; commit replay; `renewReservation` (bounded); **late commit still records usage** + security event; sweeper with `SKIP LOCKED`. The old index only covered `status='reserved'`, which allowed double-spend on retry after commit |
| 7 | No access-check/write race with downgrades or override changes | **Done** | Shared per-customer advisory lock in the reservation; exclusive lock in a trigger on every write to `subscriptions` and `entitlement_overrides`. Test hold-and-release in both directions. (`FOR SHARE` was rejected: it needs UPDATE privilege, which would have defeated least privilege) |
| 8 | UTC period boundaries; billing window contains the operation | **Done** | `lifecycle.js`: UTC day/month, leap year, year end; billing window used only if entitled and it contains "now", otherwise the UTC month; a period that has not started is denied beyond a 5 minute skew. All clocks are the database clock |
| 9 | Decide and test the missing-subscription policy; paused/unknown cannot keep paid overrides | **Done** | Decision: no row = free **Basic** (`missingSubscription:'basic'`, default) or nothing at all (`'deny'`). Lapsed/paused/unknown never get paid overrides (two independent layers; the mutation check proved both are needed to be bypassed) |
| 10 | Organization ownership, admin authorization for overrides, MFA, immutable audit, cross-tenant tests | **Done in this package; the org check is YOUR callback** | `AdminService` refuses to exist without `authorize(actor, action, customerId)`; role + MFA freshness (15 min) + reason + bounds + expiry (permanent opt-in); history records old/new/actor; audit tables append-only for every role. Cross-tenant: reservations (3 attacks recorded), overrides, links, webhook subscription-id collision (critical). The package cannot know your organizations: **you** implement `authorize` |
| 11 | Multi-instance concurrency, DB failover, payment retry, browser E2E, alerts, backups/restore | **Partly done** | Done in the lab: multi-instance and multi-process concurrency, simulated connection loss, lock timeout, provider retry semantics (failed -> 503 -> attempts -> dead), backup/restore. **Not done:** real replica failover, load beyond the stress tests, browser E2E, alerting wired to a pager (queries below) |
| 12 | Integrate and certify Meet, Clips, AI, storage, internal calling, admin billing UI; gates OFF | **Not done** | Nothing in the product calls this package yet. `examples/express-integration.js` is a tested template. PSTN gate is **off by default** and tested |

## Also found and fixed while hardening

- `getConsumed` / `_getConsumedTx` bound four parameters to a three-placeholder query: all metered paths threw.
- An uncaught `error` event from a connection killed while checked out would have **crashed the process**; every transaction now goes through `withTx`, which listens, destroys the client and rolls back.
- The example trusted an `x-customer-id` header and exposed an unauthenticated cache-refresh route; it contradicted its own contract. It now has no default authentication and a token-guarded internal route.
- A replayed example request would have released the original request's reservation.
- `missingSubscription:'deny'` initially still gave Basic's free features; fixed and tested.
- Local-time (not UTC) usage windows; lifecycle used the server clock while reservations used the database clock.

## Residual risks and decisions you must make

1. **Real provider adapter + sandbox run** (signatures, event shapes, revision semantics of the actual provider). Until then the webhook path is proven only against the neutral adapter.
2. **Real HA failover** (replica promotion, connection storms). Only connection loss and lock timeouts are simulated.
3. **Scale.** Reservations for one customer+feature are serialised on purpose. 100 racing requests for one customer complete within the 30 s test budget on a loaded host; the production default `lockTimeoutMs` is 5 s, so a *burst deeper than about that* would fail closed (503) rather than queue. Tune with data from staging.
4. **Audit growth.** `access_audit` logs every decision (`audit:'denied'` logs only denials). The tables are append-only by design: plan partitioning and archival (detach the partition in a controlled window) before volume matters.
5. **Alerting is not wired.** Suggested queries (run every minute, page on any row):
   ```sql
   SELECT event_type, count(*) FROM security_events WHERE severity='critical' AND occurred_at > now() - interval '5 minutes' GROUP BY 1;
   SELECT count(*) FROM billing_inbox WHERE status IN ('failed','dead') AND received_at > now() - interval '1 hour';
   SELECT count(*) FROM billing_outbox WHERE published_at IS NULL AND created_at < now() - interval '10 minutes';
   SELECT count(*) FROM quota_reservations WHERE status='reserved' AND expires_at < now() - interval '10 minutes';  -- sweeper not running
   ```
6. **Rollback.** Migrations are forward-only. Rollback = restore the pre-migration backup (rehearsed above); rehearse it in staging before each release.
7. **Seat quantity** (`subscriptions.quantity`) is stored but not enforced anywhere.
8. **MFA freshness is asserted by the caller** (`actor.mfaVerifiedAt`); the package enforces the age, not the proof.
9. **Cache.** In-process caching stays off; it cannot be invalidated across instances (refused in production without `singleInstance:true`).
10. **Org membership, JWT verification and session liveness** are upstream responsibilities (see README, integration contract).

## Release gate

GO only when: a real provider adapter has passed its sandbox; staging shows multi-host behaviour including failover and a load test sized to real traffic;
alerts are wired and have fired in a drill; the product's Meet / Clips / AI / storage / calling / admin UI are integrated and certified; browser E2E passes;
an independent reviewer has signed the tests against the committed SHA; and rollback has been rehearsed in staging.
Until then: `billing_live=false`, no deployment, no production merge, PSTN and provider gates OFF.
