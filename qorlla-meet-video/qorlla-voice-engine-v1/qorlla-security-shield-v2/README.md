# Qorlla Security Shield v2.0 — reference integration service

## Scope
Standalone TypeScript/Fastify authorization gateway with PostgreSQL policy state, device trust, organization controls, risk signals, fail-closed authorization, short-lived single-use authorization tickets, transactional rate counters, JWT/JWKS validation, and audit events. Tests cover policy decisions. This is **not certified production-ready** without the integration and security gates below.

## Setup
1. Provision PostgreSQL 15+ and distinct schema owner/migrator/runtime DB roles. Apply `sql/001_init.sql` as migration owner using `psql -v ON_ERROR_STOP=1 -f sql/001_init.sql`. Enforce least-privilege grants and validate inherited/default permissions.
2. `npm install`, `cp .env.example .env`, configure secrets, real identity issuer, JWKS, audience and TLS DB connection. Never commit `.env`.
3. `npm test && npm run build`; `npm start`.
4. Populate `shield.principal_state` only from trusted identity/KYC events, `shield.devices` only from attested device enrollment, `shield.organization_policy` from authorized administrators, and `shield.risk_signals` from trusted risk detection. Do not expose these tables through client-writable endpoints.
5. Integrate gateway calls at **every** Qorlla voice, meeting, messaging, guest and admin server-side entry point. On deny, fail closed; do not let client bypass the service. Consume tickets exactly once and match actor/action/resource. Protect service-to-service endpoints with mTLS plus workload identity in deployment; static token is a transitional example.

## Example authorize
`POST /v2/shield/authorize` with `Authorization: Bearer <identity JWT>` and body:
`{"requestId":"00000000-0000-4000-8000-000000000001","action":"message.send","resourceId":"conversation:123","deviceId":"00000000-0000-4000-8000-000000000002"}`

## Explicit security limitations / blockers
- **No real telecom fraud certification:** PSTN calls are denied without trusted `voice:gateway:validated` scope; even that scope alone is insufficient. Build a trusted server-side E.164 destination resolver, premium-rate denylist, route restrictions, account balances/spend limits, active-call concurrency limits, carrier CDR reconciliation, emergency calling controls, and enforced call termination on risk/budget exhaustion. Never accept client-provided `international` or `destinationAllowed` as authoritative. The current implementation accepts these request fields and therefore must not be enabled for live PSTN.
- **No complete meeting security:** connect meeting membership, invite signatures, guest admission, lobby enforcement, anti-phishing scanning, external federation policies, and ejection at signaling/media gateways.
- **No complete messaging abuse defense:** implement sender/recipient relationship checks, spam detection, attachment malware scanning, URL reputation, report/block and moderation appeals.
- **No production risk engine:** `risk_signals` ingestion, signal quality, scoring calibration, appeals and false-positive reviews are not provided.
- **MFA enrollment is not step-up proof:** replace `mfa_enrolled` with recent signed authentication context (`auth_time`, `acr`, `amr`) and trusted step-up verification. Device ID alone is not proof of device possession.
- **No administrator security API:** secure admin workflows need privileged identity, maker-checker, audit and review; never directly expose state-table writes.
- **Counter limitations:** fixed UTC-hour counters (not rolling windows), database advisory lock is actor-specific, and counters are incremented before downstream action completion. Add compensation and global/tenant-level abuse budgets.
- **Authorization replay semantics:** requestId is idempotent, but the earlier authorization lookup should additionally verify actor, action, resource and expiry; reject reuse with mismatched payload. Harden this before exposing to production.
- **Audit limitations:** DB trigger does not protect against table owners/superusers. Add append-only external audit stream, retention/WORM, tamper-evidence, and tested effective privileges.
- **Operations:** add HA, DB outage tests, secrets rotation, mTLS, distributed tracing, SIEM alerts, security incident response, data retention, privacy/legal review, backup/restore and red-team testing.

## Release gates
Do not enable unrestricted public access until all blockers are resolved and proven in CI/staging with adversarial tests, two-device cross-account testing, tenant isolation, outage/fail-closed drills, webhook replay tests, and an independent penetration test. No claim of Microsoft Teams vulnerability parity is implied.
