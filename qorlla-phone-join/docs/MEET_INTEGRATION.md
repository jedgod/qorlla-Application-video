# Telephone admission and Qorlla Meet: integration (milestone A3)

Status: **telephone dial-in is BLOCKED.** No carrier, no SIP/RTP media gateway, no public number, no production flag, no deployment. This milestone closes the Meet-side authorization, state and readiness gaps found in the
first integration pass; the gateway itself is a separate, separately gated piece of work.

Two branches carry this work (same repository, two worktrees):

| Branch | Holds | Why separate |
|---|---|---|
| `feature/qorlla-meet-telephone-admission` | this package: admission, ledger, gateway auth, rate limit, Meet/Shield clients, readiness client, media contract, reaper, tests | where the starter was committed |
| `feature/qorlla-meet-telephone-admission-meet` | the Meet-side changes (`qorlla-meet-video`: lifecycle, gateway identity, readiness, directory, sweeper, tests) | this branch only holds an **old, non-runnable Meet snapshot** (`shield-main-app-meet-integration/`); the current Meet (shield client, workload signing, host controls) lives in the other worktree's tree, branched from the pushed `495c21e` |

## What changed in Meet

1. **A PIN is not a connection (release-critical).** `verifyCall` used to mark the caller connected (participant online, room told, recording counting them) as soon as the PIN was right. Now
   `REQUESTED -> VERIFIED -> AWAITING_HOST -> APPROVED -> MEDIA_CONNECTING -> MEDIA_CONNECTED -> TERMINATED`, plus `REFUSED`, `TIMED_OUT`, `CANCELLED`, `ORPHANED`
   (`server/phone-lifecycle.mjs`, `sql/v4_24_phone_lifecycle.sql`). `verify` answers `approved` or `waiting`, never `connected`. Only a media report that passes **Meet's own** judgement connects a caller: live, fresh,
   encrypted, packets in **both** directions for long enough, an allowed codec, the one-time media token, the meeting still open, and the Security Shield still allowing. The database enforces it
   (`status='connected'` requires `state='MEDIA_CONNECTED'`; `MEDIA_CONNECTED` requires `media_verified_at`). Existing `connected` rows are ended (`legacy_unverified_media`): they never had verified audio.
2. **Security Shield for telephone callers.** Meet asked the Shield only for signalling sessions. It now asks before approval, again before connecting, and on a timer for every open call
   (`shieldSweep`); a revocation hangs the call up immediately; an unreachable Shield refuses new calls and calls that are not yet connected at once, and ends an already-connected call at the outage deadline (120 s, measured from the first failed recheck). In gateway mode the Shield is mandatory even if `SHIELD_MEET_ENFORCE` is off. A5.5: the Shield also refuses a suspended host or organization, a telephone call is refused in a meeting without a registered owner, and these rules are exercised against the REAL Shield (see docs/A4_SIP_MEDIA_GATEWAY.md, Gate A5.5).
3. **The gateway's own identity** (`server/phone-gateway-auth.mjs`): the ES256 workload token Meet already uses, but with its **own audience** (`qorlla-phone-gateway`), **subjects mapped server-side to scopes**
   (`phone.verify|consent|media|end|decision|health|readiness`: a token valid for another operation does not authorise this one), per-issuer keys with **kid rotation**, single-use `jti` and a **request budget in PostgreSQL**
   (shared by every replica), a body hash on POST, and mTLS binding (`cnf x5t#S256`) on by default. Gateway mode is off unless configured *and* `PHONE_GATEWAY_ENABLED=true`; admission then needs all six readiness conditions.
4. **Readiness from authority** (`TelephonyService.phoneReadiness`, `GET /api/phone/ivr/readiness`): each condition is computed from stored, **fresh** evidence (carrier health and signed webhook, certified dial-in
   numbers, a gateway heartbeat, an installed and certified bridge, reconciled billing, an explicit `production` gate). Missing, stale or malformed is false. A fifth release gate (`production`) was added.
5. **Durable, bounded host decision** (`GET /api/phone/ivr/calls/:ref/decision?waitMs=`, `POST /api/phone/ivr/status`): state in PostgreSQL, long-poll capped at 20 s and 200 waiters, silence becomes `TIMED_OUT`, the media token is handed
   over once. **Directory** (`GET /api/integrations/phone/meetings/:number`, bridge secret): number -> meeting + scheduled-meeting id, one-to-one by construction (`external_meeting_links`: `meeting_id UNIQUE`, `PRIMARY KEY (source_system, source_id)`).
6. **Timeouts and recovery in Meet**: approval, media and stale-media timeouts, late media for an ended call (`ORPHANED`, audit, Shield report; audio after a *confirmed* hang-up is audited too), unconfirmed hang-ups retried and
   escalated to `ORPHANED`, an append-only `phone_call_events` history, and a sweeper timer. All ages are computed by the database (the application and database clocks need not agree).

## What changed in this package

