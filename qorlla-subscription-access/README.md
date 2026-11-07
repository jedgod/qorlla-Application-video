# Qorlla Subscription Access v2.1

Subscription enforcement for Qorlla Workspace: plan entitlements, strict lifecycle, atomic metered quotas, privileged
overrides and a provider-neutral billing inbox/outbox, on PostgreSQL, with least-privilege database roles.

**Status: hardened and verified in the lab. NOT production certified.** Read [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md)
for exactly what is proven, how, and what still blocks a live paid launch. `billing_live` stays `false`.

## What it guarantees

| Area | Guarantee |
|------|-----------|
| Identity | The customer id is a UUID from authenticated context (`req.auth`, `req.actor`, `req.user`). Body, query, params and headers are never consulted. Anything else is refused before the database is touched. |
| Lifecycle | trial / active / past_due (grace) / paused / canceled / incomplete / expired, evaluated with the **database clock**. Every deadline is exclusive. Unknown states, unknown plans and invalid dates fail closed. A lapsed customer falls back to the free Basic plan, never to a paid one, and keeps no paid overrides. |
| Capacity | `meetings.participants`, `storage.cloud_gb`, ... are snapshot comparisons against the limit. |
| Consumption | `reserve()` holds quota atomically (per-customer-and-feature advisory lock, decision made inside the transaction); `commit` records usage once; `release` frees it. Usage is counted by when the operation started, in UTC windows. |
| Races | Every write to `subscriptions` / `entitlement_overrides` takes an exclusive per-customer lock in a **database trigger**; a reservation holds the shared lock. A downgrade, an override change, even a manual `psql` edit cannot interleave with a reservation's check-and-write. |
| Idempotency | Checked **before** any denial and in **every** reservation state: a retry after commit replays, it does not consume twice. Same key + different quantity is a 409. |
| Long jobs | Reservations can be renewed (bounded by a maximum lifetime). A **late commit still records the usage** that happened and raises a security event. A sweeper expires abandoned reservations. |
| Failure | Any database, lock, audit or gate failure is **denied** (`503 access_unavailable`), with no internal detail. Lock waits are bounded. A connection killed mid-request is destroyed, not pooled, and cannot crash the process. |
| Entitlement is not capability | `phone.pstn` is entitled on Business+ but stays closed behind an operational gate (default **off**) that operations must open explicitly. |
| Audit | `access_audit`, `security_events`, `usage_events`, `entitlement_override_history` are append-only: UPDATE, DELETE and TRUNCATE are refused by trigger for **every** role including the owner. A failed audit write fails the request (and rolls back a reservation) by default. |
| Overrides | Only `AdminService`, which needs a billing-admin role, MFA verified in the last 15 minutes, a tenant-scope `authorize` callback, a reason, bounded values and an expiry. Every change is recorded with old and new value and actor. |
| Billing | Signature over the exact raw bytes, replay window, key rotation, idempotent inbox, **revision ordering**, administrator-created customer links only, cross-tenant subscription-id collision detection, durable outbox, reconciliation. No payment collection. |

## Database roles

Run migrations as the **migrator** (table owner). The application connects as one of three non-owner roles:

| Group role | Used by | Can | Cannot |
|---|---|---|---|
| `qorlla_sub_runtime` | request path | read plans/subscriptions/overrides; reserve, commit, release quota; write audit and usage | change subscriptions or overrides, delete anything, DDL |
| `qorlla_sub_billing` | webhook worker | subscriptions, inbox, outbox | overrides, usage, reservations, customer links, audit |
| `qorlla_sub_admin` | billing-admin / provisioning service | overrides, override history, customer links, customers, members | subscriptions, reservations, usage, inbox, platform staff |

```sql
GRANT qorlla_sub_runtime TO app_request_login;   -- one LOGIN role per service
GRANT qorlla_sub_billing TO app_webhook_login;
GRANT qorlla_sub_admin   TO app_admin_login;
```

## Quick start

