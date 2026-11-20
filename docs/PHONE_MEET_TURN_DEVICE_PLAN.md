# Phone-to-Meet: cross-network TURN and physical-device validation plan

**Status: PLAN ONLY. NOTHING IN THIS DOCUMENT HAS BEEN EXECUTED.** Every test below is BLOCKED until a person fills in real evidence. Production stays NO-GO until the gates in section 9 are met.

What the local tests (v2.3) do and do not show: they run two Chromium sessions with a synthetic microphone and camera, on one machine, through loopback. They prove the server logic and the browser flow. They do **not** prove real microphones or cameras, NAT traversal, TURN relaying, cellular or Wi-Fi roaming, mobile browsers, or a second network. The only relay evidence so far is a local coturn container (`docs/evidence/clients/turn-local-relay/README.md`: UDP relay/relay passed once on one PC; TCP relay not proven) and a Phone video relay-only spec that **failed to connect** locally (`docs/PHONE_VIDEO_V2_1.md`, item 1). Neither is evidence for a real network. Credential expiry and ICE restart over relay have never been tested.

Related documents: `docs/MEET_TURN.md` (Meet TURN configuration, relay-only mode), `docs/A371_MEDIA_SECURITY.md` and `docs/A371_FIELD_TEST_RUNBOOK.md` (F1-F8 relay, expiry, restart, suspension tests; this plan reuses and extends them), `docs/PHONE_MEET_V2_3.md` (what is being certified).

## 1. Rules for the whole exercise

1. Use a **staging** deployment that is separate from `qlaunch-*`. Do not touch the running local production-like stack. No deployment to production, no change to live networking.
2. Secrets (TURN shared secret, workload keys, JWT secrets, database passwords, TURN credentials, session tokens) are supplied through the staging host's environment or secret store only. They never go into this repository, a chat, a screenshot or a log that is attached as evidence.
3. Internal-extension calling only. `VOICE_PSTN_ENABLED=false`, `VOICE_COUNTRY_ALIAS_ENABLED=false`, `VOICE_A38_ENABLED=false`. No real phone numbers, no carrier.
4. Every result is recorded with the commit SHA of the engine, the main app and Meet. A failure is recorded as a failure with its evidence; it is not retried until it passes without an explanation.
5. Do not raise the 8 s evidence freshness threshold (`VOICE_MOVE_FRESH_MS=8000`), the ring policy or any timeout to make a test pass.

## 2. Required infrastructure

| Item | Requirement |
|---|---|
| Staging host(s) | Main app, Voice Engine and Meet reachable over **HTTPS** with a valid certificate (browsers only allow microphone and camera in a secure context). One hostname per service or a reverse proxy; record the URLs. |
| Databases | A staging PostgreSQL **16** for the engine (migrations through `021_phone_meet_handoff.sql`) and one for Meet. Never the local scratch databases. |
| TURN server (coturn) | Public IP, firewall open for UDP/TCP 3478, TLS on 5349 and/or 443 (`turns:`), and the relay port range (for example 49152-49252/UDP). `lt-cred-mech` with `use-auth-secret`, `static-auth-secret` of 32+ random characters, `fingerprint`, `no-multicast-peers`, denied private and special-use peer ranges (SSRF), `user-quota`/`total-quota`, CLI port reachable only from the engine. Full sketch: `docs/MEET_TURN.md` section 2. For the revocable mode, `TURN_AUTH_MODE=userdb` with Redis (`docs/A371_FIELD_TEST_RUNBOOK.md`). |
| Engine environment | `TURN_URLS`, the TURN secret (or the userdb variables), `TURN_CREDENTIAL_TTL_SECONDS`, `VOICE_RELAY_ONLY=true` for relay phases (the engine then tells clients `iceTransportPolicy: relay` and refuses with 503 when no relay is configured). Shield enabled for the hand-off: `SHIELD_ENABLED=true`, `VOICE_MOVE_REQUIRE_SHIELD=true`, workload JWKS for Meet. |
| Meet environment | `TURN_URLS`, `TURN_SHARED_SECRET` (same secret as coturn), `ICE_TRANSPORT_POLICY=relay` for relay phases, Shield workload key and `SHIELD_URL` pointing at the staging engine. |
| Device A | A laptop or desktop (Chrome and Edge current) on network 1 (home or office Wi-Fi, ISP 1), with a **real** microphone, speakers or headset, and camera. |
| Device B | A phone (Android Chrome and iOS Safari, one of each if possible) on network 2: **cellular data** or a different ISP, with its real microphone and camera. Not on the same Wi-Fi as device A, not on a VPN. |
| Optional device C | A third network (hotel or guest Wi-Fi with restrictive firewall) for the TCP/443-only case. |
| Accounts | Two staging accounts with Voice enabled and verified email, extensions assigned. |
| Observers | `chrome://webrtc-internals` open before each call on desktop (export the dump afterwards); remote inspection for Android (`chrome://inspect`); on iOS use the page's own stats snippet (section 4) because internals are not available. |
| Tooling | `psql` access to the staging engine database (read only), `turnutils_uclient` from the coturn package, `curl`, and a synchronized clock on all hosts (NTP). |
| Record | A run sheet: date, operator, commit SHAs, browser and OS versions, network descriptions (not addresses), TURN host name. |

