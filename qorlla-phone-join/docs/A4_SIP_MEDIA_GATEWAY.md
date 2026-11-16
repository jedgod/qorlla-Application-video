# Milestone A4: SIP/RTP media gateway (development build)

Status: **telephone dial-in is BLOCKED.** This milestone builds and tests the audio transport that A3 was missing. Nothing here talks to a carrier, nothing is a public number, nothing is deployed, and the gateway
**refuses to start** unless it is explicitly enabled and completely configured (`configProblems`), and then refuses every call while any of the six readiness conditions is false. Simulated media is not certification.

## A4.1 What Meet's media architecture really is

Qorlla Meet (`qorlla-meet-video`) is a **browser-side full mesh of peer-to-peer WebRTC**:

* each browser holds one `RTCPeerConnection` per other participant (`public/app.js`, `createPeer`);
* the server (`server/index.js`) is a socket.io **signalling relay only**: `roster`, `participant-online/offline`, and `signal {to,data}` forwarded to one online participant. It never touches audio;
* there is **no SFU and no server-side audio mixer**, and the server has no WebRTC dependency (`bcrypt dotenv express express-rate-limit helmet jsonwebtoken pg socket.io`).

Consequence: there is nothing on the server to "attach" telephone audio to. The telephone caller must itself be a **WebRTC peer in the mesh**. The decision taken (and confirmed): *the gateway joins as one more peer, speaks the
browsers' own handshake, and mixes the meeting for the phone leg.* No SFU was introduced; no browser or mobile client changes.

```
 telephone ──SIP(UDP dev / TLS prod)──► UdpSipIngress ─► TelephoneController ─► admitTelephoneCall (A3: Shield, passcode, host, ledger, timeouts)
     │                                        │ digest + source allowlist + limits        │ approved
     └──RTP/SRTP (G.711, SDES keys)──► RtpLeg (jitter buffer, DTMF, activity)              ▼
                                              │ 20 ms PCM                          SipMediaGateway ──► MeshPeerAudio (werift)
                                              ▼                                                          │ DTLS-SRTP, PCMU, per-browser peer
                                   meeting mix ◄── per-peer jitter buffer + sum        browsers ◄────────┘  (signalling: Meet socket relay)
```

## Selected stack

| Concern | Choice | Why |
|---|---|---|
| WebRTC (ICE, DTLS-SRTP, RTP) | `werift` 0.26 (maintained, TypeScript) | no native daemon; testable in-process; negotiates PCMU, which every browser must support |
| SRTP on the telephone leg | `werift-rtp` `SrtpSession`, SDES keys (`AES_CM_128_HMAC_SHA1_80`) | same library, authenticated encryption |
| Codec | G.711 PCMU/PCMA at 8 kHz end to end | no transcoding, no Opus encoder needed; narrowband is what a phone is anyway |
| SIP signalling | **our own bounded RFC 3261 subset** (`src/sip/*`) over UDP | the maintained Node SIP libraries are unmaintained or need a daemon (`sip` 0.0.6, 2022; drachtio). **This is development-grade.** Production needs SIP over TLS from the carrier's SBC behind the same `SipIngress` interface |
| Socket binding | `socket.io-client` | what the browsers use |

## What was added (all under `qorlla-phone-join/`)

