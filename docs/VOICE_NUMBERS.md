# Telephone numbers for accounts (v1.12, scaffold): how the number pack was adopted

**Status: implemented as a fail-closed scaffold; NOT part of the RC2 baseline; not enabled anywhere; no carrier connected.** Nothing here places or receives a telephone call. This lives on the local branch `wip/voice-numbers` until the owner decides how it relates to the existing telephony module (question 1 below).

## What it is
A number is an **optional attribute of an existing voice identity**, never a routing key. The engine still routes by extension only (see [VOICE_IDENTITY_AND_DISCOVERY.md](VOICE_IDENTITY_AND_DISCOVERY.md)). The module records which carrier-controlled number belongs to which account, drives the request through a provider adapter, and only treats a number as active when the provider's **signed** event says so.

## How the supplied pack was adapted (and why)
| The pack | Here | Reason |
|---|---|---|
| Its own `voice_identities` (UUID user, extension `QRL-123456789`) | Reuses the engine's `voice_identities` (account id, 3-8 digit extension) | The pack's own README says not to create a parallel account authority; its extension format would also bypass the emergency-number reservation |
| TypeScript + Fastify service on its own port and tables (`voice_outbox`, `voice_audit_events`...) | An ES-module in the engine, tables prefixed `voice_num_*` (`sql/010_numbers.sql`) | Its table names collide with the engine's (`voice_outbox`, `voice_identities`); one process, one database, one auth path |
| Own JWKS authentication | The engine's existing authentication | Same issuer/audience as every other route |
| Enabled once configured; countries default `US,GB` | Off unless `VOICE_NUMBERS_ENABLED=true`; **no country until `VOICE_NUMBERS_COUNTRIES` names it** | Fail closed |
| Mock provider switched on by config | Mock only when `VOICE_NUMBERS_PROVIDER=mock`, and **refused when `NODE_ENV=production`**; any other value (including `twilio`) is refused until a real adapter exists | A test double must not be able to "activate" a production number |
| Webhook: HMAC over the body only | HMAC over `timestamp.body`, timestamp must be within `VOICE_NUMBERS_REPLAY_SECONDS` (300 s) | Replay protection (the pack lists it as missing) |
| Idempotency key returns the first result whatever the request | The same key with a **different** request is refused (`idempotency_key_reused`, 422) | Pack gate 9 |
| Dead outbox job leaves the assignment "pending" for ever | After the retry limit the assignment becomes `failed` and the number is quarantined for an administrator | A person is never left waiting on "pending" |
| Audit append-only against UPDATE/DELETE | Also blocks TRUNCATE | The pack's README asked for no runtime UPDATE/DELETE |
| Country evidence: table only | Recorded only by an administrator (server to server); an IP-derived suggestion is stored but never qualifies; expired evidence never qualifies; there is no user route that writes evidence | "Never trust a client-submitted country" |
| `libphonenumber-js` used only in a test | Used to validate every imported number: valid E.164 **of the stated country** | A mislabelled number is the classic inventory mistake |
| Extension endpoint `POST /v1/voice/identity` | Not adopted: identities are provisioned by the main app through the admin API | One authority for identities |
| Number returned to its owner at once | A pending request shows only the country; the number is shown once the provider has confirmed it (active/suspended/release pending) | Do not show a number that may not exist yet |

## API (all refused with 503 `numbers_disabled` unless enabled)
- `GET /v1/voice/numbers/me`: own extension and number state (`Cache-Control: private, no-store`).
- `POST /v1/voice/numbers/assign` `{ "country": "US" }` with a UUID `Idempotency-Key` header: 202 pending, 200 for a retry of the same request.
- `POST /v1/voice/numbers/release`: 202 `release_pending`.
- `POST /v1/voice/numbers/provider-events`: raw body, `x-qorlla-timestamp`, `x-qorlla-signature`; events `number.activated`, `number.released`, `number.suspended`, `number.provision_failed`; rate-limited; 16 KB limit.
- Admin (server to server): `POST /v1/voice/admin/numbers/evidence`, `POST /v1/voice/admin/numbers/inventory`, `GET /v1/voice/admin/numbers/summary`; metrics `qorlla_voice_numbers_queued|dead|stuck_pending|quarantined`.

