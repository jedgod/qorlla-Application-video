# Qorlla Join Meeting by Telephone — Fail-Closed Integration Starter

**Status: NOT a working PSTN/SIP/RTP gateway.** This starter supplies a safe admission contract and tests. It cannot accept actual telephone calls, play IVR announcements, transcode audio, or bridge media. Never advertise a dial-in number until an operator-certified inbound carrier and SIP/RTP-to-Qorlla SFU/mixer bridge are deployed.

## Install and test

```bash
npm install
npm test
npm run build
node dist/src/example-wiring.js
```

The example is intentionally nonfunctional (it answers 401 to everything): capability checks require authentication; inbound admission requires signed gateway webhooks; all readiness flags are false. Do not substitute a hardcoded `true` for security gates.

## Integration sequence

1. Wire `authenticateGateway` to Qorlla session and authorization middleware; wire `verifyWebhook` to authenticated mTLS gateway identity or a provider-signed, timestamped, replay-protected webhook using raw-body verification as required by the provider. Never trust inbound `callId` or `dialedNumber` from a public client.
2. Replace `rateLimit` with the existing distributed rate limiter. Add per-call replay/idempotency and admission state in durable storage. The example is NOT safe for public exposure.
3. Implement `MeetingAuthority` using Qorlla meeting ID/passcode validation, admission policy, host approval, meeting capacity, ban/suspension rules, and revocation.
4. Deploy a certified carrier trunk and SIP ingress that terminates RTP/SRTP, handles DTMF/IVR, and plays the unavailable message when disabled. The HTTP `announcement` field alone does not produce telephone audio.
5. Implement `SipRtpBridge` with actual bidirectional audio into Qorlla's meeting SFU/mixer, media negotiation, codecs, ICE/TURN interoperability, hold/leave handling, teardown, and recording consent policy.
6. Implement gateway-level call-state lifecycle: ringing, IVR prompt, passcode entry, host approval waiting, connected, disconnected, timeout. Enforce capacity, anti-fraud, emergency restrictions, geographic and regulatory constraints.
7. Obtain operator approval for real inbound dial-in numbers; keep placeholder/reference numbers non-dialable and clearly labeled.
8. Verify billing certification and plan entitlements before activating charged routes. Do not charge callers while uncertified.
9. Gate production enablement on carrierConnected, inboundNumberCertified, gatewayHealthy, mediaBridgeCertified, billingCertified and productionApproved, all from authoritative backend checks, not environment flags alone.
10. Run end-to-end PSTN-to-meeting audio tests with physical phones across networks, failure injection, load, accessibility, security and privacy reviews before public rollout.

## API contract

- `GET /api/v1/phone-join/capabilities` — authenticated, no-store availability. A readiness backend that fails or answers incompletely reports `telephoneJoin: false` (503 on failure).
- `POST /api/v1/phone-join/inbound/admit` — **gateway-only** admission request (`{ meetingId, passcode, callId, dialedNumber }`, strict: unknown fields are refused). Returns a JSON decision and an announcement for the gateway to speak, not a SIP response. Malformed, non-object or oversized bodies get `400/413 INVALID_REQUEST` as JSON.

| Status | Code | Meaning |
|---|---|---|
| 200 | `MEDIA_CONNECTED` | authorized, approved if required, and the bridge confirmed live audio |
| 503 | `PHONE_JOIN_UNAVAILABLE` | the six readiness conditions are not all met (or the ledger is down); nothing else is contacted |
| 403 | `INVALID_JOIN_REQUEST` | meeting id, passcode, call id or dialed number is malformed |
| 403 | `JOIN_DENIED` | wrong meeting or passcode, or the meeting refuses phone joins |
| 403 | `HOST_APPROVAL_DENIED` / `HOST_APPROVAL_TIMEOUT` | the host refused, or did not answer in time |
| 409 | `DUPLICATE_CALL` | this call id was already admitted (replay or retry) |
| 503 | `MEETING_SERVICE_UNAVAILABLE` | the meeting or host-approval service failed or timed out |
| 503 | `MEDIA_UNAVAILABLE` | the bridge failed, timed out or did not establish audio; the call is torn down |

## Rules the code enforces (so integrators cannot weaken them by accident)

