# Qorlla Voice Engine v1.0 + v1.1 (self-hosted internet calls)

One-to-one voice calls between Qorlla accounts over the internet. No Twilio, no carrier account. This does **not** call ordinary mobile or landline numbers; that needs a separate public-telephone connection.

**Status: development foundation. NOT production ready** (see "Not done").

## Parts
| Part | Where |
|---|---|
| Voice engine (Express + ws + PostgreSQL), port 4600 | `qorlla-voice-engine/` |
| Main-app side: ES256 token minting, JWKS, directory, SDK hosting | `voice.js`, wired in `server.js` |
| Browser UI (Phone: extension dialling, colleagues, incoming dialog, call bar, history, Diagnostics) | `qorlla.html` |
| Dev stack | `scripts/dev-stack.mjs` starts the engine, applies `sql/001` and `sql/002` |

## How it works
- The main app signs a 300 s ES256 token (iss `qorlla-main`, aud `qorlla-voice`) with a key kept in `DATA_DIR/voice-signing.json`; the engine verifies it against `/.well-known/voice-jwks.json`. The private key never leaves the main app.
- Each account gets an extension (from 2000). Dial 3-8 digits without `+` in the Phone Dial Pad.
- Signaling WebSocket uses a one-use ticket: 32 random bytes, only the SHA-256 hash stored, 45 s lifetime, bound to account and origin, consumed atomically. It travels in the `Sec-WebSocket-Protocol` header, not the URL.
- SDP/ICE is relayed only for an accepted (`active`) call; offers only from the caller, answers only from the callee.
- Calls ring 60 s (`VOICE_RING_SECONDS`), then become `missed` with an audit event. One live call per account is enforced in the database.
- Usage and call length are measured by the server (answered to ended), never taken from clients.
- The microphone opens only when a call is started/answered and is stopped when it ends.

## Configuration (engine)
`PORT`, `DATABASE_URL`, `VOICE_JWKS_URL`, `VOICE_JWT_ISSUER`, `VOICE_JWT_AUDIENCE`, `VOICE_ALLOWED_ORIGIN` (exact origins, comma separated), `VOICE_ADMIN_SECRET` (>= 32 chars, else admin API returns 503), `VOICE_WS_QUERY_TICKET=off` (disable the `?ticket=` fallback in production), `VOICE_RING_SECONDS`, `STUN_URL`, `TURN_URLS` + `TURN_SHARED_SECRET` (coturn REST credentials). No public STUN default is used.
Main app: `VOICE_ADMIN_SECRET` (same value), `VOICE_PORT` or `VOICE_URL` (public engine URL), `VOICE_INTERNAL_URL`. With no secret, Voice is off and the Phone page says it is not set up.

## Deploying
Run the engine behind TLS (wss). Do not log query strings at the proxy. Deploy coturn for calls across different networks and set `TURN_*`.

## Verified
- Engine: 47 unit/integration tests (real PostgreSQL schema, real JWKS, real sockets): ticket replay/expiry/origin, concurrency races, relay rules, ring timeout, suspension, ICE config.
- `tests/voice-engine.spec.js` (5 tests, Chromium): two real browsers hold a real WebRTC call with a synthetic microphone: ring, answer, audio bytes both ways over Opus with sound energy, mute, hang-up, microphones closed afterwards, history on both sides, decline, missed, refused microphone, answering on one of two devices, busy, bad extension, own extension, accessibility (axe), no secrets in engine log, Voice-off page.
- Existing Phone, hardening and telephony suites still pass on Chromium (38 passed). One existing test ("waiting room", dial-in against the real Meet server) fails, and fails the same way on a clean HEAD checkout; it is unrelated to this work.

## Not done (blocks production)
- Reconnect, ICE restart, device leases, two-device certification (v1.2 milestone; the v1.2/v1.3 folders were not implemented).
- Group calls and Qorlla Meet media integration.
- TURN not deployed or tested; calls across different networks, real microphones/speakers, Firefox/Safari/mobile WebRTC untested.
- Single engine instance only (no Redis fan-out).
- Dev-stack restart with the engine was not run in this session; the engine and main app were exercised by the test harness instead.
- Load and security review not done.
