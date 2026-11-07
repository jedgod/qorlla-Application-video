# Qorlla Subscription Access - Production Readiness

## Status: HARDENED AND LAB-VERIFIED. NOT PRODUCTION CERTIFIED.

`billing_live=false`. No deployment, no production merge, no live payment collection, no PSTN. This document separates what is
**proven here, with the evidence**, from what **still blocks** a live paid launch. Nothing below is an independent audit or a staging sign-off.

## Evidence summary (2026-11-06, PostgreSQL 16.15, Node 22)

| Evidence | Result |
|---|---|
| Full suite, no database | 51 / 51 pass; the database suites skip with a stated reason |
| Identity / directory / Meet guard (added 2026-11-06) | 36 new tests: real `auth.js` over HTTP with real cookies (sign-up, logout, expiry), role changes, removal, suspension, cross-tenant, staff scope, Meet join/bridge/feature gates. **20 additional mutations, 20 / 20 caught** |
| Full suite, real PostgreSQL, least-privilege roles | **217 / 217**, run twice in a row on the FINAL tree (370 s and 393 s) under a heavily loaded host (Docker VM load average 13-14), after the three P0 corrections below and a fourth defect found by final verification (pool crash, below). Earlier baselines: 184 / 184, 148 / 148 |
| Concurrency | 60 racing reservations from 4 independent pools for a limit of 3 -> exactly 3; 100 reserve/commit/release cycles against a limit of 25 -> never over; **4 separate OS processes x 25 attempts** against a limit of 10 -> exactly 10; 30 simultaneous HTTP requests for a limit of 3 -> exactly 3 |
| Writer/reader race | A plan change waits for an in-flight reservation and a reservation waits for a pending plan change (also for overrides and for manual SQL, via database triggers) |
| Failover (simulated) | A backend killed mid-reservation -> 503, no partial row, same retry succeeds on a fresh connection, process does not crash; a stuck lock holder -> fail closed within the lock timeout, then recovery |
| Mutation check | 36 deliberate regressions in total (16 engine + 20 identity/directory/Meet guard); all caught. Engine set: 16 deliberate regressions (remove a lock, skip idempotency, unscope a tenant check, open the PSTN gate, grant UPDATE to the runtime role, make audit tables mutable, ...). First pass caught 12; the 4 survivors exposed 2 real test gaps (an exclusive-deadline boundary, the catch-all 503 path) and 1 redundant-layer case. All fixed; **16 / 16 now caught**. The identity set was caught 20 / 20 on the first pass. |
| Backup / restore rehearsal | `scripts/rehearse-backup-restore.mjs`: populated through the real services, `pg_dump -Fc`, `pg_restore` into a new database: every table identical (row counts and content hashes), append-only triggers, check constraints, lock triggers, migration checksums and role grants intact, and the application works on the restored copy as the least-privilege role, including replaying an old idempotency key |
| P0 corrections (this run) | Replay protocol, strict quantities, schema isolation: 27 new tests (8 + 11 + 8), plus 6 for the pool-crash fix, plus updated expectations in the existing suites (see the section below). Mutation check on them: 27 distinct mutations, all caught; 2 further candidates were no-ops by construction and were replaced (documented below) |
| Migration rollback | A failing migration rolls back completely (tested); **a successful migration is rolled back by restoring the pre-release backup** (rehearsed: data identical, version record and new tables gone, release re-applies cleanly); uninstall = `DROP SCHEMA subscription_access CASCADE` (tested: unrelated objects unchanged, reinstall clean) |
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
| 10 | Organization ownership, admin authorization for overrides, MFA, immutable audit, cross-tenant tests | **Mostly done; MFA is NOT** | `AdminService` refuses to exist without `authorize(actor, action, customerId)`; role + MFA freshness (15 min) + reason + bounds + expiry (permanent opt-in); history records old/new/actor; audit tables append-only for every role. Cross-tenant: reservations (3 attacks recorded), overrides, links, webhook subscription-id collision (critical). **Organizations now exist** (`005_directory.sql`: customers, members with owner/admin/member, suspension, last-owner rule enforced by trigger, append-only history) and sessions resolve to a verified tenant live on every request (`identity.js`; revoked and expired sessions, role changes, removals and suspension all tested against the real `auth.js`). Staff authorization reads `platform_staff` live. **MFA does not exist in the main app**: privileged billing actions are refused (fail closed) until a real step-up provider is connected (see INTEGRATION.md) |
| 11 | Multi-instance concurrency, DB failover, payment retry, browser E2E, alerts, backups/restore | **Partly done** | Done in the lab: multi-instance and multi-process concurrency, simulated connection loss, lock timeout, provider retry semantics (failed -> 503 -> attempts -> dead), backup/restore. **Not done:** real replica failover, load beyond the stress tests, browser E2E, alerting wired to a pager (queries below) |
| 12 | Integrate and certify Meet, Clips, AI, storage, internal calling, admin billing UI; gates OFF | **Building blocks done; product wiring NOT applied** | Meet guard (bridge create, join cap, per-feature gates) is built and tested against a stub that mirrors Meet's real routes; **it is not mounted in Meet, and the main app does not yet use `identity`** (wiring is specified in INTEGRATION.md, deliberately not applied to `auth.js` / `workplace.js` / Meet, which carry other uncommitted work). Clips, AI, storage and the admin UI are not integrated. PSTN gate is **off by default** and tested |

