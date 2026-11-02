# Qorlla Voice Engine v1.4 — Distributed reliability gate

This is an **integration candidate**, not production-certified. It extends v1.3 with PostgreSQL durable events, transactional outbox helpers, replay/ack API, device-generation fencing primitives, and an outbox worker.

## Mandatory integration (NOT automatically wired)

1. Review `sql/004_distributed_reliability.sql` and apply in staging using the migration runner.
2. Replace call transition usage in `src/server.mjs` with `transitionReliable`. Do not emit a direct Redis notification as the sole authoritative notification. Ensure call creation, timeout and all other state mutations append events **inside the same DB transaction**. Existing `createCall` and maintenance paths remain v1.3 and need adaptation.
3. Mount `mountReliability(app,auth)` from `src/reliability-http.mjs`.
4. Run `OutboxWorker` in a separately supervised process, with publish using the existing Redis `bus.publish`. The worker intentionally is not started automatically.
5. Require generation values on all media signaling; use `ownsGeneration` against the current PostgreSQL lease before forwarding. `claimFencedDevice` must replace v1.3 claim. Add immediate socket close/media stop signaling on lease changes. Do not assume remote peer audio stops just because signaling is revoked.
6. For WebSocket reconnection, use `handleResume` or HTTP events endpoint and reconcile the current call snapshot. Persist the last acknowledged cursor on client and deduplicate by event ID.
7. Add explicit queue-depth/oldest-age metrics, cleanup policy and PostgreSQL retention plan. Do not delete unacknowledged events before your recovery window.
8. Protect Redis with ACL/TLS, run separate DB roles, and deploy multiple replicas behind WSS load balancing.

## Safety and known gaps

- Redis Pub/Sub remains lossy for transient SDP/ICE; peers must renegotiate after reconnect. Durable event storage intentionally excludes SDP and ICE to avoid persisting sensitive media negotiation payloads.
- `voice_reliable_events` uses global database IDs; a cursor is account-scoped on reads. Gaps are normal.
- Replay pagination has a fixed maximum 200; continue while `hasMore` is true.
- The supplied replay API does not yet validate ownership of `deviceId` beyond authenticated account and syntactic UUID; integrate trusted device registration before enabling acknowledgments in production.
- Outbox publication is at-least-once; clients deduplicate by `eventId`.
- Lease-generation fencing is a primitive; existing signaling routes must be patched to enforce it.
- No physical device, PostgreSQL failover, Redis cluster, load, browser or TURN test is claimed.
- Emergency/PSTN calling remains disabled. Qorlla-to-Qorlla internet calling only.

## Verification

`npm test` and `node --check` for new modules. `node scripts/certify.mjs` intentionally refuses to mark a release production certified; certification requires independently recorded real test evidence.