State machine: `pending -> active -> suspended`, `active -> release_pending -> released` (number to **quarantine**, never straight back to available), `pending -> failed`. Out-of-order or repeated provider events never move a number backwards.

## Configuration
`VOICE_NUMBERS_ENABLED`, `VOICE_NUMBERS_COUNTRIES`, `VOICE_NUMBERS_WEBHOOK_SECRET` (>= 32 chars, else events are refused), `VOICE_NUMBERS_PROVIDER` (`disabled` default; `mock` for tests), `VOICE_NUMBERS_WORKER` (only meaningful with a provider that is not `disabled`), `VOICE_NUMBERS_REPLAY_SECONDS`, `VOICE_NUMBERS_MAX_ATTEMPTS`.

## Verified (real PostgreSQL, over HTTP; 9 tests, `test/numbers.pg.test.mjs`)
Strict configuration; off by default (every route, the admin routes and the webhook answer 503 and nothing is written); inventory validation (not E.164, wrong country, duplicates); evidence rules (IP guess, expired, unverified, unknown account, no user route); assignment guards and idempotency; the number hidden while pending; submission is not activation; webhook guards (wrong secret, tampered body, old/future timestamp, missing signature, unknown assignment, wrong number, out-of-order event, oversize body, duplicates); release to quarantine; races (3 claimants for 1 number, 6 simultaneous requests by 1 account, and the database refusing two live owners); provider failure ends in `failed` + quarantine and does not strand the person; append-only audit (update, delete, truncate); a number appears in no history, directory or call list, and the engine never routes a phone number.

## The pack's ten completion gates: status
1. **Shared identity, no parallel authority:** done (reuses the engine's identities).
2. **Provider inventory import and eligibility:** partial. Administrators import numbers with E.164 + country validation; nothing is provider-specific; per-country number-type policy is not set.
3. **Real carrier adapter and webhook scheme:** **not done.** The HMAC-with-timestamp scheme is a demonstration contract; the default provider refuses everything.
4. **Reconciliation for uncertain outcomes:** partial. Dead jobs fail the request and quarantine the number, and `stuck_pending` is a metric; there is no carrier reconciliation for lost callbacks or expired leases.
5. **Quarantine/recycling policy, fraud, portability, billing, taxes, emergency calling, lawful intercept, retention, privacy:** partial. Released numbers are quarantined; the rest is **not done**. Account suspension does **not** release a number (an administrator decides).
6. **Inbound DID-to-extension routing and outbound PSTN authorization in the voice engine:** **not done** (and out of scope here).
7. **Infrastructure hardening:** partial. The least-privilege role cannot alter or truncate the number tables; the audit guard is a trigger, not tamper-proofing; no mTLS or key rotation.
8. **Safe multi-worker claim:** `FOR UPDATE SKIP LOCKED` with a 2-minute lease; **not load-tested** under slow provider calls.
9. **End-to-end tests for races, idempotency reuse, replay, spoofing, retries, failures, evidence expiry:** done for everything that exists without a carrier; "country portability" and "rollback" are not covered.
10. **Country-by-country legal and carrier certification:** **not done.**

## Decisions the owner must make before this is used
1. **Which system is the authority for numbers?** The repository already has a telephony module (provider adapter, Numbers & Plans administration, certification gates) whose inventory and provisioning overlap this one. Two number authorities would disagree. Either this module becomes the voice engine's *record of assignment to an account* fed by that module, or it is retired in favour of it.
2. Whether a number is used only for discovery (the decision record's recommendation) or also for sign-in (not recommended).
3. The carrier, its webhook scheme, and who pays.
4. Emergency calling: required in the markets served? If yes, no number may be activated without it.
5. What happens to a number when an account is suspended or closed.

## Not wired
No change to the Phone page, `voice.js` or the main app. No lookup-by-number route (the decision record specifies exact-match, opt-in, rate-limited lookup; it is not built).