## Final remediation (P0), 2026-11-06

| P0 | Defect (confirmed in the code first) | Correction | Proof |
|---|---|---|---|
| Concurrent reservation replay | The example answered `200 ok` to ANY repeat of a key, including one whose original was still running or had failed; and an unlimited plan left no record at all, so a retry ran the protected work twice | Replay protocol: finished -> the **stored response** (`Idempotent-Replay: true`); original running -> `409 request_in_progress` + `Retry-After`; original failed or abandoned -> `409 previous_attempt_failed` (use a new key). Unlimited plans are now recorded. The quota is released *before* a failure is reported; if the work finished but the commit cannot be recorded the hold is **kept** (no free ride) and the commit is retried. State lives in PostgreSQL, so it holds across restarts and instances | `tests/replay.pg.test.js` (11): 24 simultaneous requests with one key over 3 independent app instances -> the work ran **once**, one original success, every other answer "in progress" or the identical stored result; retry while running; failed original; restart (new process, new pools); a process that died after reserving; unlimited plans; replays never consume quota; per-user keys; lost commit; transient commit error |
| Participant counts | `Number(x) \|\| 1` turned malformed counts into 1 (and a missing duration into 30) | One strict validator for the service, middleware, Meet guard and example: only whole numbers 1..ceiling; text (even `"5"`), fractions, 0, negatives, NaN, Infinity (including `1e999` from JSON), booleans, arrays and objects are rejected; missing is `quantity_required`; above the ceiling is `quantity_too_large` (default 1,000,000, configurable). Validated **before** any entitlement or quota check; `req.validated` carries the exact number the handler must use | `tests/validate.test.js` (8) + HTTP and service tests; the quantity consumed equals the quantity validated |
| Database privileges | Migration 004 ran `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC`, silently changing permissions on every unrelated application table | Everything now lives in the dedicated schema `subscription_access`; every revoke and grant is scoped to it; trigger functions pin their own `search_path`; connections are verified (a mis-configured pool fails closed with a clear message, and a pool you pass in is never modified); the only cluster-level objects are the three `qorlla_sub_*` roles | `tests/isolation.pg.test.js` (8): a database already containing unrelated tables, views, sequences, functions, a second schema, default privileges, column grants, roles with logins and memberships; a snapshot of every ACL and role attribute outside our schema is **identical** before and after migrating, re-migrating, uninstalling and reinstalling; a control proves the snapshot would catch the old statement |

Mutation notes: of 22 mutations on these fixes, 20 were caught immediately. One survivor was an *equivalent mutant* (removing `Number.isFinite` while `Number.isInteger` rejects the same values; caught as soon as both are removed). One was a *no-op by construction* (revoking a default privilege PUBLIC never had); it was replaced by a real change and caught, as were two more migration mutations.

### Found by the final verification run

While repeating the backup/restore rehearsal, one run in three died with an unhandled `error` event. Cause: a pool the package creates for itself had **no `error` listener** (only `AccessService` attached one). When PostgreSQL drops an idle connection, which is exactly what a restart or failover does, pg emits `error` on the pool, and with no listener Node treats it as an uncaught exception: **the whole process exits.** Fix: every owned pool is created through one function that always attaches a listener (it logs, then the pool discards the dead client and reconnects). Proof: `tests/pool.pg.test.js` (6, one per service that owns a pool) kills the idle connection from outside and requires no uncaught exception, a log line, and a working next call; removing the listener, or making it silent, fails all six. Rehearsal after the fix: 5 of 5 consecutive passes.

Process note: my own scripted edits had converted 20 committed files to CRLF on Windows. They are normalised back to LF in a separate, content-neutral commit (an `--ignore-space-at-eol` diff between the trees is empty), so the substantive commit is readable.

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
10. **Provisioning** (who creates a customer, when) is a product decision; until a user belongs to a customer they get `403 no_customer`. Customer and membership writes need `qorlla_sub_admin`, so run them in a separate internal service, not in the web tier (INTEGRATION.md).
11. **No MFA in the main app.** Overrides, customer links and suspension stay impossible until a step-up provider exists.
12. **Search path.** Services use unqualified names in the `subscription_access` schema, so every pool must set `options=-c search_path=subscription_access,pg_catalog` (pools the package creates do; a pool you pass in is checked, never changed). Operators who reach the tables by hand should qualify names.
13. **Meet participant cap is a snapshot**, Meet does not enforce meeting duration while running, and anonymous meetings get the free-plan limits rather than being blocked (all configurable / documented).

## Release gate

