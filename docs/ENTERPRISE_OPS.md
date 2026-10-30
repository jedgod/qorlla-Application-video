# Enterprise operations: Admin, Staff and customer Support, integrated into the Portal

**Status: implemented in `qorlla-portal` behind `OPS_ENABLED=false` (off by default). Tested on real PostgreSQL and in real Chromium. NOT production certified. Release remains BLOCKED; external calling, PSTN, number issue and A3.8 are untouched and off.** Branch `integration/enterprise-ops`, not merged, not pushed.

## Where it came from
`qorlla-enterprise-ops-v2` and `-phase3` were standalone monorepo starters (about 50 KB of real code in 200 files: an Express API on its own database with bearer-token login, three React shells with a token box, fail-closed adapter stubs, two SQL files). Phase 3 is a superset of v2. They were **not** merged as a service. Their useful content was extracted and rebuilt inside the Portal so it reuses the existing authentication, billing and database:

| Taken from the packages | Now |
|---|---|
| tickets, events, messages (customer vs internal), staff, shifts, time entries, refund requests, outbox, audit schema | `qorlla-portal/sql/008_enterprise_ops.sql` (+ rollback), schema `portal`, users are MAIN user ids |
| role list, permissions idea, ticket categories/priorities | `server/ops/authz.mjs`, `server/ops/index.mjs` (permissions are now **stored per staff member**, not trusted from a token) |
| refund request + independent approval | `server/ops/refunds.mjs`: executes through the **existing** billing service, reconciles against it |
| fail-closed adapters (number authority, meeting diagnostics, refund provider) | `server/ops/adapters.mjs` |
| Admin / Staff / Customer-support portals' sections | `public/ops/*` (no framework, no build step) |
| release checklist and gates | this document, `docs/evidence/enterprise-ops/` |

