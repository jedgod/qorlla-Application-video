# Qorlla A4 integration: implementation and certification gates

This package is **not production-certified**. It provides concrete PostgreSQL migration, SQLite schema for development, signed HTTP ingress, call-event transitions, Meet admission persistence, transactional outbox leasing, and CDR comparison. No real SIP signaling, SBC or carrier transport is included.

## Existing Qorlla repository integration

1. Apply `sql/001_telephony.sql` then `sql/002_integrations_postgres.sql` in a controlled migration; do not overwrite existing Qorlla tables. Validate roles, indexes, grants and existing migration numbers.
2. Integrate `PostgresIntegration` with existing PostgreSQL pool; mount `createIntegrationServer` behind private ingress and mTLS. Use existing Qorlla identity, Shield and Meet approval services for `authorizeMeet`. Never expose `/internal/*` to the public internet.
3. In A4, send events with stable eventId, monotonic sequence per gateway/call, authenticated gateway identity and HMAC. The gateway-event transaction records its nonce persistently; Meet and carrier ingress still need replay protection. Only issue MEDIA_VERIFIED after observing authenticated SRTP transport and verified bidirectional RTP audio. Independently verify that evidence; never trust event payload alone.
4. Bind callId to gateway identity, tenant and Meet session using authoritative provisioning, not event payload alone. The event transaction verifies the stored binding; provisioning and an mTLS principal resolver still need real integration. Add gateway credential rotation, server-side revocation, rate limiting and network ACLs.
5. Connect `meet.admission` outbox topic to Meet's existing waiting room and host approval lifecycle. Denial, removal, host hang-up and Shield suspension must terminate the gateway peer and revoke media credentials. Persist event ordering across gateway restarts.
6. Implement a durable delivery endpoint that accepts outbox id as an idempotency key. Schedule `runOutboxBatch` under a supervised worker; at-least-once delivery is expected. Add dead-letter alerting, replay tooling and graceful shutdown.
7. Deploy a certified SBC with SIP/TLS, SRTP, IP ACLs, certificates, emergency policy and wholesale carrier interconnection. This package does **not** originate PSTN calls or certify carrier interoperability. Keep PSTN flags OFF.
8. Integrate signed carrier CDR ingestion with a provider-specific verified adapter. Reconciliation is comparison only: add tariff versioning, reserves, double-entry ledger, refunds, settlement and dispute workflows before billing live.
9. Run PostgreSQL 16 concurrency/failover tests, gateway end-to-end SIP/RTP tests, actual Meet browser/phone tests, security review, cross-network TURN, observability and on-call rehearsals. SQLite is a local testing schema, not a drop-in substitute for PostgreSQL concurrency/locking.

## API contracts

`POST /internal/gateway/events`: eventId, callId, gatewayId, sequence, type, evidence, optional meetingId. Authenticated gateway only.
`POST /internal/meet/admission`: callId, meetingId, approved, actorId. Requires authoritative `authorizeMeet` callback.
`POST /internal/carrier/cdr`: carrierId, cdrId, callId, seconds, amountMinor, currency. Requires authoritative `authorizeCarrier` callback.

All three endpoints require HMAC timestamp, nonce and signature headers. The HMAC message is `METHOD\nPATH\nTIMESTAMP_MS\nNONCE\nSHA256_RAW_BODY`. HMAC alone is **insufficient** for production; deploy mTLS and key rotation. Gateway-event nonce deduplication is transactional; Meet and carrier endpoints do not yet have durable nonce deduplication.

## Known limitations

- Gateway event ingestion checks the stored call binding and nonce transactionally, but the authenticated principal, Shield, Meet authorization, and independent media verifier are injected and not connected to the real services. Do not expose it as trusted ingress until those integrations and mTLS are implemented and verified.
- Meet admission API persists an authorized decision but relies on the caller-provided approval flag; `authorizeMeet` must consult the real host and Shield service.
- SQLite DDL is provided for development and schema parity, not a fully implemented SQLite backend.
- No SIP stack/SBC adapter, carrier provisioning, live billing, regulated emergency handling, production secrets management or operational dashboards are provided.
- Outbox worker requires an external idempotent receiver; retry/dead-letter alerts must be wired.

## Gates

INTERNAL_CALLS_ENABLED=false and EXTERNAL_CALLS_ENABLED=false until separately certified. Never infer readiness from unit tests alone.
