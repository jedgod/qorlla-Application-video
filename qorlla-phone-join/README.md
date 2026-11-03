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

## Tests

`npm test` builds and runs 29 tests (`test/admission.test.ts`, `test/server.test.ts`): disabled-by-default and the six gates (including missing/partial/malformed readiness), request validation, wrong meeting or passcode, host refusal and silence, unavailable and hanging services, media that is not established / throws / hangs, failed teardown, replay and concurrent duplicates, a ledger that is down, and the HTTP layer (unauthenticated callers, strict schema, malformed bodies, readiness failures, no-store).

## UI copy while unavailable

> Join by phone is not available yet. To join now, open the meeting link in Qorlla and choose computer audio. Any listed telephone numbers are for reference only and cannot connect you to a meeting.

## Important

Do not replace Qorlla's internal-extension provider with a public-number provider. Public numbers and PSTN remain OFF. This package should live on a separate feature branch and must not be merged or deployed until all release gates pass.
