# Qorlla Portal v4.1 Shared Auth

This package extends the v4 portal with a **MAIN-signed JWT verification adapter**, workspace membership authorization, and CSRF checks. Read [INTEGRATION.md](INTEGRATION.md) before deployment. The MAIN-side token issuer is not included because its source and identity schema were not supplied.

Run `npm install`, `npm run check`, `npm test`. Configure `.env` and PostgreSQL per `sql/001_portal.sql`. No development identity fallback exists.
