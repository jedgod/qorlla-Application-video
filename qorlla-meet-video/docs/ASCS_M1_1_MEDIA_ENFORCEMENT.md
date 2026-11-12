# ASCS-M1.1 — Server-enforced presenter revocation and media security: assessment

Branch `feature/qorlla-ascs-v1-v2` (continues commit `2710281`, PR #8 stays a **Draft**). Nothing here is pushed, merged, tagged or deployed; `qlaunch` was not touched; `ASCS_ENABLED` is still **off by default**.

## 1. Verdict

**NO-GO** for claiming that "Stop presenting" is *enforced* against an uncooperative client, and NO-GO for production.

* **Server authority over share state is now closed** (what the server records, announces, renews, and who can start): see §4. This part is GO for continued development.
* **Media enforcement is NOT closed.** Meet has no media server. A client that ignores the revoke message keeps delivering its screen. This was **measured**, not assumed (§3, evidence 1).
* Closing it needs new infrastructure and a change to the page's media layer. Your rule applies: *"if server-enforced revocation requires substantial architectural changes, stop after the architecture assessment and report the alternatives before implementation."* So the media-enforcement mechanism is **not built**; §5 lays out the alternatives and what decision is needed.

## 2. Architecture findings

1. **Meet is a full-mesh peer-to-peer WebRTC design with no SFU and no media server.** One `RTCPeerConnection` per remote participant; the server relays signalling only (`socket.on('signal')`). Stated in `docs/TELEPHONY_BRIDGE_ARCHITECTURE.md`, `docs/A371_MEDIA_SECURITY.md` ("there is no SFU in this repository") and in the header of the Shield integration test ("there is no media server in this repository, so media access is the Meet signaling session — the only gate that exists").
2. **Shield** (served by the voice engine, `/v1/shield/meet/*`) decides whether an *admitted participant may keep a signalling session*. Meet re-checks every few seconds (`startSessionGuard`) and, on denial, disconnects the socket and marks the participant `denied`. Shield has no authority over media.
3. **TURN today (Meet): stateless REST credentials** (`username = <expiry>:<participantId>`, HMAC), default TTL 1 h, up to 4 h. They **cannot be revoked before they expire**. `ICE_TRANSPORT_POLICY=relay` is a global switch.
4. **Reusable enforcement infrastructure exists, but only in the voice engine** (`qorlla-voice-engine/src/turn.mjs`, A3.7.1): coturn with `--lt-cred-mech --redis-userdb --cli`, per-account credentials in Redis, revoke = delete credential + cancel live allocations through the coturn admin CLI. Its own report measures 0 packets after suspension and a 122 ms stop. In `rest` mode the same module can cancel allocations by the `:<participantId>` suffix, which is exactly Meet's credential format. It is **not integrated with Meet**.
5. **A relay is content-agnostic and per-allocation.** In the mesh, a shared screen travels on the *same* connection as the person's camera (`replaceTrack` on the video sender). A relay can end a person's whole allocation; it cannot tell a screen from a camera.

## 3. Measured evidence (this branch, this machine)

| # | Experiment | Result |
|---|---|---|
| 1 | **Malicious presenter, peer to peer.** A guest page tampered to ignore every stop message. Host clicks *Stop presenting* and *Stop sharing*. | Server: share `revoked`, heartbeat → 409, new start → 403, host list shows nobody presenting. **Media: the host still decoded 61 new video frames in 4 s (~15 fps).** *The gap is real.* (`tests/e2e/ascs-browser.e2e.mjs`, section F) |
| 2 | **TURN-only, two real browsers.** Own coturn (REST + CLI), `ICE_TRANSPORT_POLICY=relay`. | Screen reaches the host (320 px); selected candidate pair is `relay`; the relay lists the presenter's allocation by `:<participantId>`. (section T) |
| 3 | **Relay-level termination.** Server cancels the presenter's allocation through the coturn CLI. | Frames stop (< 8 frames in 3 s, vs ~15 fps before). **Evidence that unauthorized forwarding stops at the relay.** |
| 4 | **Recovery with a still-valid REST credential.** | **Media resumed after 15 s**: the client re-allocated. Cancelling allocations alone is *not durable*; the credential itself must be revocable (the A3.7.1 `userdb` mode). |
| 5 | **Environment finding.** A TURN server on a **loopback** address (`127.0.0.1`) is never used by Chromium: ICE gathering completes immediately with no candidates and the coturn sees no request. A LAN address works. Matters for any local/CI relay test. | |

Not measurable here: media-gateway failure (there is no gateway), relay behaviour across real networks, other browsers.

## 4. What was implemented (no new architecture needed)

| Gap | Change | Proven by |
|---|---|---|
| A permission change could fail **silently** and leave an unauthorized share active | One `allowedNow()` check (still admitted + still permitted; **any lookup error = no**) used by reconcile, the heartbeat and the signalling gate. Reconcile retries; if it still cannot be done the host's request returns **503** ("could not be confirmed ... will be ended automatically") instead of success | server tests: *fail closed*, *failure injection (DB down)*, *failure injection (permission lookup throws)* |
| A missed reconcile (failure, restart, another code path) was never corrected | The sweeper now also audits the invariant "every live share belongs to someone allowed" for **all** meetings (`reconcileAll`) | *a missed reconcile is corrected ... by a brand-new instance (a restart)* |
| A presenter who is no longer allowed could keep renewing | Heartbeat re-checks authority and ends the share; the signalling gate refuses to announce it | *fail closed* test |
| A vanished presenter kept the share for a whole lease | Disconnect cuts the lease to a grace period (`ASCS_DISCONNECT_GRACE_MS`, default 8 s); a reconnect within it keeps the share | *disconnected clients* test |
| Meeting end waited for the sweeper | The end route ends shares immediately | the sweep path is tested; the **route itself is wired but not exercised by an automated test** |
| Shield suspension ended the session but not the share | `startSessionGuard` calls `onRevoked`, which reconciles that meeting (backstops: the gate refuses the person at once, the disconnect cuts the lease, the sweeper audits) | **real-Shield integration test**, with a mutation check (below) |
| Simultaneous presenters across processes | Row lock + unique index hold across **two live server instances** on one database | *two live instances* test |
| A client that ignores everything | Server side: no renewal, no start, no announce after revoke + withdrawal; replaying the old request id does not resurrect it | *malicious client (server side)* test |

Behaviour decisions to know: *Stop presenting* ends the **current** share; the person may start again while still permitted (to stop abuse, withdraw permission). A suspended or denied person's token is useless (`member` refuses it).

### Real-Shield test and its mutation check
`qorlla-voice-engine/test/shield-integration.pg.test.mjs` (real Main App, real Meet, real Voice Engine as Shield, real PostgreSQL) gained one test: a verified presenter shares, the Shield suspends the account, and the share must end with the session.
With the hook the share ended **1.2–4 s** after the revocation (`participant_removed`; two measured runs). With the hook **removed** the same test **fails** (the row stays `active` for the 60 s sweep that the harness configures; the gate and heartbeat still refuse the person). That makes the test a real check of the hook, not a bystander. The harness's Meet schema list was extended with `v4_19`–`v4_23` and `ASCS_ENABLED`/`ASCS_SWEEP_MS=60000` were added to its Meet processes (additive).

**Honest state of the full-file runs on this machine.** The file's *existing* tests are load-sensitive here: the **unmodified harness on the pristine PR head (`2710281`, none of the M1.1 changes) failed 2 of 9 and 3 of 9 in two back-to-back full-file runs** (tests 6 and 9, and test 3 in the second). With the M1.1 changes the failing set was {6, 9}, {6, my test}, {2, 6, 9, my test} across three full-file runs: different tests each time, all timing based. The same tests pass when run alone. My new test passes alone every time (3 of 3, one of them under the mutation check as designed to fail) but **did fail in two full-file runs** (timeout under load); its timeouts were widened afterwards (40 s / 45 s) and **it has not been re-run inside a full-file run since**. Treat "Shield integration: green" as **proven in isolation, not stable in the full file on this machine**.

## 5. Alternatives for real media enforcement (decision needed)

| | A. SFU (LiveKit / mediasoup) | B. Relay-enforced **share channel** on coturn | C. Hardening only (done) |
|---|---|---|---|
| What enforces | The SFU forwards only authorized publications; revoke = stop forwarding / unpublish. Works whatever the presenter's browser does | The share rides a **dedicated, relay-only connection** with **share-scoped credentials** held in coturn's user database; revoke = delete the credential + cancel allocations (the A3.7.1 mechanism); an ICE restart with a deleted credential fails | Server refuses and records; pages are asked to stop |
| Stops an uncooperative presenter's *share channel* | **Yes** | **Yes** (proven in principle by §3 evidence 3; durability needs the userdb credential) | **No** (§3 evidence 1) |
| Stops the same screen sent as the presenter's **camera** track | Only by controlling publications (yes: camera is a normal track, but screen-like content is indistinguishable) | **No** (peer-to-peer camera path is untouched) | No |
| Scope | Rewrite Meet's media layer (`createPeer`, signalling, recording), new infrastructure, re-certification of **all** meetings; also enables server-side recording and >6 participants | Dedicated share connection per viewer in the page (moderate client change), coturn in `userdb` + CLI mode with Redis (secrets, network isolation, TLS), a port of `turn.mjs` into Meet's server, relay bandwidth for the share (presenter upload × viewers) | None further |
| Size | Large | Medium | — |

**Recommendation:** B first, *if* the product accepts (a) the share being relayed (bandwidth) and (b) that a malicious presenter can still push screen-like frames through their ordinary camera path (the existing "remove participant" is then the escalation, and it ends all of that person's media). Plan A as the real target when meetings regularly exceed ~6 participants or server-side recording is wanted (the telephony architecture doc already says to re-evaluate then). **Please choose A or B (or accept C) before I implement media enforcement.**

## 6. Required validation — status

| Requirement | Status |
|---|---|
| Real PostgreSQL authorization and lifecycle tests | **Done** — `tests/ascs.test.mjs`, 28 tests on a real PostgreSQL (34 of 34 with the 6 existing Meet tests) |
| Real Shield integration tests | **Done in isolation, not stable in the full file here** — real Main App + Meet + Shield + PostgreSQL; new ASCS test with a mutation check. Existing tests 3, 6, 9 also fail intermittently on this machine **without** my changes (see above) |
| Two-client WebRTC transmission and revocation | **Done** — sections A–F and D, **48 of 48 checks** in the final clean run; revocation of *media* is shown **not enforced** (F: 60 frames in 4 s after revoke) |
| TURN-only | **Done for Chromium, one machine, own coturn over a LAN address** (section T, 5 of 5 in its own run; it needs a coturn and is skipped in the default run) |
| Media-forwarding termination evidence | **Relay-level evidence only**, not integrated into Meet (section T) |
| Recovery and failure injection | **Server side done** (DB unavailable, permission lookup broken, restart, disconnect). **Media-gateway failure: not applicable** (no gateway). PostgreSQL restart/failover drill: **not done** |
| Normal camera, microphone, screen sharing, guest participation | **Pass** — sections A–E and D (flag off), in the same 48-check run |

Two earlier browser runs failed in sections E/F while the test database was visibly stalled (a `DROP DATABASE` waiting on a hung backend, autovacuum late); on a restarted database and a healthy machine the full run passed. Treat the browser suite as **sensitive to machine load** as well.

## 7. Remaining blockers (in your stated order)
1. **Media enforcement** (this document): needs the A/B decision.
2. Transactional outbox / reliable event delivery — not started.
3. Portal subscription entitlement enforcement — not started.
4. PostgreSQL restart and migration-rollback drills — not done.
5. TURN-only across networks, Firefox, Edge, Safari — only Chromium, one machine.
6. Physical devices, accessibility, load, security certification — not started.

## 8. Reproduce
```
# Meet server suite (needs a PostgreSQL; a scratch database is created per run)
TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:25690/postgres node --test tests/ascs.test.mjs
# real browsers (sections A-F, D). ONLY=F runs one section.
PLAYWRIGHT_DIR=<dir with node_modules/playwright> TEST_PG_URL=... node tests/e2e/ascs-browser.e2e.mjs
# TURN-only section T: a coturn with --use-auth-secret --lt-cred-mech --cli published on a LAN address (NOT 127.0.0.1)
TURN_TEST_HOST=<lan ip> TURN_TEST_PORT=34781 TURN_TEST_CLI_PORT=35767 TURN_TEST_CLI_PW=... TURN_TEST_SECRET=... ONLY=T node tests/e2e/ascs-browser.e2e.mjs
# real Shield integration (needs .dev-stack/secrets.json with jwt, bridge, escrow, recordingKey; root and engine node_modules). ASCS test alone: --test-name-pattern="ASCS-M1.1"
cd qorlla-voice-engine && VOICE_TEST_DATABASE_URL=... node --test test/shield-integration.pg.test.mjs
```
