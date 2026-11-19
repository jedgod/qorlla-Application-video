# Qorlla Phone-to-Meet v2.2: server-authoritative hand-off (local test stack only)

Branch `feature/phone-meet-v22`, built from `b174984` (v2.1). The v2.2 commit `00ba3d1` named in the brief does not exist in any local worktree or on GitHub, so this was built from v2.1, not recovered.
**Verdict: NO-GO for production.** Not pushed, merged or deployed. See "Not verified" first.

## What changed

| Area | Change |
|---|---|
| Migration | `qorlla-voice-engine/sql/021_phone_meet_handoff.sql` (+ `sql/rollback/021_phone_meet_handoff.down.sql`, manual). One table `voice_handoffs`; a partial unique index allows at most ONE open (pending / accepted / completing) hand-off per call. Numbered 021 on purpose: the unpushed QGICS branch already uses 020. |
| Engine | `src/handoff.mjs` (new), routes in `src/app.mjs`: `POST /v1/voice/calls/:id/move/{start,accept,ready,complete,cancel}`, `GET /v1/voice/calls/:id/move`, and the Meet-facing `POST /v1/shield/meet/handoff-media` (workload scope `meet.signal`). `src/move.mjs` (v2.1, in-memory) is kept only for its unit test and is no longer used by the routes. |
| Meet | `server/index.js`: socket event `handoff-media` (admitted participant of a signed-in account, integer counters, ~2/s, only when the meeting is linked to a Portal meeting). `server/shield-client.mjs`: `handoffMedia()` with the existing workload credential. `public/app.js`: with `ph=1` in the address it reports its inbound-audio counter over its own authenticated socket; read-only probe `window.__qorllaMeetProbe`. |
| Portal | `qorlla.html`: the move is a server-driven loop (poll state, no client decision to end the call), PATCH the new meeting to no waiting room, `ph=1` on the Meet window, resume after a page reload, Open meeting button fix. |

## Lifecycle (all in PostgreSQL)

1. **start** (initiator): call live and caller a member; Shield `callGuard` (verified, not suspended, same organisation); single-use token stored as SHA-256; fail closed (`503`) when `VOICE_MOVE_REQUIRE_SHIELD=true` but enforcement is off.
2. **accept** (recipient): ONE atomic `UPDATE ... WHERE token_hash AND recipient AND status='pending' AND not expired` consumes the token (exactly one of any number of parallel accepts wins; a wrong-call or wrong-person attempt cannot burn it); Shield asked again.
3. **evidence**: Meet's server vouches for each admitted session (default and production source). A page-reported source with a per-side HMAC nonce exists but is OFF unless `VOICE_MOVE_ACCEPT_BROWSER_EVIDENCE=true`. Evidence counts only if bound to the hand-off meeting and ONE stable Meet session, with the counter GROWING between two reports the server itself received >= 1 s apart; it must be fresh (<= `VOICE_MOVE_FRESH_MS`, default 10 s) for BOTH sides at completion. A participant count is not used.
4. **complete** (either side, idempotent): re-checks freshness for both, call still live, Shield again; marks `completing`, the call state machine ends the call once with reason `moved_to_meeting`, then `completed`. A crash in between is finished by the next request.
5. **cancel / expiry** (token 60 s, release window 120 s by default): the phone call is never touched; clients see the state and restore their microphones.

Audit: every decision is a `shield_events` row (`move.transition`: START, ACCEPT, COMPLETE, DENY with reason); tokens and nonces are never written.

## Tests (actually run, on this machine)

