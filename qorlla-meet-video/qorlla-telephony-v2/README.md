# Qorlla Telephony v2 — fail-closed implementation reference

This package is an integration **foundation**, not a completed or connected telephone service. It includes typed-by-contract JavaScript core utilities, a provider interface, fail-closed unconfigured adapter, authorization-gated call and number intents, PostgreSQL migration draft, and Node tests.

## Run
`node --test tests/*.test.mjs` (Node >=20)

## Integration required
1. Map UUIDs and foreign keys to the real Qorlla workspace/Meet schema; add RLS or DB role isolation and effective privilege audit.
2. Wire authentication and workspace roles to the existing server. Never accept an actor identity from browser JSON.
3. Implement an actual provider adapter, signed raw-body webhook verification according to the provider's documented scheme, idempotent provisioning/call workers, and reconciliation.
4. Implement the actual IVR with per-meeting PIN verifier, attempt budgets, host waiting-room approval, lock and end handling.
5. Integrate a certified SIP/RTP-to-Qorlla WebRTC bridge, including codec, jitter, DTMF, mute/remove, participant roster, and audio tests.
6. Reconcile provider billing usage, currency and taxes; do not charge customers based solely on local timer.
7. Add real API routes and frontend capability endpoint; keep calling and phone join disabled until independently certified.
8. Verify provider regional regulations, number eligibility, emergency-calling policy, recording/AI consent, and fraud protections.

## Operational rules
No hardcoded active phone numbers. No plaintext PINs. No secrets in logs. No success claims without provider-backed tests. Avoid collecting sensitive payment data on this module. Use event replay and out-of-order webhook handling.
