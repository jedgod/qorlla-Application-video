# Qorlla Voice Engine v1.5–v1.9 integration pack

Based on the v1.4 source package. Includes integrated transactional events on call creation/transitions/timeouts, an outbox runner, replay API mounting, staging deployment skeleton, and certification evidence framework.

This is **not a complete production deployment**. It is an integration candidate and staged certification kit.

## Run

1. Inspect schema and app auth adapter. Set DATABASE_URL, REDIS_URL, origin allowlist, and TURN.
2. `npm install` then `npm run db:migrate` in a disposable database (do not run blindly against production).
3. `npm test` and `npm run certify`.
4. Run two backend nodes, real PostgreSQL/Redis, coturn, and two physical clients.
5. Collect evidence for all QVE-01 through QVE-15; run `node scripts/release-gate.mjs certification-evidence.json`.
6. Obtain independent security and release approval before production rollout.

## Design notes

- Redis Pub/Sub is an accelerator, not the source of truth. PostgreSQL outbox is durable for incoming/state events.
- The client must reconcile on reconnect; out-of-order event IDs across concurrent transactions require careful cursor semantics. Use a per-account serialized event sequence or conservative reconciliation snapshot before trusting a high-water cursor in production.
- The lease fencing fields added to WebSocket signaling require coordinated SDK changes. Until that work is complete, SDP/ICE will fail closed.
- Device takeover must terminate existing media tracks on the previous device. Not yet implemented.
- Production security still requires CSRF review for cookie auth, endpoint-level rate limits, strong secrets, role-separated database credentials, operational telemetry, retention, and real-network validation.
- PSTN calling is intentionally unavailable; internal Qorlla VoIP does not need Twilio.
