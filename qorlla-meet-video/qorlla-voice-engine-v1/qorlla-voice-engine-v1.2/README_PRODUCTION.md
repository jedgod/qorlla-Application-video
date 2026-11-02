# Qorlla Voice Engine v1.2 — Integration and certification pack

This is a **reference integration**, not a production-complete telephone system. It extends the existing v1.1 package. It has no Twilio dependency and supports only internet WebRTC voice.

## New files
- `src/device-leases.mjs`: transactional per-call/per-participant media-device ownership, 90-second renewable lease.
- `src/signaling-policy.mjs`: server-side authorization before SDP/ICE relay.
- `src/ice-policy.mjs`: fail-closed TURN configuration, optional relay-only mode.
- `sql/003_media_leases.sql`: durable lease records.
- `web/VoiceClient.ts`: serial inbound signaling, ICE candidate buffering, device claims and renewals.
- `test/signaling-policy.test.mjs`: adversarial signaling unit tests.

## Deployment
1. Review the full v1.1/v1.2 source and merge with the actual Qorlla Meet authentication and account models; do **not** run migrations against production without staging verification.
2. Use a dedicated PostgreSQL migration role. Configure TLS, database role privileges, backups, and least-privilege runtime access.
3. Deploy a self-hosted TURN service with TLS and short-lived REST credentials. Set `TURN_URLS`, `TURN_SHARED_SECRET`, `VOICE_ALLOWED_ORIGIN`, `DATABASE_URL`, `VOICE_REQUIRE_TURN=true`.
4. Set `VOICE_RELAY_ONLY=true` for a relay-only privacy test. Evaluate bandwidth and cost before using in production.
5. Ensure browser HTTPS/WSS and correct reverse proxy WebSocket upgrades. Redact URL query strings in access logs because the single-use ticket is in the WS URL.
6. Run `npm install`, `npm run db:migrate`, `npm test`, `npm start` in an isolated staging environment.
7. Integrate `web/VoiceClient.ts` into Qorlla's existing authenticated Phone UI. Add explicit user action for microphone permission.
8. Test two real devices on separate networks, including cellular, restrictive NAT, connection loss, rejected calls, multiple tabs, and reconnect.

## Important limitations and blockers
- This is not a verified, deployed end-to-end implementation. No real audio call, database migration, or browser cross-network test was executed here.
- A device lease is not a durable device authentication credential. A compromised account can replace a lease; use account-bound device registration and revoke-on-session-logout for production.
- Lease refresh failure currently emits `lease_lost` but does not forcibly close media. Wire the UI to hang up and revoke local tracks immediately on lease loss.
- WebSocket signaling uses per-account in-memory socket maps: deploy a Redis/NATS authenticated fanout or sticky sessions before multiple API replicas.
- The v1.1 implementation lacks SDP glare handling, reliable renegotiation, TURN-only tests, full reconnect/ICE restart, strong CSP/CSRF checks for cookie auth, and call-state recovery on page refresh.
- Calls use the existing account model adapter; audit authentication, permissions, logging, abuse/rate controls, and media metadata privacy.
- Meeting voice integration requires a compatible Meet SFU/media architecture audit; no PSTN or public numbers are provided.
- Add end-to-end Postgres concurrency tests and Playwright two-browser tests before release. Browser autoplay restrictions require an explicit user gesture.
- Operational readiness requires SLOs, metrics, capacity tests, backup/restore, incident response, and security review.

## Certification gates
G1: DB migrations and concurrency tests; G2: authenticated signaling and device takeover; G3: real TURN relay audio; G4: browser and accessibility matrix; G5: Meet roster/host controls; G6: security and operations. **All remain open until verified in the target repository and environment.**