## 3. Preflight (P0): run before any test

| Step | Command (placeholders in angle brackets) | Expected evidence | Pass criteria |
|---|---|---|---|
| P0.1 Services up | `curl -fsS https://<main>/api/health`, `curl -fsS https://<engine>/readyz`, `curl -fsS https://<meet>/api/health` | HTTP 200 JSON, `redis` field as configured | all three healthy |
| P0.2 Build identity | `git rev-parse HEAD` in the deployed checkout (or the image label) for each service | three SHAs in the run sheet | SHAs match the commit being certified |
| P0.3 Migrations | `psql <engine-db> -c "SELECT to_regclass('voice_handoffs')"` | `voice_handoffs` | table exists; no migration newer than 021 is required |
| P0.4 TURN reachable from outside | from a machine on network 2: `turnutils_uclient -y -u <rest-username> -w <rest-credential> <turn-host>` (credential generated for the test per `docs/MEET_TURN.md`; do not paste it anywhere) | allocation succeeds, relayed data echoed | a relay allocation is created from the outside |
| P0.5 Negative | same command with a wrong password, then with a correctly signed credential whose expiry is in the past | `401` / allocation refused for both | both refused |
| P0.6 ICE policy | start a call, then in the Portal page console: `const c = window.qorllaVoice.pc.getConfiguration(); console.log(c.iceTransportPolicy, c.iceServers.map(s => s.urls))` (never print `credential`) | `relay` when `VOICE_RELAY_ONLY=true`; the TURN URLs listed | policy matches the phase being run |

If any preflight step fails the exercise stops: nothing below is meaningful without it.

## 4. Evidence capture

**Selected candidate pair and counters (any browser, including iOS Safari).** Paste in the console of the **Portal phone page** (and of the **Meet page** during the hand-off tests), run it twice 10 s apart, and save the output (it contains no credentials):

```js
(async () => { const pc = window.qorllaVoice && window.qorllaVoice.pc; if (!pc) return 'no peer connection';
  const s = await pc.getStats(), by = {}; s.forEach((r) => { by[r.id] = r; });
  const t = [...s.values()].find((r) => r.type === 'transport' && r.selectedCandidatePairId), p = t && by[t.selectedCandidatePairId];
  const out = { time: new Date().toISOString(), state: pc.connectionState, ice: pc.iceConnectionState,
    pair: p && { state: p.state, local: by[p.localCandidateId] && by[p.localCandidateId].candidateType, remote: by[p.remoteCandidateId] && by[p.remoteCandidateId].candidateType, rtt: p.currentRoundTripTime, relayProtocol: by[p.localCandidateId] && by[p.localCandidateId].relayProtocol },
    rtp: [] };
  s.forEach((r) => { if (r.type === 'inbound-rtp' || r.type === 'outbound-rtp') out.rtp.push({ type: r.type, kind: r.kind, bytes: r.bytesReceived ?? r.bytesSent, packets: r.packetsReceived ?? r.packetsSent, lost: r.packetsLost, jitter: r.jitter, audioLevel: r.audioLevel, framesDecoded: r.framesDecoded }); });
  return JSON.stringify(out); })()
```
(The Meet page exposes the inbound audio counters through `window.__qorllaMeetProbe()`; the Meet client keeps its own peer connections, so use `chrome://webrtc-internals` there.)

**Server side (read only).** After each test, from the staging database:

```sql
SELECT id, status, end_reason, created_at, ended_at FROM voice_calls ORDER BY created_at DESC LIMIT 1;
SELECT kind, at FROM voice_call_events WHERE call_id = '<call id>' ORDER BY at;
SELECT status, accepted_at, init_ready_at, recip_ready_at, completed_at, closed_reason FROM voice_handoffs WHERE call_id = '<call id>';
```
(Adjust column names to the deployed schema if they differ; `sql/021_phone_meet_handoff.sql` is the reference.)

**Relay side.** During relay tests, on the TURN host through the CLI (reachable only from the engine/operator): `ps <username>` shows allocations with sent/received byte counters that increase.