- **Six readiness conditions** (`READINESS_KEYS`): `carrierConnected`, `inboundNumberCertified`, `gatewayHealthy`, `mediaBridgeCertified`, `billingCertified`, `productionApproved`. Each must be exactly `true`. Judged against that list, not against the keys supplied: a missing, partial, truthy-but-not-`true`, `null` or non-object readiness is **not ready**. (An earlier version of the starter treated `{}` as ready and admitted calls; this is covered by a test.)
- **Host approval is required unless the meeting says `requiresHostApproval: false`.** Only a literal `true` from the host approves; silence for `hostApprovalTimeoutMs` (default 60 s) is a refusal.
- **Timeouts** (`stepTimeoutMs`, default 10 s) on the meeting lookup, the call ledger and the media bridge: a hung dependency is a refusal, never a hung call.
- **Teardown:** if `attach` fails, throws, times out or reports no media, `disconnect` is always called (the bridge may have half-attached), and `disconnect` must be idempotent.
- **Replay protection:** pass a durable `CallLedger` (atomic `claim`, `release` after a failed admission) in `admission`; a call id is admitted at most once. Without a ledger the contract is not replay-safe: production must supply one.
- Responses are `Cache-Control: no-store`.

## Production components (integration milestone)

Beyond the admission core, this package now has the adapters a deployment needs. All are fail-closed and none enables telephony: see `docs/MEET_INTEGRATION.md` for how each maps onto the real Qorlla Meet and Security Shield,
the gaps found in Meet, and what is still BLOCKED.

| Module | Purpose |
|---|---|
| `src/ledger-pg.ts` + `sql/001_phone_join.sql` | PostgreSQL call ledger (primary-key ownership across replicas, validated transitions, append-only history, crash reaper) and the gateway-token replay store |
| `src/gateway-auth.ts` | verifies the workload token Qorlla already uses (ES256 JWT, optional mTLS binding), single-use, body-bound |
| `src/rate-limit-redis.ts` | Redis rate limit shared by all replicas; refuses when Redis is unavailable |
| `src/meet-authority.ts` | `MeetingAuthority` over Meet's real endpoints (resolve, signed verify/disconnect, host decision by polling) |
| `src/shield.ts` | Security Shield authorization, re-check loop and fail-closed termination |
| `src/media-contract.ts` | the SIP/RTP-to-WebRTC contract and the audio-evidence rule behind `MEDIA_CONNECTED` |
| `src/compose.ts` | `terminateCall`: media, then Meet, then the record |

A timed-out dependency is **cancelled** (every call receives an `AbortSignal`), not merely abandoned: a media leg that is created after its step timed out is found and terminated, the call id stays claimed until that is settled, and a leg that cannot be terminated is marked `orphaned` and reported (`onLateMedia`).

## Tests

`npm test` builds and runs 80 tests. The first 29 (`admission.test.ts`, `server.test.ts`) need nothing; 18 more need PostgreSQL or Redis and are skipped, and reported as skipped, unless these are set:

```bash
export PHONE_JOIN_TEST_DATABASE_URL=postgres://...   # any database the tests may create a throw-away schema in
export PHONE_JOIN_TEST_REDIS_URL=redis://...
```

They cover: disabled-by-default and the six gates (including missing/partial/malformed readiness); request validation; wrong meeting or passcode; host refusal and silence; unavailable and hanging services; media that is not established / throws / hangs;
late media legs and orphans; replay and concurrent duplicates across replicas (real PostgreSQL); stale-claim reaping; the transition table and append-only history; gateway tokens (algorithm, issuer/kid/subject/audience, expiry, replay, body and certificate binding, compatibility with Meet's real signer);
the Redis limiter under concurrency and when Redis is down; the media-evidence rule; Meet (signature known answer, PIN/lockout, waiting room, timeouts, ghost-caller cleanup); the Shield (refusal, unreachable, re-check, grace period); and one full pipeline over HTTP.

## UI copy while unavailable

> Join by phone is not available yet. To join now, open the meeting link in Qorlla and choose computer audio. Any listed telephone numbers are for reference only and cannot connect you to a meeting.

## Important

Do not replace Qorlla's internal-extension provider with a public-number provider. Public numbers and PSTN remain OFF. This package should live on a separate feature branch and must not be merged or deployed until all release gates pass.
