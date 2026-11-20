# Qorlla Phone-to-Meet v2.3: reliability and recovery (release candidate, local test stack only)

**Verdict: NO-GO for production.** v2.3 is a locally committed, locally tested reliability release candidate. It was never pushed, merged or deployed, and no live service (`qlaunch-*`) was touched. What it proves is server logic and browser flow on one machine with synthetic media. Real microphones and cameras, other networks, TURN, mobile browsers and several engine replicas are **not** proven (section 8, and `docs/PHONE_MEET_TURN_DEVICE_PLAN.md`).

Builds on `docs/PHONE_MEET_V2_2.md` (the PostgreSQL-backed hand-off lifecycle, migration 021). Read that document for the lifecycle and the evidence rule.

## 1. What changed in v2.3 and why

| # | Problem (as observed) | Root cause | Fix |
|---|---|---|---|
| 1 | The caller sometimes stayed on "Calling..." forever. | The "answered" event could reach the caller's page **before** the response to its own dial request; the page ignored a state event for a call it did not yet know. | `web/VoiceClient.mjs` keeps early state events and replays them after `dial()` returns (test "RACE (v2.3)"). |
| 2 | Hand-off readiness sometimes arrived too late, and the 8 s evidence window was missed. | Concurrent evidence reports for one hand-off took a row lock each (`SELECT ... FOR UPDATE`), so they queued behind each other: a lock convoy. The throttled Docker PostgreSQL used for part of the testing was also about 300 times slower than a native one, which made it visible. | `readyFromMeet` in `src/handoff.mjs` now reads without a lock and writes with one **compare-and-set** `UPDATE` (the row must still be `accepted`, before its deadline, with the session and last report we read, and the call must still be active). Up to 3 attempts; an unchanged report writes nothing; after 3 lost races the answer is `busy` and the next report retries. Reports are idempotent. The evidence rule itself is a pure function (`evidenceStep`), unchanged: growth of at least `minGrowth` between server-received reports at least 1 s apart, fresh within `VOICE_MOVE_FRESH_MS` (8 s, **not raised**) for **both** sides. |
| 3 | An internal failure while checking a workload credential was reported as `401`. | One `catch` for everything. | `src/shield.mjs`: real authentication failures (jose error codes) stay `401`; an internal failure (database, JWKS) is `503 workload_check_unavailable` and is logged. Slow checks (`slow_workload_request`) are logged with the step that was slow. |
| 4 | The Meet server sometimes reported "hand-off media report failed ... timeout" and could stack up reports. | Reports were fired every tick whether or not the previous one had finished. | `server/index.js` of Meet: one report in flight per socket (`hoBusy`); the warning now includes the elapsed milliseconds. |
| 5 | A reload of the guest during a pending invitation lost the invitation. | The invitation lived only in the page. | The host re-offers a still-pending request (every 4 s while the control channel is open) and the guest gets it again from the server record. |
| 6 | The Portal sometimes sent a person into the **built-in** room instead of Meet, which would navigate the page away and drop the phone call. | The "is Meet running" probe asked with an 800 ms limit and a single slow answer was read as "Meet is gone". | `meet-probe.js`: a failed answer inside a 60 s grace period keeps the last good address and asks again soon; Portal: during a move it never opens the built-in room (start and join paths show a retry message instead); `meetHandoff` refuses (503) for a meeting that already lives in Meet or has a waiting room rather than routing it to the built-in room. |
| 7 | When Meet was really down, the person saw raw text such as `fetch failed` or `Meet refused the registration (500)`, or advice to "turn the waiting room off" (which means leaving for another room). | `doStart` passed the internal error message to the browser. | `server.js` returns only "Qorlla Meet is not reachable right now. Try again in a moment."; the technical reason stays in the log. In the Portal, during a move the message is always "Qorlla Meet could not be reached. Your phone call is still connected. Try again." |
| 8 | Test suite: one failure hid the others; browser contexts piled up; the 5 s ring timeout expired before the click on a slow machine. | `serial` mode, no cleanup, production ring timeout in the test engine. | Scenarios are independent (`mode: 'default'`), every context is closed after each scenario, and the **test engine only** runs with `VOICE_RING_SECONDS=60` (production ring policy unchanged). |

No timeouts were extended and no assertions were weakened to obtain a pass. Two test-harness start-up waits were lengthened because they only bound how long to wait for a child process to start on a loaded machine: the engine readiness wait in `tests/support/voice-stack.js` (20 s to 60 s) and the web server start timeout in `playwright.config.js` (30 s to 120 s). No test assertion uses either.

