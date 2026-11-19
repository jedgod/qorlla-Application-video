# Qorlla Phone Video v2.1: network, security and meeting hand-off (local test stack only)

Status: **NO-GO for production.** The Shield-authorised transition and its denial tests are done and pass; real-network TURN video, mobile browsers and a two-person admission into one Meet room are not proven. Nothing here was merged, deployed to production or applied to a production database.

## What was built

| Area | Change |
|---|---|
| Engine | `qorlla-voice-engine/src/move.mjs` and two routes: `POST /v1/voice/calls/:id/move/start` and `.../move/accept`. The decision is server-side: the call must be live and the caller a member; the Shield (`callGuard`: verified, not suspended, same organisation) is asked at start **and again at accept**; a 24-byte token bound to {call, initiator, recipient, meeting} is minted (60 s, single use, only its SHA-256 is kept, spent before the answer leaves); per-account rate limit; every decision goes to `shield_events` (`move.transition`) without the token. |
| Page | The move no longer opens a Meet page and ends the call. Order: host creates the meeting (`allowGuests:false`) -> engine `move/start` -> token to the other person over the call's data channel -> they accept -> engine `move/accept` (own session) -> both get **Open meeting** -> the host's page polls `GET /api/meetings/:id/move-status` (Meet's own count of people in the room) -> only when two are in the room does the host send `move_release` and both phone calls end. If that does not happen in 120 s the move is cancelled and the phone call simply carries on. Phone microphones are muted during the move (no second capture) and unmuted on cancel. |
| Compatibility | Both pages announce `caps {move:2}` on the control channel; the host refuses to start a move unless the other side announced it (older pages never do) and says so. On phones the move is refused (the meeting would replace the page and end the call). |
| Main app | `GET /api/meetings/:id/move-status` (host only, rate limited, returns only counts). |
| Encryption wording | The panel shows the live negotiated transport cipher (DTLS-SRTP and the SRTP suite). It never says end-to-end. |
| Flags | `QORLLA_PHONE_VIDEO`, `QORLLA_PHONE_MOVE_TO_MEETING` (default on, `false` turns off); read from `/api/voice/config`. |

## Test results

* Engine, real PostgreSQL, Shield enforcement on: `test/move.pg.test.mjs` **5/5** (happy path with audit rows; initiator cannot accept; replay; token for another call; forged and over-long tokens; expired token removed; non-participant; ended call -> 409; bad meeting ids -> 400; recipient suspended between start and accept -> refused; recipient moved to another organisation mid-call -> refused and audited; rate limit -> 429; token never in the audit trail).
* Browser, two real Chromium with fake camera/microphone, real main app and engine: `tests/phone-video.spec.js` **6/6** (video accepted / declined, Video Call (Phone), move: both asked, both get Open meeting, phone call stays and microphones are off, Stay cancels and unmutes; move declined keeps the call; replayed / forged / own token refused with 403 by the engine).
* Earlier regression: voice client tests 5/5, core tests pass, phone layout check passes at 360, 390 and 1280 px.
* `release-gate.test.mjs` could not be run in the scratch copy (missing `scripts/`); not a product failure.

## Not done / failed (do not read the verdict above as better than this)

1. **Real-network TURN video: FAILED to connect, not proven.** `tests/phone-video-turn.spec.js` forces `iceTransportPolicy=relay` against the local coturn. Both browsers stayed on "Reconnecting audio" (three ICE restarts) and never connected. Likely cause (not confirmed): both peers and coturn are on one machine behind Docker NAT, so relay-to-relay traffic hairpins and coturn's peer permissions do not match. This says nothing good or bad about TURN in general; it means the test needs a coturn reachable from a second network (or a host-network coturn). No candidate-pair evidence was produced. TURN credential expiry and ICE restart over relay were not tested.
2. **Mobile browsers:** only the installed Android app (WebView) was used earlier for a direct video call. No Android Chrome, iOS, backgrounding, incoming-call-while-backgrounded, or front/rear switching was tested. A "Switch camera" action exists but was not tried with two cameras.
3. **Two people actually in the same Meet room:** not run. The Meet-side pieces (open, join, count) exist but the release depends on Meet reporting two people online; this was not exercised with two real Meet sessions. The release is decided by the host's page, so a guest cannot verify it independently.
4. **Shield on the live local engine:** the running `qlaunch-voice` container has no `SHIELD_*` settings, so on the live local stack the Shield check is skipped (membership, token, expiry and replay checks still apply). The Shield denials above were proven only in the test engine with enforcement on.
5. **Token storage** is in the engine process (fail closed on restart); several engine replicas would need it in PostgreSQL first.
6. **"Media connectivity before release"** is approximated by Meet's participant count, not by measuring media inside the meeting.

## Files changed

`qorlla-voice-engine/src/move.mjs` (new), `qorlla-voice-engine/src/app.mjs`, `qorlla-voice-engine/web/VoiceClient.mjs`, `qorlla-voice-engine/test/move.pg.test.mjs` (new), `server.js`, `qorlla.html`, `tests/phone-video.spec.js`, `tests/phone-video-turn.spec.js` (new), this document.

## Rollback

Images tagged before this change: `qlaunch-voice-engine:rollback-pre-move`, `qlaunch-workspace-signaling-engine:rollback-pre-move` (earlier: `rollback-pre-phone-video`, `rollback-pre-video-flags`). Database and data backups: `qlaunch-backups/2026-11-14-chat-v21/qlaunch-{main,voice}-db-pre-phone-video.dump`, `qlaunch-workspace-data-pre-phone-video.tgz`. To roll back: retag the rollback images as `:local` (voice) / `:latest` (main), recreate `qlaunch-voice` (`docker run` with the same network `qlaunch-voice-net`, port `127.0.0.1:4600`, `host.docker.internal:host-gateway`, same env) and `qlaunch_main` with the usual compose command. No schema migration was added, so no database rollback is needed.
