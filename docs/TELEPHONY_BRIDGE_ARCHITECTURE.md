# PSTN to Qorlla Meet audio bridge: architecture audit and recommendation

Status: **design only. No bridge is built or certified.** This is Phase E of v2.2: audit Meet's signalling and media, choose a compatible approach, and document the contract that the already-built (fail-closed) telephony code expects.

## 1. What Meet's media architecture actually is (audited from source)

- **Full-mesh peer-to-peer WebRTC.** `public/app.js` creates one `RTCPeerConnection` per remote participant (`state.peers`). There is **no SFU, no media server, no server-side media.** The server relays signalling only (`socket.on('signal')` for `offer`, `answer`, `candidate`) over Socket.IO.
- **ICE/TURN comes from configuration** (`ICE_SERVERS_JSON` via `/api/config`); no TURN server ships with the repository. Real NAT traversal needs one.
- **Recording is client-side**: a `MediaRecorder` on a canvas plus mixed audio in the recording participant's browser, uploaded in chunks. Whatever audio that browser plays is what is recorded.
- Participants are rows in PostgreSQL. Phone callers are already `participants` rows (`kind='phone'`) with admission, waiting room, roster, attendance, mute/remove and consent state (`server/phone.mjs`). They have **no media path**.
- Screen sharing and camera switching replace tracks on existing peer connections.

Consequence: **a SIP server alone does nothing for a Meet room.** Meet clients only exchange audio with participants who speak Meet's Socket.IO signalling and WebRTC. LiveKit SIP and similar products terminate telephone calls into **their own** rooms and SFU; they are not a drop-in for a mesh of browsers.

## 2. Options

| Option | Idea | For | Against |
|---|---|---|---|
| **A. Per-caller bridge peer (recommended first)** | A server process joins the Meet room **as each phone caller's participant** over the existing signalling, holds one `RTCPeerConnection` to each web participant, and exchanges audio with the carrier. | No change to Meet clients; fits the existing roster, admission, mute/remove and consent model; smallest change to reach a certifiable v1. | Mesh cost: callers x web participants connections (acceptable for small meetings, poor at scale); the bridge must mix web audio for each caller. |
| **B. Move Meet media to an SFU** (LiveKit, mediasoup) with SIP | Replace the mesh with an SFU and use its SIP service. | Scales; native PSTN; server-side recording becomes possible. | A rewrite of Meet's client media code and recording; new infrastructure and certification for **all** meetings, not just phone. |
| **C. Carrier-side conference only** | Put callers in a Twilio Conference and have one bridge leg. | Simplest for phone-to-phone. | Does not put callers in the Meet room, which is the requirement. |

**Recommendation:** Option A for v1, using **Twilio bidirectional Media Streams** (`<Connect><Stream>`: a WebSocket carrying 8 kHz mu-law audio) so Qorlla does **not** have to run SIP/RTP itself, plus a Node bridge using a headless WebRTC library with raw-audio source/sink (for example `@roamhq/wrtc`'s `RTCAudioSource`/`RTCAudioSink`). Re-evaluate Option B when meetings regularly exceed roughly six web participants, when phone-heavy meetings are common, or when server-side recording is wanted.

## 3. Bridge behaviour (per phone caller)

1. IVR (built): caller dials a Qorlla dial-in number, enters the 11-digit meeting ID and PIN; the **existing Qorlla rules** decide (PIN verifier, attempt limits, lock, ended, ban, waiting room, host-absent). The call is **held in the IVR until admitted** (built: the `wait` step).
2. Only when the rules say *connected* does the IVR ask the bridge to join (built: `bridge.join(...)` is called **only then**). The bridge returns carrier markup for a Media Stream with a **single-use, short-lived token** bound to that call and participant.
3. The bridge process validates the token, signals into the room as that participant id, and connects to each web peer.
4. **Downlink**: mix all web participants' audio (excluding the caller's own), resample 48 kHz to 8 kHz, encode mu-law, send to the carrier. **Uplink**: decode mu-law, resample to 48 kHz, send as the caller's track to every web peer.
5. **Controls (must be real, not recorded-only):** host mute stops forwarding that caller's uplink; remove or deny hangs up via the carrier and drops the peers; meeting end, lock-on-end and the free-plan limit tear every leg down; a caller who hangs up leaves the roster (built: status webhook).
6. **Recording consent:** a caller who has not agreed (keypad 1) or has declined (2) or withdrawn (9) must be **excluded from audio that reaches the recording participant's mix**. Because recording is client-side, the bridge must stop sending that caller's uplink to the recording browser (or to everyone) until consent is given. Today no phone audio exists, so nothing is recorded; this requirement starts the day audio does.
7. **Failure:** if the bridge is down or not certified, callers are told joining is unavailable and the call ends (built: fail-closed IVR). The Join page and invitations say the same.

## 4. Contract the built code expects

```
bridge.ready                         boolean: installed AND healthy (the capability also needs the certified 'bridge' gate and the 'bridge' feature flag)
bridge.join({ callSid, meetingId, callRef })  -> carrier markup string (e.g. <Connect><Stream url="wss://.../bridge/<one-time-token>"/></Connect>)
(to add with the bridge)  mute(callSid, muted), hangup(callSid), health()
```
`UnconfiguredBridge` (server/telephony/provider.mjs) refuses to join and reports `ready=false`. Wiring host mute to `bridge.mute` and replacing the "recorded only" note is part of the bridge work.

## 5. Risks and things to test before certification

Codec and transcoding quality (mu-law 8 kHz is narrowband), clock drift and jitter buffers, packet loss, echo (handset echo comes back through the bridge: web clients cancel their own echo, the bridge must not amplify it), mixing without clipping and levels per caller, many simultaneous callers (connection count), bridge restarts and reconnects (callers dropped cleanly, roster corrected), a bridge on a different host from Meet (TURN/ICE and firewall), DTMF during a call, consent gating, resource limits per meeting, and abuse (token replay, unauthenticated Stream connections: tokens must be single-use and bound to the call). Each needs a real-call test; none can be proven with a stand-in.

## 6. What is already built toward this

Carrier adapter and signed webhooks; provisioning and calling workflows; IVR that reuses the Qorlla rules; waiting-room hold loop; hang-up on meeting end/removal; fail-closed capability derivation with an independent `bridge` flag and certified gate; the gate-recording script. **Not built:** the bridge itself, the WebRTC peer, mixing/transcoding, per-caller consent gating of audio, TURN, the one-time stream token service, any real call.