GO only when: a real provider adapter has passed its sandbox; staging shows multi-host behaviour including failover and a load test sized to real traffic;
alerts are wired and have fired in a drill; the product's Meet / Clips / AI / storage / calling / admin UI are integrated and certified; browser E2E passes;
an independent reviewer has signed the tests against the committed SHA; and rollback has been rehearsed in staging.
Until then: `billing_live=false`, no deployment, no production merge, PSTN and provider gates OFF.

## Integration phase (branch feature/qorlla-subscription-integration) - verdict: still NO-GO

Verified locally against real PostgreSQL 16, a real Meet server child process, real Chromium (virtual WebAuthn authenticator) and a Docker primary/standby pair.

| Suite | Result |
|---|---|
| Package (PostgreSQL + Chromium E2E), 2 consecutive runs | 292/292 and 292/292 |
| Package, no database | 62/62 (DB tests skip) |
| Meet real-server enforcement | 24/24 |
| Docker failover (opt-in `SUBACC_FAILOVER=1`) | 3/3; 208 acknowledged operations all present after promotion; no leftover resources |
| Backup/restore + rollback rehearsal | passed (covers migrations 005-007) |

What exists: WebAuthn step-up (TOTP optional), internal admin service with signed assertions and durable audit (`qorlla_sub_admin` is out of the web process), CSRF for the admin proxy, Meet atomic admission and server-side duration enforcement behind `SUBSCRIPTION_ENFORCEMENT=off|log|enforce` (default off), durable alert outbox with retry/ack.

Design note: a Meet host is never locked out of their own meeting, so the cap applies to guests; a late-reconnecting host can make the meeting hold limit + host.

Still blocking production:
- Payment providers selected (Stripe Billing + RevenueCat) and adapters built, but certified against simulated payloads only; no live sandbox run. billing_live stays false. See the unified billing section below.
- Main app (`auth.js`, `workplace.js`) not wired: customerId to Meet bridge, identity middleware, admin proxy routes, CSRF, logout hook. Committed `auth.js` has no CSRF.
- Meet has no recording/webinar/breakout implementation to gate; its lockfile is stale; a duplicate Meet copy exists untouched.
- No real HA orchestration/fencing; alert paging destinations not configured.
- No product-level browser E2E, no independent security review.

## Unified billing: Stripe Billing + RevenueCat (decision 2026-11-06) - verdict: still NO-GO

**Built** (baseline `7a9ef85`): Stripe and RevenueCat adapters, `BillingGateway` (checkout, one-open-intent, summary, management destination), `webhookRouter` / `customerRouter`,
migration `008_unified_billing.sql` (customer kind, checkout intents, purchase identities, audited link function), cross-provider duplicate / account-hopping / identity-mismatch defences,
personal-vs-organization separation enforced in the database and the processor.

**Verified locally** (PostgreSQL 16, real sockets; payloads in the providers' *documented* shapes, signed/authorized as the providers do it):

| Check | Result |
|---|---|
| Full package suite incl. Chromium E2E | 358/358 (0 failed, 0 cancelled, 0 skipped) |
| Package without a database | 95/95 (database tests skip) |
| Backup/restore + rollback rehearsal (migrations 005-008) | passed |
| Mutation check of the new rules (29 in-place mutations) | 28 caught; 1 equivalent mutant (the explicit Stripe-mirror ignore is redundant with the unrecognised-store rule - behaviour identical); sources restored byte-for-byte |

Covered: Stripe lifecycle (create, payment failure and grace, recovery, cancel at period end, upgrade/downgrade, deletion, refund record), RevenueCat lifecycle (purchase, renewal, unsubscribe,
billing issue, refund/support cancellation, expiry, pause), webhook replay and out-of-order delivery, missed-event reconciliation, same-second ties, double checkout from two devices,
live-subscription blocking from any channel, channel switch after the first ended, store purchases refused for organizations, one personal account per user, intent expiry, provider outage,
raw-body handling (a JSON parser mounted first is refused), status-code semantics for provider retries, least-privilege grants for every new object.

Found and fixed while building: a store purchase could be linked to an organization by an administrator's mistake (now parked + alerted); `summary()` returned 500 for a malformed customer id (now 400);
`customers.kind` and personal membership were not protected by the database (now triggers + unique index); existing directory test asserted billing could not read `customers` (now: read-only, for live authorization).

**NOT proven - blocks any live billing:**
1. No call has been made to Stripe, Apple, Google or RevenueCat. Required: Stripe test-mode (Checkout, portal, retries, refunds, disputes), RevenueCat sandbox, Apple StoreKit sandbox, Google Play test purchases, webhook replay from the real providers.
2. Android / iOS client integration (`Purchases.logIn(customerId)`, purchase, restore) is not built or tested.
3. Apple / Google store-policy review for each storefront (multiplatform recognition, external purchase rules).
4. RevenueCat's own Stripe integration does not support every tiered/usage pricing model: keep enterprise and metered billing in Stripe directly (the Stripe adapter rejects multi-item subscriptions).
5. Wiring into the main app (`auth.js`, `workplace.js`), Clips Studio, AI, storage and the administration UI; the unified subscription page UI (only its data endpoint exists).
6. Product-level browser E2E and independent security review. `billing_live` stays `false`.
