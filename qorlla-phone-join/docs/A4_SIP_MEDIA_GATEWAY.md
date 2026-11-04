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
