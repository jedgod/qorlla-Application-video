# ASCS v1–v10 delivery specification

Every version requires: API contract, feature flag OFF by default, authorization tests, audit events, migrations with rollback, browser E2E, observability, and deployment rollback. Do not infer readiness from unit tests.

| Version | Deliverable | Acceptance gate |
|---|---|---|
| 1 | Browser display capture, source chooser, stop on track ended | Chromium/Firefox/Edge manual and automated tests; no capture without gesture |
| 2 | Host permission, Shield admission, audio where supported, presenter handoff, ICE restart | Revocation stops media; two presenters cannot race; reconnect works on TURN |
| 3 | Slides adapter, synchronized page/laser pointer, speaker notes private | Unauthorized attendee cannot view notes; state replay on join |
| 4 | Docs adapter, live edit permissions, revision conflicts, autosave | Existing markdown format preserved; tenant isolation and revocation tests |
| 5 | Whiteboard CRDT or operation log, replay, retention | Concurrent edits converge; no cross-meeting data leakage |
| 6 | Presenter composition, layout/background settings | Pixel/visual regression; CPU/GPU and accessibility tests |
| 7 | Annotation, camera document sharing | Annotation permissions, undo, capture consent |
| 8 | Clips recorder with consent state machine, encrypted object storage | No recording without consent; retention/delete/export tests |
| 9 | Private A-Zee/Ollama jobs for summaries and actions | Explicit opt-in, internal-only egress, redaction and deletion tests |
| 10 | Cross-platform, Shield, load, failover, TURN, security certification | Release sign-off and verified rollback drill |

## API contract
POST /api/meet/:meetingId/ascs/shares body `{kind,mode,clientRequestId}` -> 201 `{id,...}`.
DELETE /api/meet/:meetingId/ascs/shares/:shareId -> 200 `{stopped}`.
GET /api/meet/:meetingId/ascs/state -> authenticated meeting-scoped snapshot (to implement).
POST /api/meet/:meetingId/ascs/handoff -> host-only atomic presenter transfer (to implement).
WebSocket messages: `share.started`, `share.stopped`, `share.revoked`, `share.updated`; authenticated subscription and ordered sequence numbers required.

## Mandatory integration adapters
1. `resolvePrincipal`: validate Portal session, CSRF for cookie auth, workspace tenant, Shield guest approval and effective meeting role.
2. `authorize`: fetch server-side subscription entitlements; never use client-provided plan.
3. `store`: real PostgreSQL transaction with row locking on meeting; persist start/stop and outbox in same transaction.
4. `publish`: durable outbox worker with retry, dedupe, monotonic event sequence; no direct best-effort broadcast as source of truth.
5. `publishTrack`: Qorlla Meet's existing peer/SFU signaling, DTLS-SRTP, TURN-only compatibility and negotiated track replacement.
6. Docs/Slides/Whiteboard: existing Workspace authorization, versioning and collaboration APIs; do not fork document stores.
7. Clips: server-authorized recording pipeline, per-participant consent, encrypted storage, retention and audit.
8. A-Zee: internal model gateway, Ollama as optional additional provider, opt-in, scoped data access, no third-party AI egress.

## Security invariants
- One active presenter per meeting unless a future explicitly designed multi-presenter mode is enabled.
- Host or Shield revocation must terminate both media and application-level publication.
- No unauthenticated HTTP/WS paths; origin/CSRF enforcement; rate limits; input validation; tenant and meeting checks.
- Guest admission does not imply presenter authorization.
- No media contents in audit logs; log metadata only.
- No public PSTN, numbers or third-party model requirement.
- No production release until real Meet, Portal, Shield, and browser/device integration passes.

## Known reference-package gaps
This package is intentionally NOT a deployable replacement for the Qorlla stack. Its store, auth, event transport, WebRTC publish bridge, workspace adapters, and v3–v10 feature implementations are integration contracts, not completed production services. The static ENTITLEMENTS matrix is illustrative and must be replaced with live Portal entitlements. The frontend is a component scaffold, not a certified Qorlla-themed implementation. Running tests demonstrates only the included core policy behavior.
