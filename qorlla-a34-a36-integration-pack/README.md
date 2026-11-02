# Qorlla Voice A3.4–A3.6 integration source pack

**Status: NOT production certified. Do not deploy unchanged.** This is a concrete, security-first reference implementation requiring integration with the real `e40416e` repository and independent infrastructure tests. No source checkout of that commit was available. No physical devices, live TURN servers, Redis cluster, real PostgreSQL failover, or media servers were accessible during creation.

## Scope
Internal extensions only; no Twilio, public numbers, PSTN, carrier billing or number issuing. Includes mTLS+certificate-bound workload JWT verifier (`src/workload-auth.js`), internal call service, room tenant/membership enforcement, transactional PostgreSQL outbox, Redis notification worker, relay-only WebRTC client policy, server integration skeleton, unit tests and certification matrix.

## Files
- `src/server.js`: Fastify HTTPS mutual TLS listener, protected suspension route and Shield user-auth adapter injection.
- `src/workload-auth.js`: signature-verified EdDSA JWT, trusted JWKS, issuer/audience, certificate SHA-256 thumbprint, scope, short lifetime. Actual issuer/certificate rotation is external.
- `src/voice-service.js`: tenant-scoped extension invite, ringing/accept/reject/end, transactional suspension/outbox.
- `src/room-service.js`: tenant-scoped rooms, membership gate and room disable/kill event. Room member provisioning is NOT supplied; use existing authorized membership management.
- `src/db.js`: PostgreSQL transactions; `src/worker.js`: outbox to Redis notification (at least once).
- `src/relay-policy.js`: WebRTC relay-only client policy and local track teardown.
- `sql/001_voice_extension_only.sql`: reference schema, NOT production migration.
- `docs/CERTIFICATION_MATRIX.md`: unexecuted evidence plan.

## Integration blockers (must be resolved before release)
1. Adapt schema to existing principal tables and tenant model. Add effective least-privilege grants and RLS/tenant constraints. Validate migrations on sanitized production-like data.
2. Implement actual Shield adapter: `authenticateUser(req)` must verify real signed end-user credentials and return server-derived `{accountId, tenantId, verified, suspended, kind, scopes}`. Never trust client headers. A current principal DB check must remain authoritative.
3. Configure an actual certificate issuer, mTLS trust, certificate rotation/revocation, JWKS trust and JWT issuance with `cnf['x5t#S256']`. The example allowlist is not a real identity issuer. Strictly isolate administrative mTLS routes from browser endpoints in deployment.
4. Implement real authenticated WebSocket signaling: client subscriptions bound to tenant+account, event-id dedupe, state rechecks on every event, reconnection cursor/replay, heartbeat, backpressure and delivery acknowledgement. Redis Pub/Sub is lossy; it is not a durable consumer inbox. Do NOT claim notification or termination confirmation on publication.
5. Build actual Phone page and `voice.js` integration using the real signaling protocol and TURN credential service. No UI implementation is included here because current repo pages are unavailable.
6. Implement TURN credential issuance with short TTL, relay-only enforcement on every client, TURN allocation revocation or SFU-level media enforcement. Relay-only policy **does not by itself** guarantee immediate media termination; TURN allocations can survive signaling loss.
7. Implement multi-host routing and real media revocation. Room kill is a **durable intent**, not proof of RTP cutoff. No SFU is included. If strict immediate server-side cutoff is a release requirement, deploy a suitable SFU/media server or validated relay-allocation control plane.
8. Harden race handling: lock extension row for reassignment, coordinate principal sync with call transactions, add call state idempotency, invitations TTL, unique client request IDs, event acknowledgements, worker poison-message DLQ, alerting, metrics and graceful shutdown.
9. Re-run all existing 143 engine tests and actual Meet tests on the integrated tree. The tests here are new isolated checks only.
10. Execute all physical-device, TURN, multi-host, PostgreSQL failover, load, security and suspension matrix rows with evidence. All RC2 gates remain blocked.

## Local smoke tests
`npm test` (Node 22+). This does not require installing third-party dependencies because the tests cover isolated policy and relay helper code. Full service requires `npm install`, PostgreSQL, Redis, certificates and a real Shield adapter.

## Deployment restrictions
Production flags: `VOICE_NUMBERS_ENABLED=false`, `VOICE_PSTN_ENABLED=false`, `VOICE_INTERNAL_CALLS_ENABLED=true`, `VOICE_MEDIA_POLICY=relay`. Public-number and PSTN endpoints are not registered in this pack. Never deploy `gateway.js` / `TwilioMimicGateway` from the earlier uploaded prototype.
