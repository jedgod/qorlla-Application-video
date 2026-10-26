# Qorlla Workplace v4.1 - authentication, billing and hosting contract

This document is the contract between **MAIN** (accounts, sessions), the **Workplace Portal**, the **pricing page**, **Meet** and **nginx**. It describes what is implemented in this repository and what is not. (The original pack notes are kept in `INTEGRATION.pack-original.md`.)

## 1. Identity (one account system)

MAIN (`auth.js`) remains the only place where people sign in. There is **no second user table**: portal membership is keyed on the same UUID as the MAIN account (`u_<uuid>` -> `<uuid>`).

```
browser --sign in--> MAIN /api/auth/login
MAIN sets:  qs                     opaque session (HttpOnly, 30 days, stored only as SHA-256)           [existing]
            qorlla_portal_session  RS256 JWT, HttpOnly; Secure; SameSite=Lax; Max-Age=900
            qorlla_csrf            random value, readable by page script, same flags, Max-Age=900
browser --> /api/v1/* (portal)  --JWT verified against MAIN's JWKS--> --session still alive? (introspection)--> membership in PostgreSQL
```

JWT claims: `iss` (= `MAIN_AUTH_ISSUER`, the public origin), `aud` = `qorlla-workplace`, `sub` = account UUID, `iat`/`exp` (<= 15 min), `sid` = SHA-256 of the MAIN session token (never the token), `csrf` = SHA-256 of the CSRF cookie value, `jti`.

| Concern | Mechanism |
|---|---|
| Verification | portal fetches `GET /.well-known/jwks.json` from MAIN (public keys only), accepts RS256/ES256, checks issuer, audience, expiry, max age 15 min |
| Logout / password change | `sid` is checked against `GET /api/auth/internal/session/<sid>` on MAIN (Bearer `PORTAL_INTROSPECTION_SECRET`, answers cached 5 s). A logged-out or revoked session stops working immediately, not after 15 minutes. MAIN also clears both cookies. Production **requires** this check (fail closed). |
| Renewal | the page calls `POST /api/auth/portal-token` (same origin, needs the live MAIN session) when the portal answers 401; renewal fails for dead sessions |
| CSRF | portal writes need: `Origin` == `PORTAL_ALLOWED_ORIGIN`, no `Sec-Fetch-Site: cross-site`, header `X-CSRF-Token` == cookie **and** SHA-256(header) == the `csrf` claim inside the signed JWT (so a cookie planted by a sibling sub-domain is useless) |
| Key management | RSA-2048 key pair generated on first start in `DATA_DIR/auth/portal-jwt-keys.json` (encrypted at rest when `ENCRYPT_KEY` is set) or supplied via `PORTAL_JWT_PRIVATE_KEY_PEM`; `rotate()` keeps the old public key in the JWKS for 24 h |
| Fail closed | until `MAIN_AUTH_ISSUER`, `MAIN_AUTH_JWKS_URL`, `PORTAL_ALLOWED_ORIGIN` (and, in production, the introspection URL/secret) are set, every private endpoint returns **503**. No cookie -> 401. Valid identity without membership -> 403. There is no development identity anywhere in the code. |

### Workspaces and roles
`POST /api/v1/workspaces` (signed-in user, no membership needed) creates a workspace with the caller as `owner` on the free Basic plan. Roles: `owner`, `admin`, `billing`, `member`.

| Action | owner | admin | billing | member |
|---|---|---|---|---|
| read workspace data, notes, tickets | yes | yes | yes | yes |
| create notes / tickets (plan limits apply) | yes | yes | yes | yes |
| rename workspace, add/remove members | yes | yes | no | no |
| promote to owner | yes | no | no | no |
| checkout, cancel, invoices | yes | yes | yes | no |
| reconcile with the provider | yes | yes | no | no |

The last owner cannot be removed or demoted. All queries are filtered by the workspace chosen from **database membership** (`X-Workspace-Id` is only a selector and is verified).

## 2. Billing

