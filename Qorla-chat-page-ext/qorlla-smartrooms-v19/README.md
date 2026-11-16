# Qorlla SmartRooms V1.9 — deployable integration candidate

**Status: NOT DEPLOYED, NOT CONNECTED TO THE ACTUAL QORLLA REPOSITORIES, NO PRODUCTION GO.**

## Contents
- `src/bridge.mjs`: signed HTTPS Meet-to-Portal submission client. Requires real Portal endpoint `/internal/meet/room-reports` and independent Portal enforcement of identity, live room roster, room consent, plan entitlement, atomic quota and AI model policy. This package does NOT create the Portal endpoint or AI inference worker.
- `src/events.mjs` + `src/worker.mjs`: transactional PostgreSQL outbox and Redis Streams publisher, leased claims, retries and idempotent inbox helper. At-least-once semantics; replay and recipient-filtered WebSocket consumer must be integrated with Meet. Redis stream retention needs sizing; PostgreSQL events are authoritative.
- `src/security.mjs`: HMAC request signing and event authorization helpers; gateway/relay/client evidence distinction.
- `src/server.mjs`: intentionally fail-closed Meet identity adapter; cannot be enabled without the actual Meet identity implementation.
- `sql/001_infrastructure.sql`: standalone tables (does not replace existing Meet tables).
- `deploy/compose.yaml`: isolated PostgreSQL/Redis/API/worker reference stack, not applied to a host. The internal Docker network cannot reach an external Portal gateway without a deliberately reviewed egress path.

## Integration blockers and security requirements
1. Obtain actual Meet `server/index.js`, Notes/Polls handlers, signaling room/epoch authority, Portal AI gateway routes, billing/entitlement APIs, and current DB migrations.
2. Implement `app.locals.meetAuthority` from verified Meet tokens, tenant/meeting membership, role and current room; never trust request-body identities. Provide `getRoomRoster` with live membership from Meet DB. Validate origin/CSRF for browser calls.
3. Build the Portal `/internal/meet/room-reports` endpoint with mTLS (or equivalent workload identity), replay-resistant signed requests, canonical payload verification, idempotency, quota reservation, room-consent revalidation and secure data acquisition. The bridge currently signs requests but the server endpoint is absent.
4. Build AI job dispatcher/reconciler to retry queued jobs after failures, and report completion. A direct call from Meet to an LLM is prohibited; Portal owns inference.
5. Implement a Redis Streams consumer group with authenticated room/epoch filtering at each WebSocket fanout; reconnect from PostgreSQL event cursor. Test two Meet nodes, worker crash, duplicate deliveries and Redis restart.
6. For independent media assurance, deploy a controlled media gateway/SFU or authenticated TURN allocation telemetry collector. TURN allocations alone cannot prove RTP media was delivered or isolated; no such service is deployed here.
7. Run migrations on a disposable PostgreSQL 16 instance, `npm test`, actual Portal bridge tests, real WebRTC browsers, TURN relay-only, Safari/mobile, load, and independent security review.
8. Do not enable production flags or alter live Qorlla services until all checks pass.

## Local checks
`npm install && npm test` (tests only use Node built-ins). To apply SQL: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/001_infrastructure.sql`.

## Media states
`clientReported`, `relayObserved`, and `gatewayObserved` are distinct. `serverVerifiedMedia` is true only for a trusted media-gateway attestation asserting authenticated media path; a TURN-only observation is never sufficient.
