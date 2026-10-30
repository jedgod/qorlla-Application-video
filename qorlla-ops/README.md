# Qorlla operations control

> **Superseded** by the Portal-integrated implementation (`qorlla-portal/server/ops`, `docs/ENTERPRISE_OPS.md`) on branch `integration/enterprise-ops`: it reuses the Portal's authentication, billing and database instead of a second service with its own tables. Kept only for reference; do not deploy both.

Staff tickets and external-calling purchase **requests**, with role authorization. Built from `qorlla-ops-starter` and hardened. **Not certified for production.** It is not wired into the Voice Engine, the main app or any carrier; it holds no payment data and activates nothing.

## What it does
- JWT (ES256/RS256, issuer + audience checked, your JWKS) with staff roles `super_admin, ops_admin, supervisor, support_agent, billing_agent, technical_agent`; unknown roles are ignored; per-identity rate limit.
- Tickets: create, list/filter, read with history; **assign** (supervisor and above); **status** moves through a fixed state machine (`closed` is final) by a lead or by the assignee only. Each change is a row-locked transaction plus an event. History is append-only in the database (UPDATE/DELETE/TRUNCATE rejected).
- External calling: `POST /api/ops/external-call-requests` records a **request** (`pending_verification`); one pending per customer+plan; it can be cancelled. **No endpoint verifies a request**, and PostgreSQL refuses `verified` unless the entitlement/payment authority sets `qorlla.entitlement_authority=on` in its own transaction. That authority does not exist yet; until it does, nothing can be verified, so nothing can activate PSTN or assign a number.

## Run
1. Apply `schema.sql` with a migration role (the app role should not own the tables; grant it SELECT/INSERT/UPDATE only, no DELETE/TRUNCATE).
2. `npm install`; set `DATABASE_URL`, `JWT_ISSUER`, `JWT_AUDIENCE`, `JWKS_URI` (optional `PORT` default 6080, `OPS_RATE_PER_MIN`); `npm start` (binds 127.0.0.1: put it behind your TLS proxy / private network).
3. Tests: `npm test` (real PostgreSQL from `.dev-stack`; skipped, not passed, if unreachable).

## Not done
No customer-facing UI, no tenancy/ownership checks on `customer_id` (any staff member sees every ticket), no SLA/notifications, no integration with Qorlla identity roles, Numbers & Plans or a payment provider, no load or penetration testing, in-memory rate limit (per process). A payment request is not a payment.