* **Catalogue** `portal.plans` + `portal.plan_prices` (per seat, per period, minor units; monthly and annual are separate rows) + `portal.entitlements`. `GET /api/v1/plans` is the single source for the pricing page and for checkout. Seed prices are the ones the old pricing page showed ($16.99 / $14.99-per-month-annual, $21.99 / $18.33): **confirm them before enabling payments**.
* **Provider**: Stripe (Checkout Sessions, subscription mode). `BILLING_ENABLED=true` + `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` are all required, otherwise checkout answers 503 `billing_unavailable` and the pricing page disables the Buy buttons with an explanation. A **live** key (`sk_live_`/`rk_live_`) additionally needs `BILLING_LIVE_AUTHORIZED=yes-i-authorize-real-payments`. No payment collection is enabled by this repository.
* **Checkout** is created server-side from the database price (the browser can send only plan, interval, seats). A row in `portal.checkout_sessions` snapshots amount/currency/interval/seats.
* **Activation** happens only when a webhook passes **all** of: (1) Stripe HMAC signature over the **raw** body, timestamp within 5 minutes; (2) event not seen before (`portal.billing_events` primary key); (3) it is `invoice.paid` with `amount_paid > 0`; (4) the subscription is **re-read from the provider API** and is `active`/`trialing`; (5) its metadata maps to a checkout session we created, and the provider-side price, currency, interval and seat count equal our snapshot; (6) the checkout was not already bound to another subscription. `checkout.session.completed`, the success redirect and the browser never activate anything.
* **Lifecycle**: renewals; `invoice.payment_failed` -> `past_due` (7 day retry grace, then Basic and `expired`); `customer.subscription.updated/deleted`; `charge.refunded` -> invoice `refunded`/`partially_refunded` + `portal.refunds` (a refund never silently removes access); out-of-order events are ignored via `last_event_at`; `POST /api/v1/billing/reconcile` re-reads the provider; `cancel` asks the provider to cancel at period end.
* **Entitlements** are computed in PostgreSQL (`portal.workspace_effective_plan`) and enforced in the API (`notes.max`, `members.max`, metered `ai.queries_per_month`); `meet.max_minutes` / `meet.max_participants` are exposed via `GET /api/v1/entitlements` but **Meet does not enforce them yet**.

**Not verified against the real provider.** All automated billing tests run against a local test double (`tests/fake-stripe.mjs`) that mimics the endpoints used. A Stripe test-mode account, webhook endpoint and a recorded end-to-end run are still required before enabling payments.

## 3. Hosting (one HTTPS origin)

nginx (`deploy/nginx/`) routes: `/` MAIN pages and `/api/*`; `/api/v1/*` and `/app/*` portal; `/pricing/` the static pricing application; `/meet/` Meet (prefix stripped, WebSocket upgrade on `/meet/socket.io/`); `/.well-known/jwks.json` MAIN. **Never public:** `/api/auth/internal/*`, `/meet/api/integrations/*`, `/meet/api/ready`. All upstream addresses are environment-driven; the pricing page and portal use same-origin relative URLs (no hard-coded ports). JSON access logs, `/healthz`, restart policies and container healthchecks are in `docker-compose.yml`.

See `docs/RUNBOOK.md` for deployment, TLS, enabling billing, key rotation and rollback.

## 4. Known limitations (honest list)
* Real-provider checkout/webhooks unverified (above). Plan *changes* (upgrade/downgrade between paid plans) are not implemented: a workspace with a paid plan must cancel first.
* Tax, coupons, multiple currencies and invoicing details beyond the provider's hosted invoice are out of scope.
* The Meet service does not yet enforce plan limits.
* Portal members are added by account UUID (no directory lookup / invitations yet).
* The 5 s introspection cache means a revoked session can still be accepted for up to 5 seconds.
* The JWT private key lives on MAIN's data volume (encrypted only if `ENCRYPT_KEY` is set); use `PORTAL_JWT_PRIVATE_KEY_PEM` from a secret manager in production.
