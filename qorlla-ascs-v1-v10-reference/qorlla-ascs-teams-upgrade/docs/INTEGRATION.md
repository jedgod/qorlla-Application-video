# Qorlla Meet ASCS — Teams-level sharing upgrade (integration patch)

This patch is additive to the prior ASCS reference, **not a production-ready Teams clone**.

## Installation
1. Copy `web/capture-controller.ts` into the existing Meet frontend and `server/share-policy.mjs` into its trusted backend domain.
2. Implement `SessionApi` against authenticated Meet endpoints; server obtains identity from session, not request body.
3. Implement `Publisher.publish` and `unpublish` using the actual Qorlla Meet WebRTC/SFU transport; publish audio and video separately as supported, handle renegotiation and remote rendering.
4. On Share button click call `controller.start(kind, includeAudio)` directly (user activation is required by browser); do not make an awaited network call first.
5. On authenticated Shield/Meet revocation signal call `controller.revoked(shareId)`. A client handler is NOT sufficient: the SFU/gateway must independently stop forwarding revoked media and reject republishing.
6. Reconcile session status after reconnect, reload and server restart. Implement lease expiry and atomic presenter ownership in PostgreSQL, and transactional outbox for signals.
7. Treat capture surface as a hint. Browser chooses what to show; system audio is platform-dependent.
8. Do not activate unimplemented presenter modes. Standout, side-by-side and reporter require an actual compositor; do not imply the radio controls alone implement them.
9. Existing Portal subscription grants must be read server-side; do not import fictional entitlement limits from the earlier reference package.
10. Keep feature flag OFF until full certification.

## Release-blocking acceptance tests
- Real two-participant remote screen and optional audio playback, Chrome/Edge/Firefox.
- One presenter under concurrency, host transfer, guest approval, unauthorized tenant rejection.
- Actual SFU-side forced revocation and denial of subsequent frames, including malicious client ignoring revoke.
- TURN relay-only, ICE restart, network loss, tab capture ending, browser reload, server restart.
- Real PostgreSQL migrations and rollback, outbox recovery, multi-host races.
- Load, performance, accessibility, mobile capability matrix, security review, privacy consent and staging canary.

## Known limitations
This archive does not include your real Meet source, actual SFU publisher, authenticated HTTP routes, PostgreSQL session store, presentation compositor, Docs/Slides/Whiteboard, Clips, or AI integration. Those cannot be truthfully certified from this patch alone.
