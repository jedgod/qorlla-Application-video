# A5: the restricted verification-phase telephone peer (Meet side)

Status: **telephone dial-in is BLOCKED.** This is engineering work on the Meet side only. No carrier, no public number, no billing, no PSTN. Nothing here is enabled by default: the subsystem does nothing unless
`PHONE_PEER_SIGNING_KEY_PEM` is configured *and* migration `v4.25` has been applied.

## Why it exists

Meet has no media server: browsers form a full mesh and the server only relays signalling. A telephone caller's audio can therefore only be verified after the telephone gateway's WebRTC peer has negotiated with the
browsers over Meet's own signalling. A3 says a caller is not a participant until audio is verified. The restricted verification peer resolves that circle without weakening A3: it may *negotiate media* between APPROVED and
MEDIA_CONNECTED, and nothing else.

```
REQUESTED -> VERIFIED -> AWAITING_HOST -> APPROVED  --(credential issued)-->  [verification peer: signalling only]
          -> MEDIA_CONNECTING -> MEDIA_CONNECTED      (promotion: verified media + a negotiated peer + Shield + open meeting, one atomic move)
```

## The credential (`POST /api/phone/ivr/peer-credential`)

* Authenticated like every gateway route (workload token with scope `phone.peer`, or the provider HMAC in provider mode). Body: `{callId, mediaToken}`; `mediaToken` is the call's one-time media token and proves this gateway was approved for this call.
* Issued only when the call is `APPROVED`/`MEDIA_CONNECTING`, the meeting is open and the Security Shield still allows the participant. One live credential per call (a database unique index); an unconsumed one is superseded.
* An ES256 JWT signed by **Meet**: `iss qorlla-meet`, `aud qorlla-meet-verification-peer`, `scope meet:telephone:verify-media`, `sub` = the gateway identity, `call`, `mid`, `pid`, `jti`, `exp - iat <= 60 s`.
* Answers: `issued` (with `credential`, `jti`, `expiresAt`, `ttlSeconds`), `denied`, `unknown`, `not_approved`, `already_issued`, `unavailable`, `terminate`.

## Using it (socket.io, the existing server, no second namespace)

`io(url, { auth: { kind: 'verification-peer', token: <credential> } })`. Consumption is **one atomic statement** that also checks the call state, the meeting and revocation, using the database clock. Replays, expired, revoked,
cross-meeting, wrong-audience or forged credentials, and a normal participant token presented as a credential (or the reverse), are refused with a uniform `Unauthorized`.
The peer must wait for the `roster` event: it is Meet's readiness signal (signals sent earlier get `Not ready`).

What the peer **is not**: in the roster, in the room, a participant session, counted as connected, or able to receive any room broadcast. What it can do: `signal` (`offer | answer | candidate | restart | rebuild`) to an
admitted browser **of its own meeting**, at most 16 KB (the transport also drops oversize frames), rate-limited. Chat, hands, notes, polls, reactions, media state, recording and moderation events have no handler for it.

## Promotion

Only `mediaReport()` promotes, and in addition to Meet's own judgement of the evidence (two-way, encrypted, fresh, long enough, allowed codec), the Shield, the open meeting and the lifecycle table, it requires
`peers.notReady(call, peerJti, subject) === null`: a live, connected peer exists for the call, its credential id equals the `peerJti` in the report, the authenticated gateway identity equals the credential's subject, and the
server has **seen an `answer` cross** between the peer and a browser. Sending a successful signalling message or perfect-looking evidence is not enough on its own. In gateway mode a missing or unconfigured peer subsystem means
nothing can be promoted (fail closed).

## Revocation and failure

Every move of a call into an ending state revokes its credential **in the same database transaction** and then closes the peer's socket (it is told `revoked`). A gateway whose signalling drops (including one that drops right
after connecting) ends its call. Late reports, replays and repeated hang-ups are idempotent: one terminal event, no resurrection, an `ORPHANED` call is never promoted. If the signing key is configured but the v4.25 table is
missing, the subsystem disables itself loudly at start-up and ending calls keeps working.

## Two independent lifetimes

| Lifetime | Default | What it governs |
|---|---|---|
| Credential validity | 60 s (token `exp`; schema cap 120 s; judged by the database clock) | how long a credential may be presented |
| Replay-answer retention | 120 s (`PHONE_REPLAY_TOKEN_TTL_MS`) | how long a stored answer to a retried `/verify` still contains the plaintext media token |

Scrubbing the plaintext token from a stored answer never changes the call, its audit history or the token's hash (`media_nonce_hash`), and never extends or shortens a credential. A retry after the window is a
well-formed `duplicate` answer **without** `mediaToken`; it issues nothing. This is the documented contract: a gateway that lost the first response and retries after the window must start a new call.

## Operations

* Migration `sql/v4_25_phone_verification_peer.sql`, rollback `sql/v4_25_phone_verification_peer.rollback.sql` (idempotent both ways).
* Environment: `PHONE_PEER_SIGNING_KEY_PEM` (EC P-256), `PHONE_PEER_KID`, `PHONE_PEER_TTL_S` (10-60), `PHONE_PEER_MAX`, `PHONE_PEER_SIGNAL_BUDGET`, `PHONE_REPLAY_TOKEN_TTL_MS`. Keys are never committed.
* The relay now also carries `restart` and `rebuild` (the browsers' recovery requests, which the server previously rejected).

## Tests

`tests/phone-peer.pg.test.mjs` (12 tests, real server process, real PostgreSQL, real socket.io clients): lifecycle, capability isolation, credential rules, failure handling, three race tests plus a deterministic stale-read
test, idempotent termination, token scrubbing (real and controlled clock), and the missing-migration case. Final code: 10 consecutive runs, 12 of 12 each. Existing suites: `phone-lifecycle` 37/37, `phone-server` 2/2,
`bridge-contract` 3/3, `consent-lock` 3/3. **Not covered here:** real Chrome, the real Security Shield server, Redis-backed gateway limits, and any real telephone or carrier.