* Engine, real PostgreSQL, Shield enforcement on, two engine instances on one database: `test/handoff.pg.test.mjs` **9/9** (migration + rollback + re-apply; happy path with five concurrent completes across two instances ending the call exactly once; premature-release attempts: unbound, wrong nonce/meeting/clock, bad values, zero, flat, shrinking, session change, stale; 8 parallel accepts -> one winner; 8 concurrent starts -> one open row; timeout and cancel leave the call untouched; Shield refusal at accept and completion, fail-closed when required but off; restart and simulated crash recovery; evidence source rules: browser route off by default, Meet-vouched path, workload-only). `test/move.pg.test.mjs` (v2.1 route tests) **5/5**, `core.test.mjs` and `client.test.mjs` pass (37 tests in the combined run, 2 failures there were a stale v2.1 expectation and a ring-timeout flake, both fixed and re-run green).
* Browser, two real Chromium sessions with fake media, real main app, real Voice Engine, **real Qorlla Meet** (own PostgreSQL schema, 33 migrations applied, started with a Shield workload key the engine trusts): `tests/phone-meet-handoff.spec.js`
  * *both join the SAME Meet room, hear each other, the server then ends the phone call once with the reason* — **passed** (a lone participant never released it; both Meet sessions in one meeting with different participant ids; inbound audio > 0 on both; call ended exactly once, `moved_to_meeting`).
  * *premature release impossible: B agrees but never joins* — **passed** (call carries on, microphones restored, hand-off expired by the server).
  * *refresh recovery: B reloads mid hand-off, resumes from the server's record, completes* — **passed when run alone (twice); failed in two of three full serial runs**, each time during test SETUP (the phone call stayed on "Calling…", or the ask dialog did not appear) after two long scenarios on a loaded machine. Treat as **flaky**, not green.
* Regression: `tests/phone-video.spec.js` **6/6** against the v2.2 engine; phone layout check passes at 360, 390 and 1280 px.

## Not verified (incomplete, per the acceptance rules)

1. **Cross-network / TURN**: not tested here (the relay-only attempt in v2.1 did not connect, same cause not resolved). Nothing about other networks is proven.
2. **Mobile browsers and physical devices**: not tested. By design the move is refused on phones (the meeting would replace the page and end the call).
3. **Refresh/crash scenario** is flaky in the full serial run (above). Browser crash itself (as opposed to a reload) was not tested.
4. **Meet admission**: both people are admitted through the existing Portal -> Meet bridge (signed-in accounts, no waiting room, no guests), and Meet vouches by participant record. The Portal's meeting is created without a password; there is no separate Meet-side check that the two admitted accounts are exactly the two on the call (the engine does check that the vouched accounts are initiator/recipient).
5. **meet-sync worker**: not touched; the hand-off uses instant meetings, which that worker does not carry.
6. **Evidence is client-measured**: the byte counter comes from the participant's own browser inside Meet; the server verifies growth over time, binding and freshness, not the media. Synthetic (fake) media does not prove real devices.
7. **Rate limits are per engine instance** (in memory); the database rules (unique open hand-off, atomic token) hold across instances.
8. **Live local stack not redeployed**: nothing in `qlaunch-voice` / `qlaunch_main` was rebuilt for v2.2 (no approval requested yet); everything above ran on scratch processes.
9. Shield enforcement for the live engine is a configuration (`SHIELD_ENFORCE`, `VOICE_MOVE_REQUIRE_SHIELD=true`) that the local live engine does not have.

## Rollback

`sql/rollback/021_phone_meet_handoff.down.sql` drops only `voice_handoffs` (calls and events untouched); take a `pg_dump` first. Code rollback = check out `b174984`. Setting `QORLLA_PHONE_MOVE_TO_MEETING=false` hides the feature in the Portal.

## Run it

Meet with a workload key: `node scripts/phone-meet-test-meet.cjs` (needs a Meet database with the `qorlla-meet-video/sql` migrations and `.dev-stack/secrets.json`; writes the JWKS the spec serves). Engine: `VOICE_TEST_DATABASE_URL=<scratch pg> node --test test/handoff.pg.test.mjs`. Browser: `QORLLA_TEST_VOICE_DB=<scratch pg> npx playwright test tests/phone-meet-handoff.spec.js --project=chromium`.
