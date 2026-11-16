# Qorlla SmartRooms V1.8 — Private AI, shared outbox and media assurance

**Integration candidate, not production ready, not deployed.** Existing `qv-chat` repository code and the real Portal AI gateway are not present. No claim of actual integration or independent media verification is made.

## Included
- `sql/009_private_ai_outbox_media.sql`: room consent, AI job metadata, transactional event/outbox, idempotent consumer receipts, movement epochs and audit.
- `src/private-ai.mjs`: Meet-authenticated per-room consent, roster snapshot, durable quota reservation adapter, encrypted temporary source staging through existing Portal bridge, asynchronous report worker, revocation checks and room-scoped report access.
- `src/outbox.mjs`: PostgreSQL SKIP LOCKED leases, retry/backoff/dead letters, consumer idempotency and transactional event append.
- `src/media.mjs`: room/epoch signaling authorization, client media reports, authenticated relay telemetry (no false 'verified' label).
- `src/bridge-contract.mjs`: required Portal gateway adapter and security expectations.
- `tests/security.test.mjs`: fail-closed and media-status tests.

## Integration blockers requiring real source
1. Review and reconcile migration 009 with migrations 001–008 and actual Meet database.
2. Wire `meetAuth` to Meet session verification, `roomAuthority` to real room membership and row locking, and `signaling` to the actual relay. **Every** WebRTC offer, answer, candidate, renegotiation, data-channel invitation and reconnect must check room+epoch.
3. Wire `portalBridge` to the **existing** Portal AI gateway using mTLS/workload credentials, tenant-bound service identity, no direct model access, encrypted short-lived source staging, and verified deletion. Ensure reports are generated only from explicitly consented data, not a silently recorded transcript.
4. Wire `entitlements` and `quota` to actual Portal subscription services with atomic idempotent reservation/commit/release. Reconcile reservations on crashes, cancellations and timeouts.
5. `processJob` is **not** a production worker: add PostgreSQL job leases/fencing, crash recovery, bounded retries, quota settlement, cancellation interrupts, input redaction, output validation, and privacy-safe logging. Consent/roster changes during inference cannot retroactively erase data already processed.
6. Provide a **shared bus** (Redis Streams, NATS JetStream or equivalent) with consumer groups, durable replay, deduplication and tenant-scoped subscriptions. The outbox module provides PostgreSQL leasing but does not provision a bus or WS fanout.
7. Integrate TURN relay-only with authenticated allocation telemetry and ensure P2P bypass is disabled if policy requires relay. TURN allocation/traffic observations alone do not prove which audio/video content was delivered or decrypted; **do not label as server-verified media**. For stronger independent evidence, deploy a controlled SFU/media gateway with participant consent and enforceable routing.
8. Add HTTP routes, CSRF and origin validation, request schemas, frontend consent/revoke UI, AI job status/report view, accessibility, room-scoped report exports, retention and deletion jobs.
9. Certify real PostgreSQL, multiple Meet instances, outbox failover, quota concurrency, malicious clients, 3+ real browsers, relay-only TURN, Safari, iOS/Android, load, recording consent, and independent security review.

## Running checks
`npm test` and `npm run check` (Node 20+). Database and real service integration tests are **not** included.

## Security caveats
- This code contains no service credentials, and cannot connect to the real Portal without an adapter.
- AI source staging occurs during an open database transaction. In production, use a durable two-phase workflow with reconciliation and short DB locks.
- Do not send source content or raw transcript through the outbox.
- The `consumeOnce` implementation assumes event IDs belong to the same shared PostgreSQL DB; bus payload must be validated against trusted database events.
- Use server-side authorization at delivery time; outbox recipient filtering must not rely on client-supplied room identifiers.

**Release gate: NO-GO.**
