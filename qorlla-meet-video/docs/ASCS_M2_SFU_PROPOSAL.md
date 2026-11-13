# ASCS-M2 proposal: moving Meet's media to an SFU (the only design that closes the remaining P0 gap)

Status: **proposal, not started.** Written at the end of ASCS-M1.3. Nothing here is implemented.

## 1. The gap this closes

M1.2/M1.3 made the **screen channel** server-enforced: a dedicated relay-only connection per viewer, on credentials the server can revoke, with a peer policy that lets an allocation talk only to another allocation of the same relay. Measured: a presenter whose page ignores "stop" delivers **0** screen frames after revocation.

What the relay cannot do is look at **content**. Meet is a full mesh: every participant also has an ordinary camera/microphone connection to every other participant, directly peer to peer. A modified client can send screen pixels over *that* connection. The relay never sees it, and revoking the share does not touch it. That was demonstrated in M1.2 (S6: 44–46 camera-path frames per 3 s still flowed after the revoke) and is not fixable inside a mesh: the only server action left is to disconnect the person from the meeting.

So **"a revoked presenter cannot continue sending media to participants" holds for the share channel and does not hold for a hostile client's camera channel.** That keeps production at NO-GO for any customer whose threat model includes a hostile participant.

## 2. What an SFU changes

In an SFU every client sends **one** connection to the server and receives what the server chooses to forward. The server, not the client, decides who sees what.

| Question | Mesh + relay (today) | SFU |
|---|---|---|
| Can a revoked presenter still reach viewers? | Yes, over the camera connection | No: the SFU stops forwarding that publisher's tracks to anyone |
| Who decides which track is "the screen"? | The client | The SFU: publish permission is granted **per track source** (camera, microphone, screen_share); a track published without the screen permission is rejected |
| Revocation | credential + allocation termination (1–5 s) | change the participant's permission / remove the track: effective immediately, one control call |
| Viewer removed | credentials revoked, allocations cancelled | disconnect from the room |
| Bandwidth at the presenter | one upload per viewer | **one** upload, whatever the audience |
| Server cost | relay forwards only the screen | forwards everything (CPU and egress scale with participants × tracks) |
| Recording / AI / PSTN bridge | each needs its own mesh peer | each is one more subscriber (simpler) |

## 3. Options (all open source, self-hostable)

* **LiveKit** (Go; rooms, participants, per-track permissions, webhooks, JWT access tokens with `canPublishSources`). Closest fit: the permission model *is* the requirement. Server SDKs for Node.
* **mediasoup** (Node/C++ library, no product around it): maximum control, we would write signalling, permissions and scaling ourselves.
* **Janus / Jitsi Videobridge**: workable; older permission models, more glue.

**Recommendation: LiveKit**, behind a thin Meet-owned authorization layer so the vendor can be replaced.

## 4. Architecture sketch

```
page ── REST/Socket.IO ──► Meet (authority: meeting, host, admission, Shield, ASCS share state)
  │                           │  mints a short-lived room token: canPublishSources = [camera, microphone] (+ screen_share ONLY while the ASCS share is theirs)
  │                           │  on ASCS revoke / handoff / stop / Shield deny: updateParticipant(permission) or removeParticipant  (server -> SFU, one call)
  └── WebRTC (one connection) ──► SFU ──► forwards tracks to subscribers; rejects a publish the token does not allow
```

Meet stays the single authority for **who may present**; ASCS's lease, revision numbers, idempotency, fail-closed rules and the Shield hooks all stay. What goes away is the relay credential registry for screen sharing (the SFU token takes its place); the reconciler's job becomes "SFU permissions equal ASCS state".

## 5. Plan

| Phase | Work | Exit criteria |
|---|---|---|
| S0 | Stand up the SFU beside Meet; page joins a room with a token minted by Meet; camera/mic only, behind a flag; mesh remains the default | two browsers talk through the SFU; mesh unaffected |
| S1 | Screen share as an SFU track gated by `screen_share` permission; ASCS hooks call the SFU on revoke/handoff/stop/Shield deny | the M1.3 malicious-presenter tests pass **including the camera-path substitution test (the one that fails today)** |
| S2 | Move cameras/microphones; remove the mesh in SFU rooms; recording, Qorlla AI and PSTN bridge become SFU subscribers | feature parity; 3-person and 25-person rooms |
| S3 | Hardening: SFU behind TLS/TURN, regional placement, load tests, failure drills (SFU restart, Meet restart, Shield down), monitoring | the M1.3 certification matrix re-run against the SFU, plus capacity numbers |

Reusable from M1.3 unchanged: the Shield contract and its tests, ASCS state machine and its 28 tests, the cert harness structure (`tests/cert/*`), the alert rules (re-pointed at SFU metrics), the raw-client method for attacker tests (a LiveKit client replaces the TURN client).

## 6. Risks and costs

* **Capacity and cost:** an SFU forwards every stream; egress and CPU scale with participants. Size with a load test before any commitment (M1.3 `m13-load` is the method; the SFU needs its own figures).
* **Single point of failure:** the mesh has none; the SFU does. Needs health checks, restart drills and (later) more than one node.
* **Privacy:** media passes through our servers (not end-to-end encrypted between peers). SFrame/insertable-streams E2EE is possible later but then the SFU cannot inspect content either. Decide what is promised to customers.
* **Scope:** S2 touches the core call path of every meeting. Keep the flag per meeting/organization so rollback is a setting.
* **Browsers:** Safari and mobile need real-device testing; Chromium emulation (what M1.3 did) is not enough.

## 7. Decision requested

Approve S0–S1 as the next milestone, scoped to the one thing mesh + relay cannot do. Until S1's camera-path test passes, production stays NO-GO for hostile-participant threat models; for cooperative-client deployments, M1.3's relay enforcement is a real improvement and can be run in a controlled pilot.
