# Qorlla Voice Number Service v1.0 — Integration Scaffold

This is a **security-oriented implementation scaffold**, not a certified, ready-to-activate telecom service. No real telephone numbers are included, no provider is connected, and no code is deployed to Qorlla.

## Components
- JWT/JWKS authentication and authorization-bound self-service routes
- Persistent internal Qorlla extensions, with PostgreSQL sequence and concurrency lock
- Verified country evidence gate; IP suggestions cannot qualify
- One current number per user, uniqueness enforced by partial indexes
- Atomic number reservation, idempotency keys, transactional outbox, retry/lease worker
- Provider adapter interface, fail-closed default, mock only for isolated tests
- Signed raw-body provider event ingestion, event deduplication, guarded transitions
- Append-only database audit trigger

## Install and run (isolated staging)
1. `npm ci` (after generating and reviewing a lockfile) or `npm install` in development.
2. Create a dedicated PostgreSQL role and database with least privilege. Run `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/001_voice_numbers.sql` using a migration role, **not** the runtime role.
3. Configure `.env.example` values through a secrets manager (environment loading is external).
4. `npm run build && npm test`.
5. Run the API with `npm start`; run worker only after connecting a real provider adapter.

## REQUIRED production completion gates
1. Integrate actual Qorlla account lifecycle and shared user UUID identity. Do not create a parallel account authority.
2. Implement provider-specific inventory import and regulatory eligibility verification; only insert numbers legally controlled by the provider. Configure geographic and number-type policies per country.
3. Replace `src/provider.ts` mock with an authenticated, idempotent, TLS-verified carrier API adapter. Implement provider's **actual** webhook signature scheme, timestamp/replay window, callback allowlisting where appropriate, and event ID verification. The included HMAC scheme is a demonstration contract, not a provider specification.
4. Implement carrier reconciliation for uncertain outcomes, expired leases, missing callbacks, out-of-order events, and provisioning timeout. The outbox records submission, not activation.
5. Add inventory quarantine and recycling policy, proof revocation, fraud scoring, number portability, billing, taxes, emergency calling, lawful intercept obligations where applicable, retention, and privacy controls.
6. Add inbound DID-to-extension routing and outbound PSTN call authorization **in the existing Qorlla voice engine**, with separate rate limits, caller-ID verification, and country-specific emergency behavior. This scaffold does not route live calls.
7. Harden infrastructure: mTLS or private network for callbacks, distinct DB runtime/migration/audit roles, no runtime DELETE/UPDATE on audit events (including inherited/PUBLIC/default privileges), TLS, key rotation, encrypted backups, observability, alerting and incident response.
8. Implement worker singleton or safe multi-worker claim ownership and reconciliation; the current lease is an initial design and must be load-tested under delayed provider calls.
9. Add end-to-end tests for race conditions, idempotency-key payload reuse, stale webhook events, webhook spoofing, retry, provider failure, country evidence expiry, country portability, and rollback.
10. Run country-by-country legal and carrier certification, test real incoming/outgoing calls, and approve gradual rollout with feature flags.

## API
- `POST /v1/voice/identity`: create or retrieve permanent extension
- `GET /v1/voice/numbers/me`: return own extension and number state
- `POST /v1/voice/numbers/assign`: `{ "country": "US" }` with UUID `Idempotency-Key`
- `POST /v1/voice/numbers/release`: request number release
- `POST /v1/voice/provider/events`: example HMAC-protected callback (replace for real provider)

## Security note
A country IP detection endpoint is deliberately not included because its implementation must use Qorlla's trusted reverse-proxy/IP chain, licensed geolocation database, and privacy policy. Never trust client-submitted `X-Forwarded-For` or `country` as evidence of residence.
