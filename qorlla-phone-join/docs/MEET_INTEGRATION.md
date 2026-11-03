# Telephone admission and Qorlla Meet: integration findings

Status: **integration components and tests only. Telephone dial-in is BLOCKED.** No carrier, no media gateway, no public number, no production flag. Everything below was read from the Meet source
(`qorlla-meet-video/server`) and the Shield source (`qorlla-voice-engine/src/shield.mjs`, `app.mjs`); nothing here invents an endpoint.

## What Meet already has (and this package builds on rather than replaces)

| Area | Meet today | Where |
|---|---|---|
| Phone PIN | per-meeting, 4-12 digits, scrypt verifier, shown once, revocable, separate from the web passcode | `phone.mjs` `setPin`, `verifyPin` |
| Meeting number | 11 digits, resolved by `GET /api/resolve/:code` -> `{ meetingId }` (404 = unavailable or ended) | `index.js` |
| Verification | `POST /api/phone/ivr/verify` (signed) -> `connected \| waiting \| denied \| locked`, `callRef` | `phone.mjs` `verifyCall` |
| Replay / idempotency | signature with 300 s skew, event ids stored in `phone_webhook_events` (a repeat gets the stored answer), `phone_calls` unique on `(provider, provider_call_id)` | `phone.mjs` `signed` |
| Brute force | per-caller and per-meeting counters and lockouts in PostgreSQL (`phone_attempts`), generic failure text | `phone.mjs` |
| Waiting room / host | callers are participants (`kind='phone'`), listed for the host, admitted or denied through the existing waiting-room routes; host can mute/remove (a removed caller is banned from that meeting) | `phone.mjs` `onAdmission`, `/phone/:cid/remove` |
| Ending | meeting end and PIN revocation hang every call up | `phone.mjs` `endAll` |
| Server-to-server auth | (1) bridge secret header `x-qorlla-bridge-secret` (32+ chars, constant-time) and (2) short-lived ES256 workload JWT `{iss, sub, aud, iat, exp, jti, cnf?}` with a `kid`, optionally bound to an mTLS client certificate (`cnf['x5t#S256']`) | `index.js` `bridgeAuth`; `telephony/number-sync.mjs` `signWorkloadJwt`; `telephony/workload-transport.mjs` |
| Security Shield | `POST /v1/shield/meet/{register,authorize,recheck,end}` and `/v1/shield/report` with the workload JWT (`aud` `qorlla-shield`, scope `meet.signal`); every failure is a denial | `shield-client.mjs`; engine `app.mjs`, `shield.mjs` |
| Media bridge | **interface only**: `UnconfiguredBridge` (`ready` false, `join()` throws); IVR answers "not available yet" unless `bridge.ready` and the `qphone_gates` evidence is certified | `telephony/provider.mjs`, `ivr.mjs`, `service.mjs` |

## How the pieces map

| Requirement | Component | Notes |
|---|---|---|
| Meeting authority | `MeetPhoneAuthority` (`src/meet-authority.ts`) | resolve -> signed verify -> (host wait by polling the bridge-secret `phone-calls` list) -> signed disconnect on any failure. Uses Meet's exact signature (known-answer test against Meet's own `createProvider().sign`). Session id = `<meetingUuid>.<callRef>`, so any replica can finish what another started. |
| Shared call ledger | `PostgresCallLedger` + `sql/001_phone_join.sql` | `call_id` PRIMARY KEY (one INSERT wins across replicas), validated transition table, append-only history (trigger), `reapStale` for crashed replicas (`FOR UPDATE SKIP LOCKED`), `listConnected`. A failed id is released; connected, terminating and orphaned ids never are. |
| Gateway authentication | `gatewayAuth` (`src/gateway-auth.ts`) | verifies Meet's workload-JWT format (tested against Meet's real `signWorkloadJwt`); adds audience `qorlla-phone-join`, known issuer/kid/subject, 300 s max lifetime, single-use `jti` in `PostgresReplayStore`, optional mTLS binding, and `bsh` (SHA-256 of the exact request body) on the admission POST. Real refusal reasons go to `onReject`; clients only see 401. |
| Rate limiting | `createRedisRateLimiter` (`src/rate-limit-redis.ts`) | atomic Lua window counter shared by all replicas; Redis down, slow, or odd -> 503 (never allowed); over limit -> 429 + `Retry-After`. |
| Media contract | `src/media-contract.ts` | lifecycle states, evidence (packets both ways, duration, SRTP, codec, freshness), `verifiedBridge()` turns a gateway into a `SipRtpBridge` whose `mediaEstablished` is true only when the evidence passes. |
| Shield | `ShieldClient`, `ShieldedAuthority`, `startPhoneSessionGuard` (`src/shield.ts`) | telephone callers are guests: the Shield is asked after the host has decided (and at once when no approval is needed); refusal or an unreachable Shield ends the call in Meet and is never an admission; a periodic re-check ends calls whose meeting ended, and ends all calls if the Shield stays unreachable past the grace period. |
| Cancellation | `admitTelephoneCall` | every dependency gets an `AbortSignal`; a timed-out attach is aborted, the leg is disconnected immediately, the call id stays claimed (`terminating`) while the attach may still be running, and when it finally ends any leg it created is disconnected (3 tries) - `failed` + released, or `orphaned` + `onLateMedia(..., false)` for an operator. |