```bash
# as the migrator
DATABASE_URL=postgres://migrator:...@db/qorlla node scripts/migrate.mjs      # 001-004, checksummed, transactional
DATABASE_URL=postgres://migrator:...@db/qorlla node examples/seed-entitlements.js   # seeds and verifies catalog == src/plans.js
```

```js
import { createSubscriptionAccess, AdminService, BillingProcessor, createSignedJsonAdapter } from '@qorlla/subscription-access';

// request path  (login role granted qorlla_sub_runtime)
const { service, middleware } = createSubscriptionAccess({
  connectionString: process.env.RUNTIME_DATABASE_URL,
  operationalGates: { 'phone.pstn': false },        // entitlement is not capability
});
service.startSweeper();

app.post('/api/meetings', auth /* sets req.auth.customer_id from a VERIFIED session */,
  middleware.requireFeature('meetings.participants', { quantity: (req) => req.body.max_participants }), handler);

// metered work: reserve -> work -> commit (release on failure); the key is generated by YOUR server, never trusted from a client alone
const r = await middleware.reserve(req, 'ai.meeting_summaries', 1, { idempotencyKey: `${userId}:${req.get('idempotency-key')}` });
if (!r.allowed) return res.status(r.reason === 'subscription_inactive' ? 402 : 403).json(r);
try { /* ... work (service.renewReservation for long jobs) ... */ await middleware.commitReservation(req, r.reservationId); }
catch (e) { await middleware.releaseReservation(req, r.reservationId); throw e; }
```

[`examples/express-integration.js`](examples/express-integration.js) is a complete, tested wiring (auth hook with **no insecure default**,
capacity checks, metered route, PSTN gate, entitlements endpoint, webhook route with raw-body handling, service-to-service refresh).

## Integration contract (what YOUR code must do)

1. Verify the session upstream (JWT signature, issuer, audience, expiry, live session, organization membership) and only then set
   `req.auth.customer_id`. This package trusts that value completely.
2. Webhook route: mount `express.raw()` **before** any JSON parser and pass the untouched `Buffer` to `BillingProcessor.ingest`.
3. Administrators: pass the verified admin session as `actor` (`{ id, roles, mfaVerifiedAt }`) and supply `authorize(actor, action, customerId)`
   for organization/tenant scope. `AdminService` refuses to start without it.
4. Multi-instance: leave `cacheEnabled` off (it is refused in production unless `singleInstance: true`). Run `service.startSweeper()` on every instance; it is safe concurrently.
5. Operations: alert on `security_events` of severity `critical` (see PRODUCTION_READINESS.md for the queries).
6. PSTN / public numbers need **both** the `phone.pstn` entitlement and operations opening the gate. A paid plan never overrides it.

## Wiring into the product

[INTEGRATION.md](INTEGRATION.md) specifies how the main app (verified tenant from the live session), the directory (customers, roles, suspension, staff) and Meet
(`createMeetGuard`) connect. Those modules are built and tested; **they are not yet mounted in the product**.

## Layout

```
src/        accessService (request path)  lifecycle (pure)  decision (pure)  plans  middleware  db (transactions)
            admin (overrides)  billing + billingAdapters (inbox/outbox)  directory (customers/roles)  identity (session -> tenant)
            staff (platform staff)  meetGuard (Meet enforcement)  migrate  seed  errors  cache  index
schema/     001 base  002 hardening (constraints, immutability, lock triggers)  003 billing  004 roles and grants  005 directory
scripts/    migrate.mjs  rehearse-backup-restore.mjs
examples/   express-integration.js  seed-entitlements.js
tests/      43 unit tests (no database) + 141 PostgreSQL tests
```

## Tests

```bash
npm run test:unit                                  # no database needed
SUBACC_TEST_ADMIN_URL=postgres://postgres:...@127.0.0.1:5432/postgres npm test     # a DISPOSABLE server; each file creates and drops its own database
```

The database tests connect as the real least-privilege roles. Without `SUBACC_TEST_ADMIN_URL` they skip and say why.

Internal - Qorlla Workspace.
