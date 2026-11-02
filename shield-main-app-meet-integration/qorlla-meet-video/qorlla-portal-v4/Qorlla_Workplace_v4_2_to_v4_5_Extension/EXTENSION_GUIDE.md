# Qorlla Workplace v4.2–v4.5 Extension

## Scope
This archive extends the existing v4.1 portal with PostgreSQL-backed pages and API endpoints. It does **not** contain a telephony provider, an AI inference service, a Meet recording/transcription worker, a payment provider, or the MAIN-side SSO issuer. Such functionality is explicitly disabled, not simulated.

## Setup
1. Back up the portal database and review migrations. Run `sql/001_portal.sql` only for a fresh database, then `sql/002_workplace_extensions.sql` using `psql -v ON_ERROR_STOP=1`.
2. Install Node.js 20+, run `npm install`, `npm run check`, `npm test`.
3. Configure `.env` from `.env.example` and complete MAIN JWKS/cookie/CSRF integration as described in `INTEGRATION.md`.
4. Start `npm start` and browse `/app/ai`, `/app/receptionist`, `/app/phone`, `/app/mate`, `/app/suite`, `/app/pricing`.
5. Use the existing workspace membership and MAIN user identity. Do not copy any Meet recovery or host-secret tables.

## v4.2
`GET/POST /api/v1/meeting-ai/jobs`, `GET /meeting-ai/transcripts`, `GET /meeting-ai/action-items`, `GET/POST /meeting-ai/reports/:id/shares`, `POST /meeting-ai/shares/:id/revoke`. Jobs require consent references and remain pending until an approved processing worker is added. Report shares are permission records, not outbound email delivery. Recipient access is **not** implemented: never expose reports using these rows alone.

## v4.3
`GET/POST /receptionists`, `GET /phone/calls`, `POST /phone/calls` (503), `GET/POST /appointments`. Receptionist profiles are disabled by default. PSTN/provider integrations, consent and telecom review are release gates.

## v4.4
`GET/POST /mate/threads`, `GET/POST /mate/threads/:id/messages`, `GET/POST /mate/tasks`, `PATCH /mate/tasks/:id`, `GET/POST /suite/documents`, `GET/POST /suite/documents/:id/versions`. Assistant messages are stored as user messages only. Document revision writes use row locks and optimistic conflict checks.

## v4.5
`GET /billing/prices`, `GET /billing/invoices`, `POST /billing/checkout` (503), `POST /billing/webhooks` (503). Yearly prices are not invented. Add signed raw-body webhook verification, reconciliation and entitlements before activating payment collection.

## Mandatory production blockers
- MAIN-side SSO and browser end-to-end certification.
- Authorization and report sharing review (especially ownership and guest access).
- AI processing and consent lifecycle, retention and deletion.
- Telephony provider and regulatory requirements.
- Payment provider, webhooks, subscriptions, refunds and billing reconciliation.
- Real database migration/rollback, load and independent security review.
- nginx, TLS, physical devices and Meet v3.9.2 release gate.

## Important implementation note
These are runnable extension foundations, not production-ready completed integrations. No live PostgreSQL, browser or provider tests were performed in this packaging environment.