## Gaps found in Meet (not fixed here: Meet is out of scope for this branch)

1. **Meet connects the caller before media exists.** `verifyCall` marks the phone participant `connected` (room told, recording counts them) as soon as the PIN is right and no waiting room applies. This package attaches
   media afterwards and ends the call in Meet if that fails, but until Meet has a "media pending" state the participant can briefly appear connected without audio.
2. **The signed verify route only exists for the test double.** `/api/phone/ivr/verify` answers 503 unless `PHONE_PROVIDER=test`; the real carrier path is the Twilio webhook -> TwiML -> `verifyCall`. A SIP gateway needs a
   provider adapter in Meet with its own signature verification; the adapter here uses the test double's scheme, so it is correct for tests and must be re-pointed at the production scheme.
3. **No endpoint maps a Meet meeting id to the main app's scheduled-meeting id**, and the call list is keyed by the latter. The deployment must supply `MeetingDirectory`.
4. **Host approval has no event or long-poll**; polling `phone-calls` with the bridge secret works but is not push.
5. **Meet does not ask the Shield about telephone callers** (it does for signalling sessions). This package does, but Meet's own Twilio/IVR path still does not.
6. **Readiness is not wired to Meet's authority.** The six flags are enforced, but the provider that fills them from `qphone_gates`, the carrier status and billing certification is not written.

## Still BLOCKED (infrastructure and certification)

- an authorised inbound carrier / SIP trunk, certified inbound numbers, and the SIP ingress (TLS/SRTP, DTMF/IVR);
- the SIP/RTP-to-WebRTC media gateway that implements `MediaGateway` (audio verified both ways, teardown, hold, recording consent);
- the Meet changes above (1-6) and a production signature scheme for the gateway path;
- production secrets, the gateway key registry (`TrustedKeys`) and mTLS certificates; Redis with TLS and a password; a PostgreSQL role limited to the `phone_join_*` tables; scheduling of `reapStale`;
- billing certification, regulatory/anti-fraud/emergency-number handling, accessibility and privacy review;
- end-to-end tests with physical phones across networks, failure injection and load.

Public numbers, PSTN and carrier calling stay OFF. This package never advertises a reference number as dial-in and never reports `MEDIA_CONNECTED` without verified audio.

## Running the integration tests

```bash
docker run -d --name pj-pg -e POSTGRES_PASSWORD=pj -p 35439:5432 postgres:16-alpine
docker run -d --name pj-redis -p 36379:6379 redis:7-alpine
export PHONE_JOIN_TEST_DATABASE_URL=postgres://postgres:pj@127.0.0.1:35439/postgres
export PHONE_JOIN_TEST_REDIS_URL=redis://127.0.0.1:36379
npm test          # 80 tests; without the two variables the 18 that need PostgreSQL or Redis are skipped (and reported as skipped)
```
The tests create and drop their own throw-away schema and Redis key prefix. `MEET_SERVER_DIR` (path of Meet's `telephony/number-sync.mjs`) enables the compatibility test against Meet's real token signer.
