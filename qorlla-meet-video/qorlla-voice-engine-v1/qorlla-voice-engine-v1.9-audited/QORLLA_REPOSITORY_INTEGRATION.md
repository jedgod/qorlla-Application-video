# Qorlla actual repository integration audit (2026-10-28)

Target: `jedgod/qorlla-Application-video`, `main` SHA `810e196349e00bd68befcf4b43ccdb3df80a3ae3`.

## Confirmed structure

- Root `server.js` uses Express and Socket.IO for existing Meet signaling.
- Root `auth.js` exposes `auth.portalTokens.jwks()` through `/.well-known/jwks.json`.
- Existing Meet state is file-backed; voice engine is an independent PostgreSQL/Redis service.
- Root `package.json` does not declare the standalone voice engine dependencies.

## Deployment integration (not automatic)

1. Run voice as a separate process on an internal port, never replace root `server.js`.
2. Confirm Qorlla portal-token issuer, audience, algorithm and `sub` semantics; configure `VOICE_JWKS_URL` to the root JWKS endpoint over a trusted service network. Do not use a static fake JWT or expose session cookies to the voice engine.
3. Create a tested user-provisioning adapter from Qorlla account IDs to `voice_identities` with account disable/revocation semantics.
4. Deploy dedicated PostgreSQL, Redis and coturn; apply migrations in staging first.
5. Proxy `/v1/voice/` including WebSocket upgrades to the voice service; enforce exact allowed origins and WSS.
6. Integrate `web/VoiceClient.ts` into Qorlla Phone UI only behind `QORLLA_VOICE_ENABLED=false` until certification.
7. Keep PSTN, public number inventory and dial-in disabled.

## Confirmed blockers

- PostgreSQL outbox ordering and replay high-water cursors are not fully certified under concurrent transactions.
- Device takeover signaling now stops the old browser media when it receives a `device_claimed` event; distributed delivery and offline recovery still need tests.
- This package is not merged into GitHub: GitHub branch creation returned HTTP 403 (Resource not accessible by integration).
- No real audio, two-node failure injection, or QVE-01..15 evidence has passed in this audit.

**Release status: BLOCKED.** Do not enable for users until all gates are evidenced.
