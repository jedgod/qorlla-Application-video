# Production certification gates — ALL OPEN

- [ ] Integrate with real Qorlla OIDC issuer and verify token claims/tenant membership.
- [ ] Implement customer self-service authorization; current operations API is staff-only.
- [ ] Apply database least-privilege roles, RLS defense-in-depth, and tenant-aware identity lookup.
- [ ] Integrate authoritative Numbers & Plans version/outbox; no local number ownership.
- [ ] Integrate real payment provider with signature-verified webhooks, double-entry ledger and reconciliation.
- [ ] Keep PSTN/VOICE_NUMBERS disabled until carrier, fraud, pricing, and engine certification.
- [ ] Integrate meeting telemetry without exposing meeting media or private content.
- [ ] Add CSRF/session strategy, rate limiting, request IDs, structured redacted logs, tracing.
- [ ] Add refund approval workflow, staff directory validation and full ticket state machine.
- [ ] Add E2E, load, resilience, threat-model, penetration, backup and restore evidence.
- [ ] Build hardened container images, secrets, network policy, rollback and staging promotion.
- [ ] Replace temporary token-entry UI with production OIDC authorization-code + PKCE login.