**Sanitizing before sharing:** strip public IP addresses of real people, tokens, TURN usernames/credentials, SDP fingerprints, meeting ids. Keep timestamps, candidate **types**, counters and states.

## 5. Test matrix

Roles: A = host/initiator (device A, network 1). B = guest/recipient (device B, network 2). "Real media" means a person speaks on both ends and, for video, each camera shows the real scene; a synthetic or recorded source does not count.

### Group 1: baseline and relay-only calls

| # | Test | Procedure | Expected evidence | Acceptance criteria |
|---|---|---|---|---|
| T1 | Phone call, default policy, two networks | `VOICE_RELAY_ONLY=false`. A dials B's extension; B answers. Talk for 60 s. | webrtc-internals dump both sides; counters 10 s apart; server call row | state `connected` both sides; audio **both directions** (inbound bytes grow on A and on B, `audioLevel` > 0 when the other side speaks, packet loss under 5 %); the people hear each other. Record whether the pair is `host`, `srflx` or `relay`. |
| T2 | Phone call, relay-only audio | `VOICE_RELAY_ONLY=true`. Same as T1. | selected pair `relay` on **both** sides (`local` candidate type `relay`); coturn `ps` shows both allocations with growing counters | connected within 15 s of answer; relay/relay on both sides; audio both directions for 5 min with no `disconnected`; call ends cleanly (server event `ended`, reason by the user). |
| T3 | Phone call with video, relay-only | Enable camera on both ends (Phone video). | video inbound `framesDecoded` and bytes growing both ways; relay pair | video visible on both devices; frame rate above 10 fps for 60 s; audio unaffected. If this fails to connect, record the candidate-pair table (the local spec failed here: the cause is unconfirmed and must be separated from the test machine's Docker NAT). |
| T4 | Real devices | On each device switch microphone (built-in, then headset/Bluetooth if available) and camera (front/back on the phone) during the call. | webrtc-internals before/after each switch | audio continues or recovers within 5 s; no one-way audio; the person hears the change. |
| T5 | TCP/TLS-only network (device C) | Device C behind a firewall that allows only 443. `turns:<host>:443?transport=tcp`. | relay pair with `relayProtocol: tls`/`tcp` | connects, or the failure is recorded with the candidate list (the local TCP relay attempt did not connect; this is expected to need diagnosis, not assumed to work). |

### Group 2: reconnect and call preservation (phone call only, relay-only on)

| # | Test | Procedure | Expected evidence | Acceptance criteria |
|---|---|---|---|---|
| R1 | Page reload | Reload B's page mid-call (then A's, one at a time). | server events; both pages after reload | the server records **no** `ended`/`failed` event; both sides return to Connected within 30 s; the call row stays `active`. |
| R2 | Short network drop | B: airplane mode (or Wi-Fi off) for 5 s, then back. | internals before/after; timestamps | no server end event; ICE restart or reconnect; media returns within 15 s of the network returning. |
| R3 | Long network drop | B offline for 60 s, then back. | same, plus the device lease behaviour | the call is **not** ended by the server while the device lease is valid; after return B reconnects, or the call ends with a documented reason once the lease expires (record which, with times). |
| R4 | Network switch | A moves from Wi-Fi to cellular mid-call. | pair before/after; time to recover | media recovers on the new path within 20 s; call row still `active`. |
| R5 | Browser killed | Force-quit B's browser app (not just close the tab). | server events | the server does not end the call immediately; the call survives until the lease expires; reopening within the lease resumes. |
| R6 | Credential expiry | Staging only: `TURN_CREDENTIAL_TTL_SECONDS=60`; hold a relay-only call past expiry and across one ICE restart. | coturn log (refresh or refusal), internals | record exactly what happens at and after expiry (media continues because the allocation is refreshed, or drops and is renewed). A silent permanent loss of audio is a failure. |
| R7 | ICE restart | Trigger `restartIce()` or the airplane-mode toggle (R2). | state transitions | recovery without a new call; no duplicate call row. |
| R8 | Engine restart | Restart the staging engine during a call (and, if two instances exist, kill one). | server events, client state | no duplicate call; clients resume from their cursor; the call is intact (`docs/VOICE_ENGINE_V1.md` DR-08). |

### Group 3: Phone-to-Meet hand-off across networks

