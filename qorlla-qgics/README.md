# Qorlla Global Identity & Calling System (QGICS) v1.0

Standalone **integration foundation**, not a production-certified replacement for Qorlla Portal, Shield, Voice, or Meet.

## What works
- Unique private country-aware number allocation with a PostgreSQL/SQLite transactional counter.
- Stable numbers and idempotent provisioning.
- Email, internal number, name, and organization-extension resolution (same tenant only).
- Authenticated-actor interface for call initiation, lifecycle and history.
- Call event adapter hook for Qorlla Voice/Meet.
- No Q prefix; no PSTN functionality.

## Run locally
```bash
npm install
cp .env.example .env
# set DEV_AUTH=true for isolated development only
npm test
npm start
```
For PostgreSQL set `DB_DRIVER=postgres`, set `DATABASE_URL`, and apply `sql/postgres.sql` with `psql` before starting.

### Local API example
Set `x-dev-user-id` and `x-dev-tenant-id` headers to your test UUIDs, then POST `/api/qgics/provision` with:
```json
{"id":"11111111-1111-4111-8111-111111111111","tenantId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","email":"alice@example.com","emailVerified":true,"displayName":"Alice","countryIso":"GH"}
```
The caller must match the account being provisioned. This is **only a local test route**; do not expose it publicly.

## Tests
```bash
npm install
npm test                                   # 9 tests on SQLite (in memory)
TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:25690/postgres npm test   # +1 PostgreSQL test
```
The PostgreSQL test creates its own throwaway database on the server you point it at, applies `sql/postgres.sql` twice (re-applying is harmless), and drops the database afterwards. Never point it at a server holding data you care about without a scratch role.

Covered: 60 simultaneous registrations without a duplicate number; the same account registering 10 times at once (one record, one number); identity conflicts (different email, tenant, or an email already owned by another account) refused without re-numbering; email and number lookups resolve to the same person; other tenants invisible by name, email and number; suspended accounts cannot call, be called, look up or read their number; call state machine (only the callee answers or rejects, third parties blocked, no double transition, one winner of two racing transitions, failed signalling ends the call); numbers never touch PSTN code; PostgreSQL pool restart keeps numbers and the counter continues.

### Defects found and fixed by those tests
- SQLite: simultaneous registrations interleaved transactions on the single connection ("cannot start a transaction within a transaction"). Transactions are now serialized.
- PostgreSQL: simultaneous registrations of the same account raced between "does it exist" and "insert" (duplicate key). Provisioning now does insert-or-ignore and locks the account's row; an email owned by another account is reported as `identity_conflict`.
- PostgreSQL: an idle pooled connection dropped by the server emitted an unhandled `error` event that would crash the process. The pool now handles it.

Still NOT done: authenticated ringing to real devices, WebRTC media, authenticated registration events, Shield enforcement, cross-tenant calling by consent, load and abuse tests. See the list above.

## Required production integration (not included)
1. Replace `actorMiddleware` with existing Portal session/JWT validation; never trust identity headers from a browser. Provision only from verified registration events, not self-asserted `emailVerified`.
2. Wire Shield policy for global directory opt-in, block lists, abuse limits, and explicit cross-tenant contacts; cross-tenant calls are intentionally denied by default.
3. Wire durable call signalling and real WebRTC session establishment to existing Qorlla Voice/Meet, with authenticated recipient-device subscriptions, idempotent event delivery, expiry, and recovery.
4. Add durable outbox and state-machine locking for distributed call transitions, timeouts, cancellation, reconnect, and duplicate requests.
5. Add production audit retention, privacy deletion policies, monitoring, rate limits, integration and concurrency/load tests, and country verification policy.
6. Run real PostgreSQL migrations in an isolated worktree; review numbering range policy with telecom counsel if enabling PSTN. These identifiers are not public telephone allocations.
7. Validate existing Qorlla repository contracts and avoid modifying running deployments until approved.

## Important limitations
- Country list is illustrative and intentionally incomplete.
- Shared +1 code countries use disjoint serial spaces. A full worldwide registry needs collision-tested namespace governance.
- Number formatting deliberately uses a 12-digit private serial and **does not assert E.164 conformity**.
- Name search and email/number lookup are tenant-scoped to avoid exposing arbitrary Qorlla accounts.
- This package does not send rings to actual devices without a supplied event adapter; the default hook is a no-op.
- SQLite is for development/small single-process deployments; PostgreSQL is recommended for distributed production.