* `src/sip/message.ts` bounded parser/serialiser (size, header count, no folding, strict Via/CSeq); `digest.ts` SHA-256 digest (MD5 only if named), signed expiring nonces, single-use responses; `sdp.ts` offer/answer
  (G.711 + telephone-event + SRTP; refuses plain RTP, codec mismatch, hold, and a media address that is not the caller's); `adapter.ts` **the provider-neutral contract** (`SipIngress`, `InboundCall`); `udp-ingress.ts` the dev implementation.
* `src/media/g711.ts`, `jitter.ts`, `dtmf.ts` (RFC 4733), `rtp-leg.ts` (the telephone side: SRTP, strict source, counters), `sip-media-gateway.ts` (the existing `MediaGateway` contract: evidence, watchdog, late-leg safety),
  `mesh-peer.ts` (the meeting side), `meet-signaling.ts` (binding to Meet's socket relay).
* `src/telephone-controller.ts` (INVITE to hang-up; DTMF; calls `admitTelephoneCall`), `src/sip-gateway.ts` (assembly + `configProblems`).
* A3 code is **not modified**: the controller uses `admitTelephoneCall`, `MeetingAuthority`, `CallLedger`, `meetConfirmedBridge` and `terminateCall` as they are, so Meet's authorization, Shield checks, host approval, atomic
  call ownership, timeouts, late-media termination and orphan recovery apply unchanged. No authentication logic was duplicated.

## Security model

* **SIP ingress:** an empty source allowlist admits nobody; digest is mandatory (constructor refuses otherwise); unparsable, off-list and flooding sources are **dropped silently** (replying to a spoofable address is an amplification vector);
  per-source token bucket, a global call cap, `Retry-After` at capacity; retransmissions are answered with the same bytes and never processed twice; re-INVITE/forked copies get 488 and never become a second call;
  the dialed number and caller are validated; credentials are stored as HA1 hashes and looked up as own properties only.
* **Media:** SRTP required by default (plain RTP only in `labMode` on a private address); the SDP media address must equal the SIP source; RTP accepted only from that address and port (no latching), only valid payload types and
  sizes, only packets that **authenticate** count as audio; a stopped sender ends the call (`inactivityMs`); `encrypted` in the evidence is true only if the telephone leg is SRTP **and** the meeting session is DTLS-SRTP.
* **Resources:** call cap, RTP port range (checked against the call cap), jitter buffer bounded, DTMF entry bounded in length and time, SIP/transaction tables bounded and pruned.
* **Logging:** structured events (`sip_invite`, `sip_call_ended`, `admission_result`, `media_interrupted`, ...); caller numbers masked; no PIN, passcode, token, key or SDP is logged.
* **Secrets:** none are committed. The digest nonce secret and credential hashes are passed in at start-up; the tests generate random ones at run time (the literal `trunk-secret` is a test-only password).

## Test evidence

| Suite | Tests | What it proves |
|---|---|---|
| `sip-codec` | 7 | parser limits and hostile input, digest (replay, expiry, forged nonce, wrong realm/URI/method), SDP refusals |
| `media-primitives` | 7 | G.711, jitter buffer (reorder, duplicates, loss concealment, wrap, **DTMF sequence gaps, long-gap resync**), DTMF, entry limits |
| `sip-ingress` | 10 | real UDP: auth, replay, ACL, flood, retransmission, CANCEL, no-ACK, capacity, re-INVITE, shutdown |
| `telephone-flow` | 18 | end to end: DTMF to admission; wrong credentials; host refusal; Shield revocation; missing audio in either direction; unencrypted meeting media never verifies; Meet says terminate; codec mismatch; readiness missing; **loss + jitter + duplicates**; interrupted media; teardown; late media; restart; duplicate callbacks; port exhaustion; **the whole real chain** |
| `mesh-peer` | 5 | real ICE + DTLS-SRTP with browsers running the app.js handshake: mix, late joiner, leave, **glare**, hostile signalling, close |
| `meet-signaling` | 4 | the socket binding against a server following Meet's relay contract |
| `sip-gateway-config` | 3 | disabled by default; 13 unsafe configurations named and refused; enabled but not ready serves nobody |
| existing (A3) | 104 | unchanged; 28 of them need PostgreSQL/Redis/Meet and are **skipped here** (as before) |

Whole package: **158 tests, 130 pass, 28 skipped, 0 failed.** The new suites were repeated (the flow suite 10+ consecutive runs) without a flake.

**Demonstrated bidirectional media (development only):** in `telephone-flow` "THE WHOLE REAL CHAIN", a synthetic phone speaks SIP and SRTP/G.711 to the gateway; the gateway joins a meeting of two browser stand-ins over ICE and
DTLS-SRTP; the phone's 440 Hz arrives at both browsers, the browsers' 1000 Hz and 1500 Hz arrive mixed at the phone, the phone does not hear itself, `evidence.encrypted` is true, and both judges (the gateway's `audioVerified`
and Meet's double) accept it. What is **simulated**: the telephone (a test program), the carrier (none), the browsers (werift re-implementations of the app.js handshake, not Chrome), and Meet (a double that follows its contract).

## Findings and open decisions

1. **A3 vs the mesh: RESOLVED in A5 (option a, restricted verification-phase peer).** Meet now issues a short-lived (<= 60 s), single-use credential after the PIN, the host and the Shield have said yes; the gateway connects with it as
   `kind: 'verification-peer'`, may only negotiate media with browsers of its own meeting, and is promoted only on verified media from a negotiated peer of the same session. See `docs/A5_VERIFICATION_PEER.md` in the Meet branch.
   Gateway side: `MeetPhoneAuthority.requestPeerCredential`, `verificationPeerSignaling` (waits for Meet's `roster` readiness signal), `peerJti` carried on every media report.
2. **Meet's relay rejected `restart` and `rebuild`** (the browsers' recovery requests). Fixed on the Meet branch in A5: the relay and the peer now carry them (they hold only the pair's epoch).
3. **SIP is development-grade.** Own minimal UDP implementation; production needs SIP/TLS (and ideally an SBC) behind `SipIngress`. No SIP-level retransmission timers for non-INVITE client transactions beyond a few BYE repeats.
4. **RTCP is not processed** (no receiver reports, no bandwidth estimation); SRTP replay protection is whatever `werift-rtp` provides. Both need review before certification.
5. **Mesh scaling.** Every browser connects to the gateway peer, and the mesh itself is O(n^2); this adds one peer per caller. Large meetings with many callers will need an SFU decision later.
6. **Dependency advisory:** `npm audit` reports one **high** finding in the production dependency `zod` (< 4.6.6, memory exhaustion on oversized constrained collections). It pre-dates this milestone (the dependency was already used); the fix is a major upgrade (zod 4) and was not applied.
7. **Secrets hygiene (checked):** the values in the ignored `.dev-stack*` directories do not appear in any of the 266 revisions of the repositories searched, nor in tracked or unignored files. Two extra directories (`.dev-stack-bc2`, `.dev-stack-sbacs`)
   were untracked and **not** ignored; they are now excluded locally (`.git/info/exclude`); add `.dev-stack*/` to `.gitignore` in a normal commit. No rotation is required for repository exposure.

## Updated production readiness

| Capability | Status |
|---|---|
| Telephone admission (A3 contracts) | unchanged; used as is |
| SIP ingress (signalling) | **built, development-grade (UDP)**; SIP/TLS, SBC, carrier trunk **missing** |
| Bidirectional telephone media | **built and demonstrated in-process** (SRTP + DTLS-SRTP, G.711); not run against a real phone or carrier |
| Meeting-side attach | **built** (mesh peer); **Meet-side credential for the verification phase undecided** (finding 1); not run against the real Meet server or a real browser |
| Gateway disabled by default / config guard | **built and tested** |
| Carrier certification, numbers, billing, regulatory, emergency handling | **missing** |
| Physical telephone testing, load, failure injection at scale | **not performed** |
| Production release | **BLOCKED** |

## Remaining infrastructure and work

* Decide finding 1 and implement the Meet-side credential; then run the mesh peer against the **real Meet server** and **real Chrome** (Playwright) and add that as a test.
* An authorised carrier/SIP trunk, SBC, TLS certificates and mTLS where used, public numbers (all OFF), production secret store, restricted DB roles, Redis with TLS.
* RTCP and congestion handling; a recording-consent decision for the caller's audio path; accessibility/privacy/regulatory review; physical-phone, soak and load testing; alert routing for orphaned calls.

## Running

```bash
npm install && npm test          # builds, runs all suites; the 28 PostgreSQL/Redis/Meet tests are skipped without their environment variables (see MEET_INTEGRATION.md)
```

## A5 update (gateway side)

* New: `test/a5-consumer.test.ts` (6 tests): credential request, refusals, connection as `verification-peer`, the credential id on the media report.
* Whole package with PostgreSQL, Redis and the **real Meet A5 tree** wired in (`PHONE_JOIN_TEST_DATABASE_URL`, `PHONE_JOIN_TEST_REDIS_URL`, `MEET_SERVER_DIR`): **164 tests, 164 passed, 0 skipped**, including the 28 that need those services.
* Still not covered: RTCP/media-quality monitoring, and any real telephone or carrier. The Zod advisory is tracked separately.

## A5 laboratory integration (real Meet, real Chromium, gateway process, synthetic SIP phone)

Status: **laboratory integration validated for the scenarios below; NOT production certified.** Telephone dial-in stays BLOCKED. Public numbers, PSTN, carrier calling and billing are disabled.

What runs (`test/e2e-chrome.test.ts`, off unless `A5_E2E=1`; needs `MEET_SERVER_DIR`, `PHONE_JOIN_TEST_DATABASE_URL` and a Chromium for `playwright-core`):
the actual Meet server process on PostgreSQL; the gateway as its OWN process (`scripts/a5-gateway-runner.mjs`); two or three real Chromium browsers whose fake microphones play KNOWN tones from WAV files (Alice 1000 Hz, Bob 1500 Hz, Carol in another meeting 2000 Hz);
a synthetic SIP/SRTP phone (440 Hz). The gateway gets its restricted credential through Meet's real flow (PIN, approval, media token, verification credential). Audio is judged by DECODED samples (Goertzel at the phone, an AnalyserNode in each browser);
`getStats()` is supporting evidence for ICE/DTLS/SRTP/codec only.

| Scenario | What is asserted |
|---|---|
| Happy path | credential consumed BEFORE the call connected, then promoted; Meet's own evidence (PCMU, encrypted, packets both ways); ICE pair succeeded, DTLS connected, SRTP cipher, PCMU in both browsers; the phone hears Alice and Bob (about 7e5x the noise floor) and NOT its own audio or Carol's; both browsers hear the phone's tone and none of the others; hang-up: `TERMINATED`, credential revoked, the RTP port held during the call and released after; Alice and Bob stay connected to each other with audio still flowing; no process survives |
| FAULT 1 real ICE restart | the app's own recovery runs; the gateway re-offers with NEW ICE credentials; audio is back in about 510 ms; the call stays connected |
| FAULT 2 gateway killed | Meet ends the call (`gateway_signaling_lost`), revokes the credential; the browsers stay connected to each other; a restarted gateway admits a new call with exactly one phone participant; the dead gateway's ledger claim is reaped |
| FAULT 3 Meet-side revocation | the PIN is revoked: call `pin_revoked`, credential revoked, the caller is hung up, the browsers drop the gateway, no audio reaches the phone |
| FAULT 4 keep-alive rejection | the phone stops sending: Meet rejects the keep-alive evidence (`media_unverified`) before the gateway's own 8 s inactivity timeout |

Result on the frozen implementation: three consecutive full-file runs, 5 of 5 scenarios each. Earlier runs failed intermittently; every failure found so far was explained and was a test-harness problem
(ICE-pair measurement, fault injected before the browser had received `participant-online`, Meet's 12-digit codes vs the 11-digit contract, a keypad pressed before the prompt tone). The setup flake "the gateway hangs up after repeated keypad-entry failures"
occurred twice early on and has NOT recurred in the last ~50 runs; it is explained only as far as the evidence allows and stays open.

### Findings and open hardening items

1. **Meet's own UI creates 12-digit meeting codes; dial-in assumes 11** (Meet's phone docs, its directory route, this gateway's keypad rules). Meetings for dial-in come from the main app with 11-digit codes. Decide whether to support 12.
2. **Reaper threshold (addressed by Gate A5.1, below; text kept as the original finding).** `reapStale` re-checks age under the row lock (a stale observation cannot reap a refreshed row), but it uses ONE threshold for every open state measured from `updated_at`, and a live admission does not renew it: a live attach that outlasts the threshold is reaped (seen at 1.5 s; the admission then fails safe).
   Required hardening, not yet done: a lease renewed by the admitting gateway, per-state deadlines (awaiting_host, attaching), and a deterministic regression (an attach paused just under the threshold must survive a reaper scan; an abandoned one must be released). The default (60 s) is not proven safe.
3. **Early-failure window.** A browser whose connection to the gateway fails after it formed but BEFORE `participant-online` arrives does not request recovery (the app's `recoverPeer` ignores peers that are not in its roster). Not covered by a test; needs a product decision (recover that peer when it joins, or end the telephone leg).
4. **Lab-only readiness stub.** The runner says "ready" only with `A5_LAB_READINESS=1` and loopback binds; it proves nothing about the six production readiness conditions.
5. **Not covered:** RTCP/media-quality monitoring, the Zod advisory, carrier interoperability, real telephones. The Shield is a separate mandatory gate.

## Gate A5.1: ownership lease, fencing and per-state reaping

Migration `sql/002_phone_join_lease.sql` (idempotent; rollback `002_phone_join_lease.rollback.sql` removes only these columns; apply AFTER 001). It adds `lease_owner`, `lease_generation`, `lease_expires_at` and `lease_challenged_at` to `phone_join_calls`. Rows written before it become generation 1, owned by their claimant, already lapsed.

Invariants (each one is a test in `test/ledger-lease.test.ts`):

1. **One owner, one generation.** A claim creates generation 1. Every ownership transfer adds exactly 1, in the same conditional write that changes the owner.
2. **Fenced writes.** The owner presents the generation it holds. The row accepts a state change or a renewal only while owner AND generation still match. An old gateway that resumes after a takeover changes nothing, writes no history, and is told (`onLost`).
3. **A lapse is a question, not a verdict.** A reaper that finds a lapsed lease CHALLENGES it (marks the row, changes nothing else). The owner's next renewal clears the mark. Only a lease still lapsed a whole grace period after the challenge is taken over (generation + 1, state `terminating`, owner = the reaper), by exactly one reaper (`FOR UPDATE SKIP LOCKED`, conditions re-checked under the lock, conditional update on the generation read).
4. **Per-state deadlines** (`DEFAULT_DEADLINES`, overridable): claimed 30 s, authorizing 30 s, awaiting_host 300 s (a person is answering), attaching 60 s, terminating 120 s (a stuck teardown is taken over as `stale_terminating`), released 600 s (a `failed` row whose id was never freed is purged). `connected` has NO deadline: a lapsed lease on a connected call is never grounds to reap it; Meet's media verification governs it.
5. **Fail closed.** `startLeaseKeeper` renews every call the instance owns. A call it lost (renewal rejected, or a write fenced) has its local leg disconnected at once. If the database cannot be reached nothing is assumed and ownership is untouched; once a whole lease period passes without a confirmed renewal (the earliest a reaper could lawfully take the call) a not-yet-connected leg is stopped locally. A reaper that loses the database mid-reap changes nothing and believes it owns nothing.
6. **Administrative end.** A replica that never owned a call may only end a CONNECTED one (`terminating`, the Shield path); that takes the call over under a new generation and fences the original owner.
7. **Idempotent cleanup.** `finishReap`, `release` and `purgeReleased` can be repeated: one terminal event, nothing released twice.

Defaults: lease 15 s, grace 15 s, renewal every 5 s (`startLeaseKeeper`). The lab runner takes `A5_LEASE_MS`, `A5_LEASE_GRACE_MS`, and `A5_REAPER=1` (the lease keeper always runs).

Not covered: a CONNECTED call whose gateway died is not resolved by this reaper (it needs a Meet-side liveness check of the session, which Meet's own media verification currently provides); lease timing across gateways with badly skewed clocks is not an issue for the database side (the database clock is the authority) but the owner's local fail-closed timer uses its own monotonic clock.

## Gate A5.2: bounded recovery and stale-attempt fencing (gateway side)

The browser side (Meet `public/app.js`) is described in Meet's `docs/A5_VERIFICATION_PEER.md`. In `src/media/mesh-peer.ts`:

- **Bounded recovery.** A browser that never connects is dropped after `connectTimeoutMs` (default 45 s). One whose connection was up and went down is dropped after `recoveryDeadlineMs` (default 30 s). The clock starts when the browser first becomes unconnected and is NOT reset by ICE restarts or rebuilds (only a real connection, or the browser leaving, stops it). When no peer is left the session closes with reason `recovery_deadline` and the call is ended with it; other participants and the remaining browser connections are untouched.
- **Fencing.** The epochs of closed connections are remembered (16 per browser): a late offer of a superseded attempt creates nothing. An offer or answer in flight when its peer is replaced or closed is not sent. After the session is closed every signal is ignored.
- Lease ownership (A5.1) and Meet's credential checks are untouched.

Tests: `test/early-failure.test.ts` (fake clock, real signalling/ICE/DTLS; 7 tests) and the Chromium scenarios "A5.2 - ..." in `test/e2e-chrome.test.ts`, which hold the phone's `participant-online` back in the page (`__freezeOnPhoneOnline` / `__thaw`). Readiness in those tests is Meet's promotion plus the gateway connection being up, never the participant tile.

Laboratory notes (not product behaviour):
- With three browsers the default 20 fps fake camera saturates the host (about 95% CPU); the Docker-published database port then shows multi-second round trips and the ledger fails closed at its 5 s deadline. `A5_CAM_FPS=5` caps the lab's fake camera (verified: observed frame rate 5). Production camera defaults are unchanged. Measured: 0/5 three-browser setups uncapped, 5/5 capped; the exact bottleneck is not fully isolated.
- The runner prints lab-only probes under `A5_LOG` (ledger duration, pooled-connection acquire time, event-loop lag, an independent `SELECT 1`).
- The "announcement never arrives" Chromium scenario ended through Meet's own `media_unverified`. The gateway-driven end is covered by a dedicated scenario ("A5.2 - the GATEWAY's own recovery deadline ..."): Meet's staleness timer is made very long, the gateway's evidence reports are off (`A5_NO_KEEPALIVE=1`) and its media watchdog is relaxed (`A5_RECOVER_WITHIN_MS=120000`; 5 s in production, reason `media_interrupted`). Result (two runs): the leg ended 30.2 s and 31.1 s after the gateway's last restart offer; the gateway ledger records `terminating` with reason `meeting_recovery_deadline` and ends `ended`, its lease is no longer renewed, the credential is revoked, the RTP port released, nothing is sent or reconnected afterwards, and the browsers stay connected to each other. Meet records `gateway_signaling_lost` (it learns of the end when the gateway closes its socket); the cause is in the gateway ledger.
- Measured behaviour worth knowing: the gateway's clock for a browser starts when ITS connection first stops being connected (ICE consent failure, about 25 s after a browser closes its side), each browser got one restart offer, and in production the 5 s media watchdog ends the call first when no browser delivers audio, so `recovery_deadline` is a backstop and the cleanup for a dead peer while others remain. "Restarts do not reset the clock" is proven by the fake-clock test, not by Chromium.

## Gate A5.3 - meeting-code compatibility (11 and 12 digits)

**Two identifiers are legitimate and both resolve.** The main application creates 11-digit meeting IDs (and registers them in Meet as an alias of the scheduled meeting); Meet creates 12-digit primary codes. A meeting scheduled through the main app therefore has both, and they resolve to the same Meet UUID.

**Policy (one definition, `src/meeting-code.ts`; Meet: `server/meeting-code.mjs`).** A code is a string. Only a space or a hyphen (what a person types as a separator) is removed; the result must be exactly 11 or 12 digits; anything else (letters, tabs, `+`, `.`, full-width digits, 10 or 13 digits) is refused. Nothing is padded, truncated or converted, so leading zeros are exact. The code is resolved to the canonical Meet UUID before any credential is issued; credential binding, lease ownership and authorization rules are unchanged.

**Keypad.** The meeting-code entry now requires `#` (`requireTerminator`), accepts 11 to 12 digits and no longer completes at the 11th digit. A 13th digit ends the entry as `too_long` and is never carried into the PIN prompt; `*` restarts; the inter-digit and total timeouts are unchanged. The PIN entry is as before.

**Preserved provisionally.** Meet's browser resolver still resolves existing 10-digit aliases (alias registration is documented as 10-12 digits). Meet issues no new 10-digit code. The telephone path does not accept 10 digits. The test database holds no 10-digit rows, so nothing is known about production; do not remove the support before the production data has been counted (read-only) and the alias CHECK (`10,12`) reviewed.

**Not part of A5.3 - separate compatibility dependency.** These surfaces still validate exactly 11 digits and are unchanged: the main application's join and phone-help validators (`qorlla.html`, `guest.js`), the installable-app deep link (`device-policy.js/.cjs`), and the Meet Twilio IVR (`normalizeMeetingId`, parked and inactive). **Do not claim that 12-digit codes work across all Qorlla clients** until those are updated and tested; a 12-digit code works only for the gateway's keypad path and Meet's own browser join.

**Residual note.** Digits pressed after a refused entry (for example a 14th digit) start the next attempt's meeting-code entry; they can never complete it without `#` and 11 or more digits, and never reach the PIN prompt.

## Gate A5.5 - Security Shield for telephone calls (real-Shield contract, suspension, outage, liveness cleanup)

**Who enforces what.** Meet is the ONLY Shield enforcer for telephone admission and connected-call rechecks: it registers the meeting, asks the Shield before approval, before the verification credential is issued and before media promotion, and re-checks every open call. The gateway holds no Shield identity and does not call the Shield; `src/shield.ts` is a reference client, not wired in. The gateway independently enforces its own call-state transitions, the ownership lease with generation fencing, per-state deadlines, fenced cleanup of a vanished owner, and termination of its media legs. Credential rules are unchanged: single use, at most 60 s, bound to the authorized call and media token.

**Suspension.** The Shield decides from the REGISTERED host and organization and their CURRENT standing, not from the caller (a telephone caller has no account): `HOST_SUSPENDED`, `ORG_SUSPENDED`; an unknown registered host is `HOST_UNKNOWN`; a host whose organization differs from the registered one is `OWNER_INCONSISTENT`. A recheck revokes every participant of an affected meeting. Ordering against a concurrent suspension is defined by row locks: an authorize either waits for the in-flight suspension and sees it, or commits first and is revoked by the next recheck. Objective: a connected call ends within 30 s of the suspension's commit (15 s recheck interval; measured 0.9 s in one run; the worst case is about one interval plus processing).

**Ownerless meetings.** A meeting registered without any host account may still be REGISTERED (legacy compatibility) and a browser-style guest authorize is unchanged, but a NEW telephone call is refused: Meet turns the Shield's `ownership: none` flag into `OWNERLESS_MEETING` (call `REFUSED`, `shield_ownerless_meeting`) at admission, credential issuance and promotion. A call that is already connected is not retroactively ended by this rule. There is no override.

**Meeting with guests disabled.** Telephone dial-in is refused (`GUEST_NOT_ALLOWED`), unless a separate explicit telephone-admission policy is introduced later.

**Reports.** Event reasons are upper case and durable alert kinds lower case (the mapping is tested in the Shield): `phone_late_media` -> `PHONE_LATE_MEDIA` -> alert `phone_late_media` (high); `phone_termination_failed` -> `PHONE_TERMINATION_FAILED` -> alert `phone_termination_failure` (critical); the original `signaling_termination_failed` and `outbox_delivery_failed` are unchanged; any other kind is rejected. Meet's identity needs the `alerts.report` scope. A report that cannot be delivered is a structured log line (`shield_report_failed`) and a counter (`GET /api/integrations/phone/counters`); reporting, successful or not, never delays or prevents a termination. Migration 019 (alert-classification function only) is conditionally approved for the lab, is reviewed by test (definition, privileges, idempotency, rollback, differential against 018), and is not applied anywhere else.

**Shield outage.** An explicit refusal ends a call at once. For an UNREACHABLE Shield: admission, credential issuance and media promotion fail closed immediately; a call that is not yet connected ends at once; an already-connected call keeps a grace period of 120 s measured with a monotonic clock from the FIRST failed recheck, not extended by repeated failures or reconnections, cleared by a successful recheck, and inherited across a Meet restart (the start is on the audit trail; no schema change). A media refresh of a connected call never ends it merely because the Shield is unreachable.

**Gateway death (connected-call liveness).** A connected row whose owner's lease lapsed, and whose challenge stood for the grace period, is taken over by a surviving gateway under generation + 1 (`terminating`, reason `stale_connected`) FOR CLEANUP ONLY. A stale lease proves the owner is gone, never that the call is over, so nothing is released until Meet says so: Meet `over` -> `ended`; `live` -> Meet is asked to end it (idempotent) and asked again; `unknown` or unreachable -> the row stays `terminating` and is retried (10 attempts / 15 minutes), never marked ended. The cleanup is idempotent, generation-fenced and safe under concurrent reapers; a cleanup owner that dies is replaced by one that keeps `stale_connected` and reconciles; a returning old owner cannot resume or write; a live owner is never touched.

**Orphan reconciliation.** When Meet cannot confirm within the bound, the call becomes `orphaned` with reason `cleanup_unconfirmed`. That records only that the cleanup could not be confirmed: it does NOT release the call id (claim cannot take it; release and purge only ever delete `failed` rows), does not touch any credential state and does not imply that media was terminated. It stays visible (`listOrphans`) until an operator records the outcome with `resolveOrphan(callId, 'ended' | 'failed', operator)` (audited with the operator's name; `failed` also frees the id).

**Evidence.** Real-Shield contract tests are in the Meet worktree (`tests/shield-contract/`), the Shield's own tests in `qorlla-voice-engine/test/` (`shield-phone-suspension`, `shield-phone-reports`, `migration-019`), the gateway's in `test/liveness-cleanup.test.ts` and `test/liveness-spec.test.ts`. Open: the Shield dev-stack integration suite, the isolated reliability experiment (A5.4), and any production rollout.

### Signalling guard and phone legs (Meet 75e3fb6)

Meet's signalling guard also watches the telephone verification-peer sockets. When the Shield revokes a session, the guard writes one `session.revoked_by_shield` audit row (reason, and whether it was a `phone-peer` or a `browser`), ends a phone peer's CALL through the phone module with the Shield's reason (`shield_host_suspended`, ...), and only then closes the socket, so a Shield-caused end is never recorded as `gateway_signaling_lost`. Whichever of the phone sweep and the guard runs first, the call ends once with the Shield reason (`tests/shield-contract/suspension-race`, 12 rounds). In a Shield outage beyond the guard grace, browsers are closed as before and phone peers are left to the phone module's own 120 s deadline.

Verification status (2026-11-06, lab): Meet suites green; real-Shield Chromium scenarios 4/4 in isolation; in the full Chromium file two Shield scenarios failed once with `gateway_signaling_lost` under host load (no `session.revoked_by_shield` row, so not a guard close). A5.4 (load on this host) remains the open reliability item.
