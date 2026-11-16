# Qorlla Smart Classroom V1.4–V1.7 — integration candidate

This bundle adds new source for milestones V1.4–V1.7. It is **NOT** repository-integrated, production-certified or deployed. The existing `qv-chat` Meet source is not available in this session. Do not turn on feature flags in production.

## Milestones

- **V1.4 Smart Classroom:** teacher dashboard, room counts, assignment planning and UI tabs.
- **V1.5 Interactive Learning:** timed exercises with DB clock expiry, per-participant unique submissions, room-specific append-only whiteboard operations, initial pointer canvas UI.
- **V1.6 Private Intelligence:** consent-checked, entitlement-reserved AI job request through an injected existing Portal AI gateway; no direct third-party or Ollama call. The actual worker, source minimization, redaction and report retrieval are NOT implemented.
- **V1.7 Closure candidate:** mission/group report storage, room-scope authorization, transactional outbox hooks and audit records, unit tests and a release checklist. Certification remains NO-GO.

## Contents

- `sql/005_008_classroom.sql` schema additions, assuming migrations 001–004 already exist.
- `src/classroom.mjs` server-side service; inject the actual Meet `verifyActor`, PostgreSQL `pool`, V1.2 `moveParticipant`, private Portal `privateAI`, consent authority, and entitlement service.
- `web/SmartClassroomPanel.jsx` React component for the existing **More** tab. Requires the host app's authenticated `api` wrapper and route wiring.
- `tests/classroom.test.mjs` initial fail-closed and assignment-planning unit tests.
- `prior/qorlla-smartrooms-v13.zip` prior V1.3 source including V1.2 archive.

## Critical gaps to close in the actual repository

1. Review SQL schema and reconcile all migrations 001–008 with actual Meet database constraints, identities, RLS and retention. Apply to disposable PostgreSQL first.
2. Wire service methods to actual Meet REST routes, WS relay and session authority; protect CSRF, origin, role, room scope and exports. **No HTTP server/routes are shipped in this bundle.**
3. Reuse the actual V1.2 movement epoch/fencing coordinator; never directly update assignments. Confirm peer teardown and new media using real multi-browser tests. A P2P browser ACK is not independent media proof.
4. Make board operations real-time and replayable to authorized members, including offline/reconnect and erase/undo. The sample canvas draws locally and POSTs strokes but does not replay other users' strokes.
5. Add background expiry of exercises, robust server clock behavior, accessibility and timer countdown UI.
6. Integrate the private Portal AI job worker, input minimization, consent revocation, subscription quotas, per-room retention, cancellation, privacy auditing, and safe report publication. No transcription is performed by this code.
7. Add route-level and PostgreSQL integration tests, three real browsers, TURN relay-only, Safari, Android/iOS phones, multi-server failover, load tests and independent security review.
8. Preserve Meet tabs Chat, People, Notes, Polls and More. Notes/Polls/recording must remain scoped through all code paths, including downloads and WS subscriptions.

## Testing

`npm test` and `npm run check` need Node.js 20+. No npm install is required for the server unit tests. The React component must be compiled in the existing Meet frontend toolchain.

## Release decision

**NO-GO** until all integration and acceptance gates above are independently demonstrated on the real `qv-chat` branch. No merge, push, restart, or deployment was performed.
