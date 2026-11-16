# A4.8 Internal Calling + Parallel Carrier Work

## Delivered in this package
- PostgreSQL migration 003: gateway-to-call binding, nonce uniqueness, independent release gates, Meet command journal.
- `InternalCertification`: gateway identity preflight, fail-closed Shield and Meet authorization, durable nonce insertion, and queued Meet commands.
- `WholesaleCarrier`: fail-closed external-call policy contract, without a functioning carrier adapter.
- Local Node tests.

## Important integration boundary
`acceptEvent` remains a **preflight**, not an event processor. `PostgresIntegration.gatewayEvent` now checks a signed nonce, the authenticated principal's call/session binding, the internal release gate, event ordering, and the state transition in one transaction. A connected transition additionally requires a matching stored Meet approval and an independent `verifyMedia` callback. Shield and Meet checks are injected callbacks, not yet wired to actual services; their authorization is not atomic with the database transaction. The ingress requires an injected `authenticateGateway` callback, which must derive the principal from verified mTLS identity, not from request data. Neither the callbacks nor a production mTLS server are supplied here. Do not expose this reference ingress or enable calling until they are implemented and reviewed. External callbacks still require independent authentication, scope and replay protection.

`SimulatedCarrier` is an explicit, non-production, in-memory-free test stub. It reports `simulated` and `connected:false`, never originates a call or accepts carrier events, and is not wired into the running application.

## Required real-repository wiring
1. Map existing Qorlla identity, tenant, Shield and Meet lifecycle APIs to injected authorization callbacks.
2. Reconcile migration numbering with the application's migration registry; run against a disposable PostgreSQL 16 database and validate rollback strategy.
3. Add mTLS gateway identity, durable replay protection and certificate rotation; do not use shared HMAC alone as production identity.
4. Deliver outbox commands to Meet with idempotent acknowledgements, lease fencing, dead-letter inspection and retry monitoring.
5. Require host approval before media admission; enforce mute/remove/end at the media layer.
6. Capture real bidirectional SRTP/media evidence and handle one-way audio and ICE failure.
7. Develop carrier-specific SBC adapter, inbound DID ownership, emergency policy, corridor rate cards, double-entry ledger, holds, refunds, CDR reconciliation and disputes.
8. Test PostgreSQL concurrency, crash/restart, gateway reconnect, physical devices, real carrier, privacy, security and load.

## Gate policy
Keep `INTERNAL_CALLS_ENABLED=false`, `EXTERNAL_CALLS_ENABLED=false`, `VOICE_NUMBERS_ENABLED=false` and PSTN ingress disabled. SQL gates also default to false. No tests in this package authorize flipping them.

## Validation scope
The gateway event tests can use a disposable PostgreSQL database through `TELEPHONY_TEST_DATABASE_URL`; without it they are skipped. The suite does not establish integration with the current Qorlla application, a running Meet/A4 service, a SIP SBC, a carrier or a real telephone. This is a development patch, NOT a certified production integration.
