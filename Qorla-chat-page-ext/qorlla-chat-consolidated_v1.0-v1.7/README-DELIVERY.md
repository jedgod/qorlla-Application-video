# Qorlla Chat consolidated V1.0–V1.7 source folder

This folder contains the previous V1.0–V1.5 reference source **unchanged** plus V1.6 private-AI orchestration, focused dependency-free security tests, and V1.7 fail-closed release evidence checker.

## Local commands

- `node --test tests/v16/*.test.mjs` — private AI unit/security checks, no external dependencies.
- `npm install && npm test && npm run build` — existing app tests and frontend build (requires dependency installation).
- `node certification/check.mjs` — MUST exit nonzero until every mandatory certification gate has evidence.

## Important limitations

The actual Qorlla repository was not available from the connected GitHub search. This is **not a repository-specific patch**, and no Qorlla Portal/Meet/Shield live integrations or full automated certification have been performed. The prior V1.0–V1.5 modules have known security gaps documented in README.md. They are included for continuity, not approved deployment. The V1.6 module requires injected **real** Portal, entitlement, quota, message-loading and audit adapters; it deliberately rejects unapproved Ollama endpoints. Do not enable the prior AI endpoint.

V1.7 checker verifies existence of gate evidence, not its authenticity. Human review of logs, revisions, test environments, and failures is required. Production verdict: **NO-GO**.
