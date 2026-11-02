# Qorlla Enterprise Operations v2.0

Runnable **integration starter**, not production certified. Matches the requested monorepo layout. Contains three web portals, an operations API, shared policy/contracts, PostgreSQL schema, adapters with fail-closed stubs, CI and security documentation.

## Start

1. `corepack enable && pnpm install`
2. Create PostgreSQL database; apply `migrations/postgres/001_operations.sql` using a migration-only role.
3. Copy `.env.example` to `.env` and replace identity/JWKS and DB settings.
4. `pnpm --filter @qorlla/operations-api dev`; run `pnpm --filter @qorlla/admin-web dev`, likewise staff and customer-support.
5. `pnpm test && pnpm build`

**Do not put real customer data in a development environment.** Portals require a bearer token from the existing Qorlla identity provider. They intentionally do not implement password handling. The customer portal must be connected to customer-scoped authorization before public deployment.

## Integration and release status

- No existing Qorlla repository was supplied. This is standalone source, not a patch to an existing branch.
- Number-authority, meeting, payment and PSTN integrations are **fail-closed** pending real contracts.
- `VOICE_NUMBERS_ENABLED=false`, `PSTN_ENABLED=false` must remain off until certified.
- This package has not been end-to-end tested against live Qorlla services. See `docs/roadmap/production-gates.md`.
