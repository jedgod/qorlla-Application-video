# Qorlla Meet Collaboration V4.3 — integration source, NOT production certified

This is an isolated code foundation. It has NOT been merged into Meet, deployed, or connected to real Meet/Shield authorization. The feature flags for whiteboard, breakout rooms, files and transcription are intentionally OFF.

## Contents
- `sql/001_collaboration.sql`: occurrence-scoped PostgreSQL schema, events, reactions, whiteboard ops, breakout rooms, file metadata, Q&A, transcripts and audit.
- `src/server.mjs`: Express API, basic websocket fan-out and routes for reactions, Q&A, board operations, breakout assignment and transcription start.
- `src/unconfigured-adapter.mjs`: deliberately fail-closed identity/media/consent adapter.
- `tests/core.test.mjs`: validation unit tests.

## Local isolated validation
`npm ci` (after generating and reviewing a lockfile), `npm test`, `npm run check`.
Apply SQL only to an isolated PostgreSQL database. Set `DATABASE_URL` and `MEET_ADAPTER_MODULE` to an adapter reviewed against real Meet contracts.

## Critical limitations / TODO before activation
1. Existing Meet DB and schema migration compatibility; confirm occurrence ID mapping and host/cohost/guest identities.
2. Real Meet authentication for HTTP and WS, CSRF/Origin enforcement, revocation push, reauthorization, connection limits.
3. Reliable multi-instance event outbox, distributed fan-out, replay, idempotency and backpressure; current WS is process-local only.
4. Reaction rate limit must be concurrency-safe and distributed (current query is illustrative).
5. Whiteboard needs client renderer, snapshots, version/conflict resolution, bounded operation schemas, author permissions and exports.
6. Breakout moves need atomic media coordination/reconciliation, guest admission rules, room leader capabilities, recall, timer, and failure recovery.
7. Shared files: no upload/download endpoints. Must implement private object storage, quarantine, ClamAV or equivalent, file-type verification, safe PDF/DOCX conversion, signed access, retention, auditing and scan fail-closed.
8. Document creation/editing should reuse Qorlla Docs where authorized; never expose its Portal session as Meet identity.
9. Teacher transcription needs approved media capture, explicit participant consent, private STT, retention, speaker authorization and a secure bridge to the Portal AI gateway.
10. Q&A needs voting, moderation, anonymous unlinkability policies, pagination and persistent audit.
11. Database isolation must be audited against actual Meet role grants; no RLS is configured here.
12. Full browser tests for Chat, People, Notes, Polls, More; Meet/Shield security, PostgreSQL concurrency, load and outage tests.

Do not enable the disabled flags until their services and tests exist. Do not apply this migration to production without review.
