# Qorlla Shield v2.3 — repository-specific integration slice

Based on the supplied committed source archive at `4e16f49`. This is **not production-certified**.

## Implemented
- Main App `server.js` Socket.IO `join_room` now optionally enforces a one-time Shield media credential for guests, and requires `emailVerified` for registered joiners when `SHIELD_V23_SIGNALING=true`.
- `shield-client.cjs` uses real Node `https.request` with mandatory CA and client certificate/key, rejecting invalid TLS. It requires an injected, short-lived workload credential provider function; it never falls back to a shared secret.
- `admission.cjs` has explicit fail-closed decisions and negative unit tests.
- Existing Main App guest session check remains in place. A guest must pass **both** checks.

## Configure
Set `SHIELD_V23_SIGNALING=true`, `SHIELD_URL=https://...`, `SHIELD_CA_FILE`, `SHIELD_CLIENT_CERT`, `SHIELD_CLIENT_KEY`, `SHIELD_WORKLOAD_TOKEN_MODULE` (absolute path to a trusted CommonJS module exporting an async `function(path)` that gets a fresh scoped token from your production workload issuer). Set the Voice Engine's `SHIELD_ENABLED=true`, `SHIELD_ENFORCE=true`, `SHIELD_REQUIRE_WORKLOAD_IDENTITY=true` only in a controlled staging environment with registered principals. Ensure the reverse proxy authenticates and forwards the verified mTLS workload identity and that the issuer policy binds JWT subjects to the TLS peer identity. A client certificate alone is not a SPIFFE implementation.

## Critical remaining gaps — DO NOT enable in production
1. Main App guest frontend must implement `guest/request`, host decision, `guest/claim`, and deliver the credential to `join_room`. Without that it will refuse guests (intentionally).
2. The separate Meet service `qorlla-meet-video/server/index.js` uses its own JWT and Socket.IO middleware; it is **not modified** and needs separate credential enforcement and participant lifecycle wiring.
3. Main App registered users must be synced to the authoritative `shield_principals` records and checked for tenant membership, suspension, MFA and device trust. `emailVerified` is not equivalent to comprehensive identity verification.
4. Need actual workload issuer, certificate lifecycle and revocation, event outbox, risk ingestion and alerts.
5. WebRTC P2P cannot reliably terminate already-established media after a signaling disconnect; SFU/relay-mediated media is required for hard media revocation.
6. `shield-client.cjs` uses client mTLS; the voice engine TLS terminator must be configured separately. Do not enable until a real workload issuer exists.
7. Need end-to-end tests on real PostgreSQL, socket.io, both app servers and physical clients.

## Tests
`node --test security-v23/admission.test.cjs` and `node --check server.js`.

Release status: **BLOCKED**. Keep `VOICE_NUMBERS_ENABLED=false`, PSTN off, and RC2 unchanged.