Deliberately **not** taken: the separate service and database, the pnpm/turbo toolchain, the paste-a-token login box (replaced by the Portal's cookie JWT + CSRF), `tenant_id` strings and free-text assignee ids (replaced by user-id foreign keys), a "refund approved, execution pending" stub (replaced by real execution), and a parallel ticket system for the `qorlla-ops/` starter on `feature/ops-control-starter`, which this supersedes.

## How it is wired (the required contracts)
| Integration | Behaviour |
|---|---|
| Admin authentication | MAIN session (cookie JWT, JWKS, live session check, CSRF on writes) **+ an active staff record with an administrator role + MFA** (`amr` contains `mfa`, `auth_time` within `OPS_MFA_MAX_AGE_SECONDS`). MFA cannot be waived in production. |
| Staff authentication | MAIN session + `portal.ops_staff` row with `employment_status='active'` + explicit permissions. Suspending or terminating staff cuts access on the next request and returns their open cases to the queue. |
| Customer authentication | MAIN session only; every query is scoped to that user id. Customers see their own cases and only customer-visible messages. |
| Ticket assignment | one transaction, row lock, audit, state machine; `claim` is a conditional update (two agents: one wins); restricted cases are visible only to the assignee and leads. |
| Workforce | shifts (no overlap), one open clock per person, hours approved by someone else, leave decided by someone else, payroll CSV of approved hours only (formula-injection safe, audited). |
| Billing | the existing billing service is the authority (`portal.invoices`, `portal.refund_requests`, `portal.refunds`); no duplicate ledger. |
| Refunds | request (billing permission, paid invoice only, amount counted against what is still refundable) -> approval by a **different** administrator with MFA (also a database CHECK) -> execution through `launch.refund` with an idempotency key derived from the request id -> reconciliation. The old single-person admin refund route answers 409 when `refundTwoPerson` is on (always on in production). |
| Number assignment | operations can only **request**, and only within `OPS_APPROVED_NUMBER_RANGES` (empty by default, so nothing). There is no issue/assign route and no status in the schema that means "issued". The Number Authority stays the sole issuer. |
| External calling | operations records a **request** and can show a read-only decision. The decision is allowed only if the PSTN gate is on **and** the invoice is paid and unrefunded **and** the Shield authorizes **and** a certified carrier exists. No code path grants anything. |
| Meetings | read-only health through an adapter (state, participant count, signaling), whitelisted and audited. No join, admit, mute, record or media route exists. |
| Deployment | separate surfaces: `/api/v1/ops/admin`, `/api/v1/ops/staff`, `/api/v1/ops/support` and pages `/ops/admin|staff|support`, behind the existing nginx gateway (`/ops/` location) and Portal auth. Off unless `OPS_ENABLED=true`. |

## Release tests (`qorlla-portal/tests/ops.test.mjs`, `ops-ui.test.mjs`, `migrations.test.mjs`)
| # | Required case | Result |
|---|---|---|
| 1 | an ordinary customer cannot access Admin or Staff endpoints | **PASSED** (also anonymous, non-admin staff, suspended and terminated staff) |
| 2 | a staff member cannot access another agent's restricted cases | **PASSED** (read, status, message, claim; list; restricted unassigned is lead-only; concurrent claim) |
| 3 | customer ticket replies cannot expose internal notes | **PASSED** (API, database CHECK, and the rendered page in Chromium; hostile HTML is shown as text and does not run) |
| 4 | a refund cannot be approved by its requester or executed twice | **PASSED** (database CHECK too; two simultaneous approvals: one; two workers: one provider call; failed refunds are not retried silently; reconciliation) |
| 5 | a payment failure cannot grant calling privileges | **PASSED** (decision function, route, database refuses any "active" status) |
| 6 | an unapproved phone-number range cannot be issued | **PASSED** (default approves nothing; only requests are recordable; no issue route; refusals audited) |
| 7 | an expired or revoked session cannot access protected operations | **PASSED** (revoked, expired, forged, wrong audience; session service down = 503) |
| 8 | a meeting support agent cannot silently join a private meeting | **PASSED** (no such route; diagnostics permissioned, whitelisted, audited) |
| 9 | Redis or PostgreSQL failure does not bypass authorization | **PostgreSQL and the session service: PASSED** (503, nothing written, recovers). **Redis: not applicable**: the Portal has no Redis dependency, so there is nothing to fail; this was not tested. |
| 10 | production deployments preserve the calling and security release gates | **PASSED** for configuration (ops off by default, gates need the exact value `true`, MFA and two-person refunds forced on in production, the gates endpoint reports `BLOCKED`, no route changes a gate). Whether the *deployed* system keeps all 15 gates blocked is a release decision, not something these tests certify. |

Regression: the complete Portal suite passes **187/187** (the 168 existing tests plus 19 new: 16 operations API/page tests, 2 real-browser tests, 1 migration test); raw output in `docs/evidence/enterprise-ops/portal-suite.tap`. The Voice Engine and main-app suites were not re-run for this branch: no engine or main-app source file changed.

## What is NOT done (honest list)
- **MAIN issues no MFA claim today**, so Admin cannot be used in a real deployment until MAIN's login emits `amr: ["mfa"]` and `auth_time`. The code fails closed until then.
- **No real provider proof:** refunds were exercised against `tests/fake-stripe.mjs` (a test double); a live Stripe account has not accepted these calls. Live verification is BLOCKED as before.
- **Adapters are interfaces:** no certified Number Authority, Shield-for-calling, carrier gateway or Meet diagnostics client is connected; they answer 503 / deny until injected. The Shield/Voice Engine and Meet projects are separate services that would implement them.
- **Two ticket systems exist:** the Portal's older workspace `portal.support_tickets` (`/api/v1/support/tickets`) and MAIN's Phone support tickets are untouched; this adds a staff-operated one. Consolidating them is a product decision.
- **Notifications, SLA timers, attachments (malware scanning), knowledge base, a customer lookup directory, payroll provider integration, RLS per workspace, per-IP limits** are not implemented. Reads are not tenant-filtered: any active staff member with the permission sees every customer's data they are permitted (no multi-tenant isolation between customers' companies).
- **Browser coverage:** Chromium only, desktop layout, no accessibility audit, not translated (English strings).
- **Refund recovery:** an `executing` refund that is stuck is resolved from billing's idempotency record or flagged `needs_review` for a person; nothing resends automatically.
- Application role privileges follow the Portal default (SELECT/INSERT/UPDATE, no DELETE); append-only tables are protected by triggers as well. A least-privilege review of a deployed database is still needed. Penetration review, load, failover and production PKI remain open as before.

## Operating it
Apply `sql/008_enterprise_ops.sql` as the migration role (idempotent; fresh databases get it from compose). Roll back with `sql/rollback/008_enterprise_ops.down.sql` **before** rolling back 002 (it drops ops data but never billing records). Set `PLATFORM_ADMIN_USER_IDS` (bootstrap only: with MFA a platform admin can create the first staff records), `OPS_ENABLED=true`, optionally `OPS_WORKER_ENABLED=true`. Tests: `cd qorlla-portal && TEST_DATABASE_ADMIN_URL=postgres://... node --test --test-concurrency=1 tests/*.test.mjs`.
