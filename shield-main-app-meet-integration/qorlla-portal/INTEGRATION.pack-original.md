# Qorlla Workplace v4.1 — shared authentication integration

## Trust boundary
This pack implements **portal-side verification**, not MAIN login. MAIN must already authenticate users, provide a public JWKS containing its **public** signing keys, and issue a signed short-lived JWT as an HttpOnly cookie named `qorlla_portal_session`. It must have `iss` matching MAIN_AUTH_ISSUER, `aud` equal to `qorlla-workplace`, UUID `sub` matching MAIN user IDs, `iat`, `exp` <= 15 minutes after issue, and a rotating `kid`. Sign only with RS256 or ES256; never use shared HMAC secrets. The portal rejects missing/expired/invalid JWTs and does not accept identity headers. Token revocation before expiry requires an additional MAIN session-introspection/revocation mechanism; not included.

## Deployment
Reverse proxy MAIN, the pricing page, and the portal on the **same HTTPS origin**. Map `/app/` to the portal UI and `/api/v1/` to its API. Keep MAIN's existing `/index.html` and Meet routes unchanged. Restrict JWKS URL to the operator-configured MAIN endpoint. Protect proxy upstream ports from public network access. Set `PORTAL_ALLOWED_ORIGIN` to the exact public origin. Cookies require Secure, SameSite=Lax or Strict, and appropriate Path/Domain; use Path=/ if APIs and app are on the same origin. The MAIN login handler should set the `qorlla_portal_session` cookie, and a separate unpredictable `qorlla_csrf` token cookie (not HttpOnly) bound to the authenticated session; regenerate both on login/session rotation, expire both on logout. The browser sends the CSRF token as X-CSRF-Token for writes. Avoid `localStorage` for access tokens. Set Content-Security-Policy appropriate to the deployed app.

## Workspace identity
`portal.members.user_id` must reference the **same UUID** as MAIN's authenticated user. MAIN's existing workspace/account mapping must be reconciled by migration; never seed development users into production. The optional `X-Workspace-Id` header is only a selector and is checked against database membership. No workspace is trusted from the JWT or browser. All private APIs require membership.

## Known limitations and mandatory follow-up
- This is a portal-side adapter. The actual MAIN authentication, JWKS publishing, token issuance, session renewal and logout wiring cannot be completed without the MAIN repository.
- Current portal has no full role matrix beyond membership. Add role-specific authorization for admin and billing mutations.
- CSRF double-submit protection here relies on strict same-origin and secure cookie settings; MAIN must bind the CSRF cookie to the session or use a signed CSRF token to resist cookie injection from sibling subdomains.
- Existing portal uses a permissive Content Security Policy setting; harden it for production.
- Product/pricing public cross-origin allowlisting from the previously described pricing integration must be reconciled with this base package before deploying.
- Do not claim production readiness until real MAIN sessions, proxy routing, revocation/logout, browser tests and security review pass.

## Quick checks
`npm install && npm run check && npm test`
Run `sql/001_portal.sql` against a disposable PostgreSQL instance, then set the `.env` values and start the portal. Without MAIN auth configured, private endpoints return 503. With configuration but no cookie, they return 401. With a valid signed token but no membership, they return 403.