## 2. Architecture (unchanged shape, hardened behavior)

```
Portal (qorlla.html)  <-- ws -->  Voice Engine (PostgreSQL, outbox, Shield)  <-- workload JWT (meet.signal) --  Meet server (Socket.IO)
      |                                   ^   voice_handoffs (migration 021)                                     ^
      | Open meeting -> /api/meetings/:id/start | /api/guest/sessions                                            |
      +--> main app (server.js) --> Meet (create/join, one-time hand-off code) -------> Meet page (ph=1) reports inbound-audio counters
```

- The **server's record decides**. A reload of any page re-reads the call and hand-off state; it never ends the call. The phone call is ended once, by the server, with reason `moved_to_meeting`, only after fresh, session-bound media evidence from **both** sides in the **same** Meet session.
- All hand-off state is in PostgreSQL (`voice_handoffs`), so several engine instances agree and a restart loses nothing. Retries, duplicate or delayed reports and concurrent engine instances cannot end a call early: the release is a compare-and-set that requires both sides' fresh evidence and the `accepted` status, and ending the call is itself guarded to happen once (tests: "MEET REPORTS (v2.3)", the 10-hand-off and move suites).
- Authentication, tenant isolation and Shield enforcement are unchanged (Shield authorize at start, accept and completion; workload JWT scope `meet.signal` with a single-use `jti`; mutual TLS tests rerun).

## 3. Meet-outage handling

If Qorlla Meet is unreachable during a hand-off:

1. **Before anyone is in Meet** (host presses Open meeting): the start request fails; the dialog stays open with everything typed and a **Retry** button, shows "Qorlla Meet could not be reached. Your phone call is still connected. Try again.", opens no other window and never the built-in room. The guest keeps the hand-off bar.
2. **A meeting that already lives in Meet** (host inside, Meet goes down, guest presses Join): the main app answers 503 "Qorlla Meet is not reachable right now. Try again in a moment."; the Portal shows the retry message; the guest page stays on the Portal. The hand-off record stays `accepted`.
3. **The phone call** is a separate path (Voice Engine) and is not touched by a Meet outage: it stays `active` on the server, with media connected on both sides. The server records no end event.
4. **Recovery**: when Meet returns, pressing the dialog's own button retries; both people end in the same Meet room, evidence is collected, and the call ends once with `moved_to_meeting`. The host's Meet page also recovers without a manual rejoin (after a Meet restart, once the host was fully inside).
5. Short blips: the Meet probe keeps the last good address for 60 s, so a single slow answer does not change behavior.

