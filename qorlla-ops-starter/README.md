# Qorlla Operations Platform — implementation starter

This is a security-conscious backend starter, **not a certified production deployment**. Integrate with Qorlla's existing identity, Numbers & Plans, engine and payment provider before launch.

## Scope
- Admin and staff role authorization
- Support ticket intake, assignment, and status updates
- Immutable ticket event history
- External calling purchase requests held pending authoritative entitlement/payment verification

## Run
1. Provision PostgreSQL and apply `schema.sql` using a migration role.
2. Install dependencies: `npm install`.
3. Set `DATABASE_URL`, `JWT_ISSUER`, `JWT_AUDIENCE`, `JWKS_URI`.
4. Run `npm start`.

## Security caveats
- JWT verification must use your actual issuer JWKS, never a hardcoded secret.
- Use private network connections to Qorlla's service authority.
- A payment request is **not** a payment and must not activate PSTN or assign numbers.
- Run database migrations with a separate role; app role must not own tables.
- Add production-grade monitoring, rate limiting, tenancy checks, CI, integration tests and external security review before deploying.
