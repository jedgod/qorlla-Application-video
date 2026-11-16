# Qorlla Meet Breakouts V1.1 — repository integration candidate

Implements three server-side extension contracts: room-scoped Notes/Polls ACL, participant return-to-main request with trusted media ACK, and host-directed Ask for Help.

**NOT production ready or activated.** This is an add-on for the supplied V1 breakout package, not a patch to the actual Meet repository. It has no Meet UI, no real WebRTC coordinator, no verified event hub, no existing Notes/Polls route interception, and no PostgreSQL integration certification.

## Install order
1. Inspect existing Meet schema and the earlier `001_breakouts.sql` migration.
2. Apply `sql/002_room_collaboration.sql` to an isolated disposable PostgreSQL database after 001.
3. Wire `createRoomCollaboration` to Meet's actual token authority, SQL pool, media coordinator, and event delivery hub. Do not use Portal session tokens.
4. Apply `authorizeContent` to every Notes/Polls read, write, export and websocket subscription; `listScope` to every list endpoint. Preserve legacy ACL enforcement. For active breakouts, reject unscoped content. Ensure legacy meeting-wide content is explicitly migrated or intentionally withheld.
5. Implement recipient-filtered broadcasts: room content to room members only, help notifications to hosts/cohosts only.
6. Add participant controls: Return to main, Ask for help. Add host help queue and Resolve action. Show pending until trusted media ACK.
7. Handle room moves and reconnect with fencing/epoch checks in the actual Meet media coordinator; this candidate does not implement those checks.
8. Add server-side expiry/retry/outbox and verify concurrency; publication here is best-effort.
9. Test 3+ real browsers, TURN relay-only, Safari, mobile, race conditions, CSRF, tenant/meeting isolation, recording consent and all five Meet tabs.

## Security caveats
- An ACK is accepted only if `mediaCoordinator.verifyReady` confirms actual media readiness; client-supplied ACK alone is insufficient.
- Return-to-main updates authorization before media transition. Failed transitions must remain disconnected until safe recovery.
- Host/cohost room-wide Notes/Polls visibility in this module is a policy choice; review against Qorlla's actual content visibility rules.
- Existing Notes/Polls endpoints are not automatically protected by merely installing this module.
- The database constraint prevents duplicate open help requests; the 30-second cooldown is application-side and needs database-level hardening for concurrent multi-instance deployment.

## Validate
`node --test tests/*.test.mjs` and `node --check src/room-collaboration.mjs`.