| # | Test | Procedure | Expected evidence | Acceptance criteria |
|---|---|---|---|---|
| H1 | Happy path, relay-only | A starts Move to Meeting; B accepts; both press Open meeting, then Start/Join; both speak in Meet. | Meet inbound audio counters on both; `voice_handoffs` row; server events | both in the **same** Meet room; media flows both ways over relay; the phone call is ended **once** by the server with reason `moved_to_meeting`, and only **after** both sides' Meet media was verified (record the time from acceptance to call end). |
| H2 | Meet unreachable before entry | Block Meet (for example stop the staging Meet or block its port for device A) after B accepted; A presses Open meeting. | screenshots; server events | A sees "Qorlla Meet could not be reached. Your phone call is still connected. Try again."; no built-in room opens; the phone call is still connected on both sides; after Meet is restored the retry succeeds and H1's end state is reached. |
| H3 | Meet unreachable for an existing meeting | A is in Meet; Meet becomes unreachable; B tries to join. | as H2 | B sees the retry message and is never sent to the built-in room; the phone call lives; the hand-off record survives; recovery works when Meet returns. |
| H4 | Guest declines or closes Meet | B declines the invitation; separately B accepts then closes the Meet window without entering. | server events, `voice_handoffs.status` | the phone call continues untouched; after the release window (150 s) the hand-off ends as expired/cancelled and the call is **not** terminated. |
| H5 | Only one side reaches Meet | A enters Meet; B never does (B's network blocks Meet, or B stays in the phone page). | `voice_handoffs`, call row | the call stays up until the release window passes; it is never ended on one side's evidence alone. |
| H6 | Reload during the hand-off | Reload A's or B's phone page at each stage: invitation pending, just accepted, host in Meet, both in Meet. | pages after reload; server events | each page recovers the true state from the server; the call survives every reload; the hand-off still completes or expires correctly; the call ends at most once. |
| H7 | Stale or replayed evidence | Pause B's Meet tab (background it, or use the browser's tab freeze) for more than 8 s while A is flowing. | `voice_handoffs.*_last`, call row | the call is **not** released on stale evidence; it is released only when fresh evidence from both sides exists. |
| H8 | Suspension during hand-off | Suspend one principal while H1 is in progress (F6-F8 of the A3.7.1 runbook). | time from suspend to last media packet | within the documented security budget (3 s) for relay media; the hand-off fails closed. |

## 6. How to run (commands recap)

- Staging services are started by the staging operator with the environment from section 2 (placeholders; never commit values). Verify with P0.
- For each test: open `chrome://webrtc-internals` before dialing, run the test, capture the console snippet twice, export the internals dump, run the SQL queries, take `ps` from coturn during relay tests, and save everything under a dated folder named after the test id.
- Remote debugging for Android: `adb forward tcp:9222 localabstract:chrome_devtools_remote`, then `chrome://inspect` on the desktop.
- The hand-off tests need both devices to open the Meet window from the Portal's Open meeting dialog; pop-up blockers must allow the Portal (record this setting).

## 7. Result table (fill in; leave BLOCKED until real evidence exists)

| # | Result | Date | Operator | Commit SHAs (main/engine/meet) | Evidence folder |
|---|---|---|---|---|---|
| P0 | BLOCKED | | | | |
| T1 | BLOCKED | | | | |
| T2 | BLOCKED | | | | |
| T3 | BLOCKED | | | | |
| T4 | BLOCKED | | | | |
| T5 | BLOCKED | | | | |
| R1-R8 | BLOCKED | | | | |
| H1-H8 | BLOCKED | | | | |

## 8. Known risks to watch for (from the local work, not conclusions)

- The Phone video relay-only spec failed locally for an unconfirmed reason; a real second network may pass or may expose a genuine TURN or candidate problem. Treat the first real relay result as new information.
- Media evidence is measured by the participant's own browser inside Meet; a modified client could misreport. The server checks growth, binding and freshness, not the media itself.
- Rate limits are per engine instance (in memory). With several instances the database rules still hold, but the limit is per instance.
- Redis event ordering between replicas had one unexplained intermittent failure in local tests (see `docs/PHONE_MEET_V2_3.md`). If the staging engine runs more than one replica, the cross-replica ordering result must be collected (R8) before any GO.
- The pre-meeting Meet-to-engine evidence report timed out a few times (about 4 s) on the loaded development machine; repeat the observation on staging and record the rate.

## 9. Gates for a GO decision

All of the following must have real evidence (not synthetic) before the hand-off can be considered for production: P0, T1, T2, T3 (or a documented, accepted exclusion), R1-R5 and R7, H1-H6, and R6/R8/H7/H8 as applicable to the deployment. A single unexplained failure in these keeps the verdict at NO-GO. The remaining non-media gates (distributed rate limiting, the Meet server-side check that only the two call participants may be admitted to the hand-off meeting, and the items in `docs/PHONE_MEET_V2_3.md` section 8) stay open independently of this plan.
