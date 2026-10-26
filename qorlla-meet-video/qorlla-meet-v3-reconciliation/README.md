# Qorlla Meet — Full-stack working foundation

A multi-feature conferencing starter derived from the supplied Qorlla Meet HTML. **Not a certified production conferencing service.**

## Included
- Responsive Qorlla-branded meeting lobby, gallery, speaker and stage layouts.
- PostgreSQL-backed meetings, guest join/passcode, signed meeting tokens, host-only end meeting.
- Realtime participants, persistent room chat, host notes, hand raises, reactions, host polls and votes.
- Browser camera/microphone, peer-to-peer WebRTC with Socket.IO signaling, screen sharing.
- Local-only browser recording of the current user's media (not composite/cloud recording).
- SQL schema, Docker PostgreSQL, security basics, health endpoint, and reference original HTML.

## Quick start (Node.js 20+ and Docker)
```bash
cp .env.example .env
# Edit JWT_SECRET with a secure random secret.
docker compose up -d
npm install
# Initialize schema (requires psql installed, or use docker exec):
docker compose exec -T postgres psql -U qorlla -d qorlla_meet < sql/schema.sql
npm run check
npm run dev
```
Open http://localhost:3000 in two browser tabs. For testing on different physical devices, deploy behind HTTPS (camera/screen APIs require a secure context). Allow network/firewall access and configure STUN/TURN. Join with the generated meeting URL. The optional passcode is needed for non-host users.

## Design and safety notes
- **Small meetings only**: browser mesh WebRTC scales poorly beyond a few participants. Replace mesh with an SFU (LiveKit or mediasoup) for production.
- The `ICE_SERVERS_JSON` sample contains a public STUN server only; production requires authenticated TURN.
- The project uses guest names and bearer meeting tokens, not a full identity provider. Add OIDC/SAML, tenant isolation, verified host identity, short-lived media grants, token revocation, waiting room, lock and moderation before public launch.
- The host secret is returned only on creation, not persisted in the browser; host sessions rely on the 8-hour signed token. Protect the secret and do not share it with invitees.
- WebRTC transport encryption is not the same as guaranteed end-to-end encryption. No E2EE claim is made.
- Browser local recording captures only local media. It does not record the complete meeting; it has no server consent enforcement. Obtain consent and add server-side recording policies before using this feature in real meetings.
- Notes are host-write/room-read, not collaborative CRDT editing. Polls are simple persistent votes. File transfer, whiteboard, AI, breakout rooms, webinars, cloud recording, billing, calendar, mobile-native SDKs and admin dashboard are **not implemented**.
- Add robust ICE candidate buffering, negotiation rollback/perfect negotiation, reconnect media renegotiation, TURN expiry, participant identity refresh, pagination, monitoring, audit coverage, CSP, CSRF protections if cookie auth is adopted, retention/deletion and load testing.
- `helmet` CSP is disabled for demo convenience; configure a strict CSP for production.
- No automated browser/device or load tests are included. `npm run check` validates JavaScript syntax only.

## Suggested next milestones
1. Identity, roles, meeting permissions, moderation, waiting room and secure invitation lifecycle.
2. LiveKit SFU and coturn, reconnection testing, multi-device certification.
3. S3/MinIO recordings and files with consent, retention and malware scanning.
4. Whiteboard/CRDT, breakout rooms, AI transcription, accessibility and enterprise admin.
5. CI, integration/e2e testing, security review, observability, production deployment.
