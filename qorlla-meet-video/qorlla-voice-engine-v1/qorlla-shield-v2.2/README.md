# Qorlla Security Shield v2.2 — repository integration overlay

This is an **integration overlay**, not a completed modification of the actual Qorlla repository. Built from the user's architecture decisions and prior pack; actual engine interfaces and Twilio Numbers & Plans schemas must be mapped before merging. It intentionally contains no live carrier credentials, real PSTN routing endpoint, or guest media token issuer.

## Authority
- Numbers & Plans / Twilio: ONLY authority for purchase, release, and provider lifecycle.
- `shield_number_projection`: monotonic read-only synchronized projection, keyed by provider SID and event ID.
- Engine: extension routing, ownership and call authorization, not carrier inventory authority.

## Files
- `src/policy.mjs`: fail-closed account, guest, device, tenant, and capability policy.
- `src/workload.mjs`: policy for externally VERIFIED mTLS/SPIFFE identities; transport verification is a deployment prerequisite.
- `src/guest.mjs`: guest request, host approval, signed callback verification; integrate with existing meeting/passcode store, durable rate limiter and media gateway.
- `src/pstn.mjs`: transactional pre-dial authorization contract; requires actual DB adapter and carrier dial adapter.
- `src/number-sync.mjs`: versioned authority-event synchronization; requires trusted signed event adapter and SQL transaction adapter.
- `sql/003_security_integration.sql`: additive tables, append-only row trigger; DBA must also revoke TRUNCATE and inherited privileges.
- `tests/security.test.mjs`: isolated policy and security contract tests.

## Apply safely
1. Compare existing Qorlla engine schema, Numbers & Plans API, and migration history; resolve naming conflicts.
2. Apply SQL only in isolated staging after backup and migration review.
3. Implement adapter methods with real PostgreSQL transactions and concurrency locks; no in-memory financial enforcement.
4. Connect signed Numbers & Plans outbox to `applyNumberEvent`; reconcile against Twilio inventory and ownership.
5. Verify SPIFFE/mTLS at ingress and enforce per-workload operation allowlists.
6. Wire guest admission to real host session + atomic admission state + media credential issuer; host approval must be enforced by SFU/TURN admission path.
7. Connect `authorizeOutbound` to actual dial path, and reserve concurrency and estimated cost atomically. Reconcile uncertain provider outcomes before retrying.
8. Run database integration, failover, cross-host, TURN, device, fraud, webhook and pen tests.

## Hard release gates
- No guest extension, number, messaging, PSTN or host capabilities.
- No PSTN without real carrier and authoritative number ownership.
- No host-approved media access without admission record and gateway validation.
- No shared service secret masquerading as workload identity.
- No RC2 baseline or main changes until certification; release BLOCKED.

## Tests
`npm test` (Node 20+; no third-party dependencies for included contract tests).

**Not yet production-certified**: real repository integration, carrier adapter, mTLS verifier, DB transaction adapter, durable distributed rate limiter, full cost accounting, emergency services, cross-host and physical-device evidence remain outstanding.
