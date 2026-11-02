# Qorlla installable clients — Milestones 3–9 engineering pack

This is an incremental source and contract package built on the Milestone 2 starter, **not a certified production release**. It does not contain signed installers or completed native WebRTC, billing, CallKit, APNs/FCM, or store releases.

## Included executable additions
- Shared call event parser, E.164 validation and fail-closed PSTN release policy.
- Ed25519-signed installer-manifest verification and tamper test.
- Restricted Qorlla deep-link validation and push notification payload filter.
- Device registry SQL schema and OpenAPI contract (no claim of wired endpoints).
- Seven milestone implementation and certification specifications.
- CI test scaffold and real-repository integration map.

## Tests
`node --test packages/contracts/tests/*.test.cjs apps/desktop/tests/release-policy.test.cjs apps/mobile/tests/device-policy.test.cjs`

To execute existing desktop/mobile tests, install dependencies in each application and run `npm test`. To build binaries, use OS-specific signed release runners and follow `docs/RELEASE_GATES.md`.

## Safety
PSTN, billing capture/refund, device registration and remote meeting actions remain server-authoritative and disabled until integrated and certified. No release credentials or secrets are bundled.