Regression tests: the two `MEET OUTAGE` scenarios in `tests/phone-meet-handoff.spec.js` (they stop and restart the **test** Meet process through `scripts/phone-meet-test-meet.cjs`, which keeps its throw-away signing key in the temp folder so the engine's JWKS stays valid).

## 4. Database requirements

- **No new migration in v2.3.** The release uses migration `qorlla-voice-engine/sql/021_phone_meet_handoff.sql` and its existing rollback `qorlla-voice-engine/sql/rollback/021_phone_meet_handoff.down.sql`, unchanged since v2.2. Verified: `git diff 2ef443a -- qorlla-voice-engine/sql qorlla-meet-video/sql` is empty and no `.sql` file is modified or untracked in the working tree. The compare-and-set uses only the existing `voice_handoffs` columns (`status`, `release_deadline`, `init_session/recip_session`, `init_last/recip_last`, `*_ready_at`, `version`) and the primary key.
- Meet needs its own migrations (through `v4_31_breakout_classroom`) for the Meet socket gate to authorize participants; the test lists in `shield-integration.pg.test.mjs` and `mtls-processes.pg.test.mjs` were updated to match (they had gone stale, which was a test-data problem, not an authorization weakness: a missing Meet table fails closed).
- The deployment target is **PostgreSQL 16** (compose files, `qlaunch-voice-db`). The compare-and-set uses `IS NOT DISTINCT FROM` with `jsonb` comparison and `timestamptz` parameters: all available in 16. Migration, rollback and re-apply were run on PostgreSQL 16 (see section 6).
- Behavior under lock contention: the evidence path takes no row lock and no advisory lock; it never blocks on another report.

## 5. Rollback

- **Code**: check out the v2.2 commit `2ef443a` (or `2ec6006` for the first v2.3 step). The feature can be hidden without a deploy by `QORLLA_PHONE_MOVE_TO_MEETING=false`.
- **Database**: nothing to roll back for v2.3 itself. To remove the hand-off feature entirely (v2.2 and later), take a `pg_dump`, then run `qorlla-voice-engine/sql/rollback/021_phone_meet_handoff.down.sql` (`DROP TABLE IF EXISTS voice_handoffs;`, idempotent, manual, never run by `db:migrate`). Calls and events are untouched. The v2.3 code does not need the table to exist for plain phone calls.
- **Test helpers** write only to the temp folder and scratch databases.

## 6. Test evidence (actually run on this machine, after the last code change)

**Environment.** Windows 11 development machine, CPU saturated by unrelated work (cloud sync, a build daemon), scratch PostgreSQL 18 (native, port 25691) for the engine and Meet databases, a disposable `redis:7-alpine` container for the Redis tests, Chromium with fake media. PostgreSQL 16 (the deployment version) was used only through a throttled Docker container (section 8, item 8).

| Suite | Result |
|---|---|
| Browser, `tests/phone-meet-handoff.spec.js`, 14 scenarios (incl. 7 recovery, network drop, browser-process crash, 2 Meet-outage), 3 consecutive full runs | **14/14, 14/14, 14/14** (8.5, 9.2, 8.7 min). Meet-to-engine report timeouts per run: 0, 1, 0. Accepted-to-media-ready: 22.1 s, 19.3 s, 26.7 s (scenario 1). |
| Browser, earlier 12-scenario loop (before the two outage scenarios), 10 consecutive runs | 10 of 10 runs passed 12/12 (0 failures, 0 retries); 5 cumulative Meet-to-engine timeouts. |
| Engine, every test file run on its own (31 files) | **209 tests: 204 pass, 0 fail, 5 skipped.** The 5 skips are `turn-control.pg.test.mjs`, which needs the coturn/Redis containers of `scripts/a371-turn-up.sh` (not run). Includes `handoff.pg` 10/10, `move.pg` 5/5, `shield-integration.pg` 9/9, `mtls-processes.pg` 3/3, `mtls.pg` 5/5, `shield.pg` 8/8, `workload-check` 3/3, `client` 6/6 (incl. RACE), `distributed.redis` 7/7, `redis-tls` 3/3. |
| Engine, all files in one `node --test` invocation | **Not a valid result on this machine**: under load, 38 tests skipped ("no PostgreSQL reachable": the helper's 2.5 s connection check timed out) and 2 Redis-TLS tests failed; the same files pass when run alone. A skip is not a pass and is not counted as one. |
| Unit, `npm run test:unit` | 4/4 (`unit/meet-probe.test.mjs`). The script used a directory argument that Node 22 does not accept; it now uses `unit/*.test.mjs`. |
| PostgreSQL 16 (throttled Docker) | migration 021, rollback and re-apply pass; the "MEET REPORTS (v2.3)" test passes; two timing-sensitive hand-off tests fail only because that database was about 300 times slower than a native one (thresholds untouched). |

Two more problems found and fixed while closing out: the new RACE test left an SDK client connected, which kept its process alive (`t.after(() => c.disconnect())`); and stale test data (Meet migration list, an old reason label) made three Meet-through-Shield and three mTLS tests fail in earlier runs (test data only; a missing Meet table fails closed).

## 7. Redis event ordering (investigation)

**Question:** is the failing "ordering end to end" test (event 46 delivered to Bob's socket before event 44 after Redis was stopped and restarted across two replicas) an event-ordering defect, Redis configuration, asynchronous delivery, or test infrastructure?

**Outcome: not root-caused. The test passes when run, so it is not "blocked", but the earlier failures were never explained, and the cross-replica ordering guarantee remains UNPROVEN. Treat it as an open production risk for any multi-replica deployment.**

Evidence:
- Earlier (before this closure) the test failed 3 of 3 on the v2.2 code and 2 of 2 on v2.1, and once in a full-suite run: `actual [... 43, 46, 44, 47 ...]` against `expected [... 43, 44, 46, 47 ...]`, always at the Redis restart boundary. Those runs were made when this machine, and the throttled Docker PostgreSQL, were heavily loaded.
- In this closure, on a native PostgreSQL 18 and a fresh Redis container, the test passed in every run: 1 isolated, 5 in a repeat loop, 1 more under three busy-loop processes, 3 more as part of whole-file runs (at least 10 passes, 0 failures). Under heavier load (six busy loops, or the throttled Docker database) the run could not finish in the time allowed, so it neither passed nor failed there: no reproduction was obtained.
- The test file was also coupled to its first test (`ext`, the extensions, is set by the "DR-06" test); run alone it fails with `http_401` for that reason, which is test infrastructure, not the defect.
- Code reading (not proven by a failing trace): the outbox claims only the head of each account's queue, so publish order per account is correct, and event ids are assigned under a per-account advisory lock, so id order equals commit order. What is **not** guaranteed is arrival order at a socket on another replica: `PUBLISH` returns when Redis accepts the message, not when the other replica has received it, and the next event of the same account can be delivered locally by the other replica's own worker first. Also `bus.up` reflects the publisher connection only, not whether this replica's subscriber has re-subscribed after a Redis restart. Both are candidate mechanisms for 46-before-44; neither was confirmed.
- Existing mitigations (not a fix): clients de-duplicate by event id, ignore an older event for a finished call, and reconcile with the server snapshot after reconnect (`client.test.mjs`: "the browser still refuses a late or older event ...").

Changes: none to the assertion. The test now prints, on failure, the arrival order at Bob, each outbox row with its retries, and which worker held it, so the next occurrence yields a trace instead of a guess. A design fix would carry the previous event id of the account in each bus envelope and make the receiving replica hold back a later event until the earlier one has been delivered or fetched from the database; that was not attempted because it changes delivery semantics and cannot be validated without a reproduction.

## 8. Limitations and unresolved production blockers

1. **Not proven on real hardware or networks**: synthetic (fake) microphone and camera in Chromium on one machine; no TURN relay, no second network, no mobile browser. Plan: `docs/PHONE_MEET_TURN_DEVICE_PLAN.md` (not executed).
2. **Media evidence is client-measured**: the byte counter comes from the participant's own browser inside Meet; the server verifies growth, session binding and freshness, not the media.
3. **Hand-off latency** (accepted to media-ready) was 17 to 35 s on this loaded machine, which is long for a real user.
4. **Meet admission is not restricted server-side to exactly the two call participants** (the hand-off meeting uses the normal Meet admission rules). Open.
5. **Rate limits are per engine instance** (in memory); the database rules hold across instances.
6. **Redis ordering across replicas**: one intermittent failure that is not root-caused (section 7). Open for any multi-replica deployment.
7. **Meet-to-engine evidence reports occasionally time out** (about 4 s abort) on this machine, which is CPU-saturated by unrelated work (cloud sync, build daemons); each was a single dropped report and the next one succeeded, but the rate on real infrastructure is unknown.
8. **PostgreSQL 16 timing tests** that depend on hand-off timing could not be judged on the throttled Docker database; they pass on a native PostgreSQL 18. They must be repeated on an unthrottled 16 before release.
9. **meet-sync worker** untouched; the hand-off uses instant meetings that worker does not carry.
10. The Meet socket gate fails closed with a generic error when a Meet migration is missing (safe, but not diagnosable by the user).
11. Not redeployed: nothing in `qlaunch-voice` / `qlaunch_main` was rebuilt, and Shield enforcement for the live engine is a configuration the local live engine does not have.
12. Production stays **NO-GO** until the gates in `docs/PHONE_MEET_TURN_DEVICE_PLAN.md` section 9 are satisfied with real evidence.

## 9. Run it

- Scratch PostgreSQL (any 16+ instance you may create schemas in): `VOICE_TEST_DATABASE_URL=<url>` for the engine tests, `QORLLA_TEST_VOICE_DB=<url>` for the browser tests.
- Meet with a workload key: `QORLLA_TEST_MEET_DATABASE_URL=<meet db> node scripts/phone-meet-test-meet.cjs` (writes the JWKS the spec serves, keeps the throw-away key and the process id in the temp folder; the Meet database needs `qorlla-meet-video/sql` applied and `.dev-stack/secrets.json` must exist).
- Browser suite (14 scenarios): `QORLLA_TEST_MEET_DATABASE_URL=<meet db> QORLLA_TEST_VOICE_DB=<scratch pg> npx playwright test tests/phone-meet-handoff.spec.js --project=chromium --workers=1` (the outage scenarios restart the test Meet through the script, so pass the same Meet database).
- Unit: `npm run test:unit`. Engine: `cd qorlla-voice-engine && VOICE_TEST_DATABASE_URL=<scratch pg> node --test test/`.
