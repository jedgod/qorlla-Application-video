# Qorlla Meet v4.0.4 — Enterprise Collaboration API (integration starter)

This package is an **add-on API**, not a fully integrated Qorlla release. It has not been executed against your repository, databases, browser, coturn, or recorder. It deliberately refuses to fabricate AI results or activate unscanned uploads.

## Install

1. Apply `sql/001_collaboration.sql` to a PostgreSQL database in a staging environment. Existing Meet meeting IDs must be mapped to UUIDs, or adapt the schema to the actual primary keys.
2. `npm install`; configure `.env.example` variables using your secret manager; `npm run check`; `npm test`; `npm start`.
3. **Critical:** wire the actual Meet meeting lifecycle to `meet_collab_meetings` and `meet_collab_members`. This package intentionally has no public meeting creation or membership-granting API. Admission/host identity must be synchronized by trusted server code in the same trusted control plane, never accepted from a browser.
4. Frontend calls `/api/v1/meetings/:id/...` with its Qorlla bearer JWT; connect to `/api/v1/collaboration/ws?meetingId=<uuid>` using subprotocols `['qorlla-auth', token]`. Prefer a secure, same-origin, short-lived WebSocket ticket in production; subprotocol JWTs may be logged by reverse proxies.
5. Frontend listens to event names `whiteboard.operation`, `breakout.created`, `breakout.assigned`, `breakout.closed`, `question.created`, `question.voted`, `question.answered`, `notes.updated`, `meeting.lock_changed`, `participant.removed`, `consent.changed`, `recording.consent_requested`, and `recording.state`.

## API index

- Whiteboard: GET/POST `/:id/whiteboard` (idempotent `operationId` UUID; append-only operations; clients implement a deterministic operation format and snapshots before production).
- Breakouts: GET/POST `/:id/breakouts`; POST `/:id/breakouts/:roomId/assign`; POST `/:id/breakouts/:roomId/close`. **Media routing is NOT implemented**: the Meet SFU/signaling layer must enforce breakout isolation.
- Files: POST `/:id/files/upload-intent`; GET `/:id/files`; GET `/:id/files/:fileId/download`. **Requires** an asynchronous object-store scanner that validates uploaded object size, type, malware, and metadata, then changes `pending -> ready` or `rejected` using a private service identity. Never allow a browser to mark files ready. Presigned PUTs need object-store size enforcement, quarantine, and lifecycle expiration before production.
- Q&A: GET/POST `/:id/questions`; POST `/:id/questions/:questionId/upvote`; POST `/:id/questions/:questionId/answer`.
- Notes: GET/PUT `/:id/notes` with revision CAS; GET `/:id/notes/export` as Markdown. Frontend copy invitation URL via GET `/:id/invitation` and `navigator.clipboard.writeText` after a user gesture.
- Attendance: GET `/:id/attendance`; meeting lock: PUT `/:id/lock`; removal: POST `/:id/remove`. **Existing Meet admission and signaling must enforce these DB states**. They do not automatically block legacy join routes.
- Consent: PUT `/:id/consent`; recording: POST `/:id/recording/request|start|stop`; security: GET `/:id/security`.
- Intelligence read APIs: GET `/:id/transcripts`, `/:id/captions?language=...`, `/:id/summary`. These deliberately have **no browser-write provider endpoints**. A trusted, separately authenticated provider worker must ingest transcript segments, translate, and summarize, after validating participant consent, vendor agreements, retention, and provider authenticity. No AI provider is integrated in this package.
- Tools: GET/PUT `/:id/settings` for non-sensitive UI preferences. Device selection stays in browser; do not store hardware identifiers without purpose.

## Production blockers and cautions

- No actual WebRTC breakout media isolation or TURN integration.
- No transcription/translation/summary provider implementation, consent withdrawal cancellation, or retention/deletion worker.
- No recorder process or encrypted recording storage. `recording/start` only authorizes recording in DB; it does not start a recorder. This needs a transactional recorder state machine and fail-closed media authorization.
- No secure malware scanning, file finalization, or per-object encrypted storage configuration.
- No integrated main app routes, HTML UI changes, meeting admission sync, migration against real schema, or end-to-end tests.
- No complete tenant isolation; deployment should use explicit organization ID, tenant membership and per-tenant policy checks.
- Meeting lock and removal must be enforced at the existing admission layer. Membership rows must be created/updated by authenticated Meet server lifecycle events, with `joined_at` and attendance sessions tracked there.
- WebSocket delivery is process-local; use Redis pub/sub or a durable event bus for multiple API replicas, and reconnect with resync.
- Security review: CSRF/origin protections for cookies (this API uses bearer), rate limits, schema validation, request size, file content inspection, URL allowlist, audit retention, and incident response.
- Q&A anonymous mode hides identity in normal listing but DB retains author identity. Set clear policy and restrict DB access.
- The supplied recording consent check is a baseline only: late joins, withdrawals, host disconnect, scope changes, recorder interruption and concurrent starts require additional controls.

## Acceptance plan

A1 identity and membership; A2 role restrictions; A3 whiteboard replay; A4 breakout media isolation; A5 file malware quarantine; A6 Q&A dedupe; A7 notes conflict; A8 invitation safety; A9 attendance join/leave; A10 locked admission; A11 removed user reconnect denial; A12 recording all-party consent; A13 late join/withdrawal; A14 encrypted recording storage/retention; A15 transcript opt-in; A16 translation opt-in; A17 AI summary provider; A18 browser and accessibility; A19 multi-replica event propagation; A20 audit integrity and backup/restore. None of these are claimed passed.
