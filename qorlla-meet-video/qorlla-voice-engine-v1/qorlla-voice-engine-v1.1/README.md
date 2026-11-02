# Qorlla Voice Engine — self-hosted internal VoIP foundation

No Twilio dependency. Supports authenticated account-to-account WebRTC signaling, internal extensions, call history, transactional state transitions, call idempotency, block checks, and short-lived TURN credentials.

## Setup
1. Node 20+, PostgreSQL, HTTPS reverse proxy, and self-hosted coturn required.
2. `npm install` then `cp .env.example .env` and set values in a secret store. Never commit `.env`.
3. Provision a least-privilege database user and run `npm run db:migrate` with a migration role.
4. Insert `voice_identities` rows only from trusted Qorlla account provisioning, never anonymous clients.
5. `npm test`, then `npm start`. Reverse-proxy HTTPS and WSS, with strict origin validation.
6. Integrate `web/VoiceClient.ts` with the existing frontend and JWT issuer.

## Critical integration requirements
- This is **reference code, not production-ready**. The WebSocket currently accepts a JWT as a query ticket. Before production, replace with an authenticated **one-use, short-lived WS ticket**, because URLs can appear in logs. Bind ticket to account and origin, consume atomically, and disable query logging.
- Replace JWT issuance with Qorlla's actual authentication; verify issuer, audience and subject. The server assumes JWKS-based RS256/ES256 signing.
- Browser microphone access happens only when the user explicitly answers or starts an accepted call. The caller UI must invoke `startAcceptedCall(callId)` after a verified `call_accepted` event. The callee buffers early offers until acceptance. Add tests for simultaneous offer/answer ordering before deployment.
- Add ringing timeout, disconnect reconciliation, call state broadcasts to all user devices, retry semantics, rate limiting at ingress, authenticated presence, and per-device ownership.
- Add SDP/candidate semantic validation, signaling order checks, ICE candidate buffering, WebRTC TURN failover, ICE restart, and robust error cleanup.
- Add account-scoped retention, encryption at rest, consent controls, incident monitoring, and security audit. Add policy for simultaneous sessions and extension uniqueness.
- The SQL unique indexes protect caller and callee roles independently; the transaction also checks both roles under advisory locks. Test this under concurrent PostgreSQL load.
- The server does not implement Meet media mixing or PSTN connectivity. Qorlla Meet integration requires a separate compatibility audit and certified SFU/media gateway.
- The service has no user registration endpoints by design; identities are provisioned by trusted backend operations.
- TURN uses coturn REST credentials: `use-auth-secret`, `static-auth-secret`, and `realm` must match the deployment. Protect TURN ports and bandwidth.
- Metering and billing require trusted event aggregation; do not charge customers from client-supplied durations.

## Safety gates
Internal calls only. No public telephone numbers, emergency calling, SIP/PSTN, paid carrier calling, or claims of production certification.
