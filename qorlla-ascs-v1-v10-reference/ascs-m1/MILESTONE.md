# Qorlla ASCS-M1 — Integration and certification contract

Status: IMPLEMENTATION PLAN — NOT PRODUCTION CERTIFIED
Scope: v1.0–v2.0; v3.0–v10.0 remain gated.

## Repository integration points
- Meet: mount authenticated share routes and publish screen tracks through the existing WebRTC peer/SFU path. Do not create another signaling server.
- Shield: use authoritative meeting membership and presenter approval on every mutation; revoke sharing on approval withdrawal.
- Portal: fetch subscription capabilities server-side, fail closed when unavailable; do not import illustrative plan defaults from the reference package as policy.
- Database: allocate a new migration version after checking Meet's migration ledger. Do not apply the reference SQL unmodified.
- Web: mount ShareContentPanel in the current Meet toolbar; capture must be user-initiated and browser-selected.

## API contract
POST /api/meet/:meetingId/shares
Body: {kind: screen|window|tab, mode: content, clientRequestId: UUID}
Returns: {id, meetingId, ownerId, revision, state: pending|active}
DELETE /api/meet/:meetingId/shares/:shareId
Returns: {stopped: boolean, revision}
POST /api/meet/:meetingId/shares/:shareId/heartbeat
Returns: {leaseExpiresAt, revision}
POST /api/meet/:meetingId/shares/:shareId/activate
Body: {publicationId, expectedRevision}
Host-only: POST /api/meet/:meetingId/shares/:shareId/revoke

Use existing auth middleware, CSRF protection, rate limiting and Shield decisions. Never accept role, subscription, actorId, publicationId ownership or meeting membership from client assertions. Validate publicationId against the authenticated WebRTC peer before activation.

## State machine
idle -> pending -> active -> stopping -> stopped
pending -> failed/expired
active -> revoked/expired/stopped
Use monotonically increasing revision per meeting, a lease deadline, and a unique idempotency key scoped to meeting+actor. A repeated request returns the same outcome, even after the share is stopped; never starts a second share.

## Atomicity and recovery
Commit share state, audit record and outbox event in one PostgreSQL transaction. Publish after commit from a leased outbox worker. Use a unique event id and receiver deduplication. Use compare-and-swap revision checks to prevent stale events from resurrecting stopped shares. Reconcile active share against live WebRTC publication; expire stale leases. Revoke media at the SFU/bridge, not only in the UI.

## Capture and audio
Call getDisplayMedia only from a user gesture. Browser/OS controls source picker. Request audio optionally; check returned audio tracks and show actual status. Attach ended listeners; stop server share when browser capture ends. Stop all captured tracks on cancel, errors, leave, or revocation. Do not claim native system-audio support where browser lacks it.

## Presenter handoff
Host requests revoke -> Shield authorizes -> server commits revoked state and signals media termination -> host grants next presenter -> new share begins after previous lease/media publication is invalidated. Test concurrent start requests and late signaling events.

## Certification matrix
- Unit: policies, idempotency, revisions, roles, entitlement failures.
- Integration: real PostgreSQL, real Shield, Portal sessions, outbox crash/replay, host revoke.
- Browser: Chrome, Edge, Firefox; screen/window/tab capture as available; optional audio.
- Network: same LAN, separate networks, TURN relay-only, ICE restart, reconnect, browser tab closed.
- Devices: Windows desktop, Android physical device; document unsupported native capture separately.
- Security: guest admission, cross-tenant access, CSRF, forged role, replay, stale revision, unauthorized media publication.
- Load: multi-participant and multi-meeting test with agreed concurrency target; record CPU, packet loss, latency and failure rates.

## Go/no-go evidence
Record branch/commit, migration IDs, test commands, exact passing counts, browser/OS versions, Shield and Portal revision, media topology, failure logs, rollback steps, and signed approval. No deployment/merge/tag before authorization.

## Known reference-package gaps to fix first
- start() checks presenter occupancy before replay idempotency: retries may fail.
- stop() needs authoritative membership validation and revoked-session handling.
- audit and publish are invoked inside a transaction; external signaling must use a transactional outbox.
- current frontend source selection is browser-controlled; don't advertise enforced window/tab selection.
- in-memory or illustrative entitlement mappings cannot stand in for Portal policy.
