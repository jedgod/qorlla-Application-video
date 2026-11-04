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
* Still not covered: real Chrome browsers, the real Security Shield server, RTCP/media-quality monitoring, and any real telephone or carrier. The Zod advisory is tracked separately.

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
5. **Not covered:** the real Security Shield server, RTCP/media-quality monitoring, the Zod advisory, carrier interoperability, real telephones. The Shield is a separate mandatory gate.

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
