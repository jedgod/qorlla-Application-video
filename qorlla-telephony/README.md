# Qorlla Telephony Control Plane — integration reference

This is **not production certified**. It is a runnable, fail-closed reference skeleton, not a complete deployed telephony service. No Twilio dependency.

## Run
Node.js 22+, PostgreSQL 16+. `npm install`, apply `sql/001_telephony.sql` with `psql`, configure environment variables and `npm test`, then `npm start`.

## Implement before any production release
1. Integrate the real Qorlla identity, Shield, entitlement and MFA APIs. URLs in `.env.example` are placeholders; the example bearer service token must be replaced with workload identity/mTLS and verified trust boundaries. Never trust caller-provided identity or gateway evidence.
2. Wire the A4 gateway, Meet admission, SFU/WebRTC media evidence, signed gateway event ingestion, session revocation, waiting room, mute, removal and cleanup. `transition()` must only be invoked by an authenticated gateway/Meet service after independent verification.
3. Implement reliable outbox worker with `FOR UPDATE SKIP LOCKED`, retries, deduplication, dead-letter handling, ordering and delivery acknowledgments. `call.authorized` currently only enqueues an event; it does not originate a real call.
4. Implement per-tenant routing, verified ownership of extensions, E.164 parsing with a proper numbering library, emergency and premium-rate classification, destination allowlists, time-of-day policies, fraud velocity controls and budgets. Prefix matching is only a minimal illustration.
5. Implement real SBC and wholesale carrier adapters with SIP/TLS, SRTP, trusted carrier IP ranges, mTLS where available, inbound DID ownership, inbound authentication and signed callbacks. The included carrier is deliberately disabled.
6. Implement rated usage from reconciled network events and carrier CDRs; reservation, atomic double-entry posting, refunds, disputes, taxation, prepaid/credit limits, reconciliation, and provider settlement. Usage/ledger schema is a starting point, not a complete billing implementation.
7. Add TLS ingress, request schema validation, response correlation IDs, structured audit logs, tracing, metrics, health readiness, circuit breakers, deployment manifests, secret rotation and backup/restore testing.
8. Add full integration and security tests: real PostgreSQL, concurrent idempotency, authenticated callback replay, carrier outages, one-way media, disconnect races, meeting revocation, failover, cross-network TURN, physical phones, load, privacy and incident runbooks.
9. Review telecom regulation, numbering, emergency calling, lawful intercept, recording consent, privacy, taxation, carrier contracts and jurisdictional requirements with qualified counsel and the carrier.

## Release gates
`INTERNAL_CALLS_ENABLED=false` and `EXTERNAL_CALLS_ENABLED=false` by default. External calls cannot be enabled in this reference even if its environment flag is changed. Production enablement requires a separately reviewed carrier implementation and release process.