`MeetPhoneAuthority` now speaks the new contract (workload identity or the provider HMAC), never accepts `connected` from a PIN step, uses the durable decision, and reports media; `meetConfirmedBridge` makes `MEDIA_CONNECTED`
require **two agreeing judges** (this gateway's check and Meet's); `startMediaKeepAlive` keeps calls proven; `MeetReadiness` reads the six conditions from Meet and fails closed (stale, malformed, slow, failing: all false);
`MeetDirectoryClient`; `startReaper` + `PostgresCallLedger.sessionOf` for crash recovery; a leg that finishes starting after its admission gave up is stopped **and reported to Meet**; `AbortSignal` cancellation and the PostgreSQL call ledger
from the previous milestone are unchanged.

## Test evidence

| Where | Count | Against |
|---|---|---|
| Meet `tests/phone-lifecycle.pg.test.mjs` | 36 | the real `phone.mjs` and gateway auth on real PostgreSQL, real ES256 tokens, real mutual TLS (OpenSSL certificates) |
| Meet `tests/phone-server.pg.test.mjs` | 2 | the real Meet **server process** (`server/index.js`): routes, bridge auth, directory, readiness, the sweeper timer, gateway mode failing closed |
| this package | 104 (29 original + 75) | PostgreSQL, Redis, a **killed** gateway process, and the **real Meet server** (`real-meet.e2e.test.ts`) |
| Meet `tests/phone.spec.js` | updated, **not run here** | needs the dev stack; its dial-in block already failed in this environment before the change (main's `/start` returns no Meet URL) |

Not exercised: the Shield's own dev-stack integration suite (Main App + Meet + engine) against these changes, the Twilio/IVR path (no bridge exists), any real carrier or phone.

## Readiness matrix

| Condition | Authoritative source in Meet | Evidence that must be fresh | Today |
|---|---|---|---|
| carrierConnected | `qphone_provider_status` + a configured carrier | API health <= 15 min, signed webhook <= 30 days | **false** (no carrier) |
| inboundNumberCertified | active `dialin` numbers + `dialin` gate + `PHONE_FEATURES` flag | gate <= 90 days | **false** |
| gatewayHealthy | `phone_gateway_health` heartbeat (gateway-signed) | <= 60 s | **false** (no gateway) |
| mediaBridgeCertified | an installed bridge (`bridge.ready`) + `bridge` gate + flag | gate <= 90 days | **false** (`UnconfiguredBridge`) |
| billingCertified | `billing` gate + flag + reconciled usage | gate <= 90 days | **false** |
| productionApproved | `production` gate (operator, with evidence) + flag | gate <= 90 days | **false** |

## Findings that remain open

1. **Meet's own rate limiter is per process.** The global `express-rate-limit` counters use the default in-memory store. The new gateway endpoints are protected by a PostgreSQL budget shared by all replicas; the older
   limiters were not changed. PIN-attempt lockouts were already in PostgreSQL.
2. **Inbound mTLS needs a TLS-terminating deployment that exposes the client certificate.** Meet's server does not terminate TLS itself. `PHONE_GATEWAY_REQUIRE_MTLS` defaults to true, so behind a plain proxy gateway
   authentication fails closed until TLS (or a proxy that forwards the verified certificate in a form Meet is changed to trust) is arranged.
3. **The signed `verify` route for a real gateway.** In gateway mode it is authenticated by the gateway token; the carrier (Twilio) path still goes through the IVR/TwiML and needs a bridge that does not exist.
4. **Host approval is still not push.** It is a durable, bounded long-poll, which is the bounded notification mechanism; there is no event stream.
5. `ivr.mjs` was adapted to the `approved` semantics but cannot be executed (no bridge).

## Still BLOCKED (infrastructure and certification)

- an authorised carrier / SIP trunk, certified inbound numbers, SIP ingress (TLS/SRTP, DTMF/IVR);
- the SIP/RTP-to-WebRTC media gateway implementing `MediaGateway`: nothing in this repository produces real audio evidence;
- production secrets, the gateway key registry and mTLS certificates, Redis with TLS and a password, restricted database roles for the `phone_join_*` and `phone_gateway_*` tables;
- scheduling and alert routing for the reaper (`startReaper`), the Meet sweeper and orphan alerts in a real deployment;
- billing certification, regulatory/anti-fraud/emergency-number handling, accessibility and privacy review;
- end-to-end tests with physical phones, failure injection and load.

Public numbers, PSTN, carrier calling and telephony billing stay OFF. Nothing here advertises a reference number as dial-in, reports `MEDIA_CONNECTED` without verified audio, or admits when a dependency is unavailable.

## Running the tests

```bash
docker run -d --name pj-pg -e POSTGRES_PASSWORD=pj -p 35439:5432 postgres:16-alpine
docker run -d --name pj-redis -p 36379:6379 redis:7-alpine
export PHONE_JOIN_TEST_DATABASE_URL=postgres://postgres:pj@127.0.0.1:35439/postgres
export PHONE_JOIN_TEST_REDIS_URL=redis://127.0.0.1:36379
export MEET_SERVER_DIR=<path to qorlla-meet-video on feature/qorlla-meet-telephone-admission-meet>
npm test        # 104 tests; without the variables the 28 that need PostgreSQL, Redis or Meet are skipped, and reported as skipped
# in the Meet tree:  PHONE_TEST_DATABASE_URL=...  node --test tests/phone-lifecycle.pg.test.mjs tests/phone-server.pg.test.mjs
```
