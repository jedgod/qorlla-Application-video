# Qorlla ASCS v1–v10 integration reference

This source package includes a working policy/service core, HTTP handler adapter, React capture panel, PostgreSQL migration, Node unit tests, and a ten-version delivery/acceptance specification.

## Run
`node --version` (20+ required), then `npm test`.

## Integration
Do not run `npm start` as a public server. Mount `makeShareHandler` behind existing Qorlla Meet authentication and supply production implementations for its dependencies. Map SQL to the actual Meet database schema, and implement an outbox worker. `ShareContentPanel` requires a bridge to the real Meet WebRTC media publisher. Browser source choice cannot be forced by the app. Audio availability varies by browser and operating system.

## Status
Reference implementation / NOT PRODUCTION CERTIFIED. Versions 3–10 are specified, not implemented. See docs/ROADMAP.md for integration contracts and certification gates.
