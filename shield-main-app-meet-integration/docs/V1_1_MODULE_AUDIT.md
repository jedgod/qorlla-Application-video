# Workplace v1.1 - Core Module Activation: repository audit

Audited on branch `feature/qorlla-workplace-v4.6-provider-certification` (commit at time of audit: see git log). Method: reading routes, stores, migrations and tests; no module was changed. "Exists" below means code is present, not that it is certified.

## Platform facts that shape the plan

| Area | What the repository actually has |
|---|---|
| MAIN app | Node/Express (`server.js`), static HTML pages, Socket.IO for meeting rooms (`webrtc_signal`, in-room chat). **No React/Next/Electron**; the desktop look is a web page. |
| MAIN persistence | `workplace.js` keeps mail, notes, calendar, whiteboards **and chat** in encrypted JSON files (`store.js`). PostgreSQL in MAIN only holds meeting-sync tables; `migrations/001_init_workspace_schema.sql` (users, meetings, meeting_chats, document_registry ...) is not what the running app uses. |
| Identity | MAIN accounts (username/password, JWT cookie). The portal (`qorlla-portal`, PostgreSQL schema `portal`) adds workspaces, roles and entitlements; MAIN users reach it through the v4.1 token bridge. **MAIN itself has no organisations**: workspace authorisation exists only in the portal. |
| Redis / object storage / TURN | **None present.** STUN is hard-coded to a public Google server in `index.html`; no TURN, no S3/MinIO, no Redis, no FFmpeg. |
| Tests | Playwright desktop tests for MAIN pages; node:test + E2E for the portal. |

## Module status (today)

| Module | Sidebar today | What exists | Gaps against the v1.1 definition | Status |
|---|---|---|---|---|
| **Chat** | opens `chat.html` | Working DM/group/public chats, members, join/leave, per-user read marks and unread counts, polls, folders, apps, history archive, socket "something changed" notifications (`/api/workplace/chat*`, `chat.html`) | Not in PostgreSQL (encrypted JSON files); no attachments; no search; no read receipts shown to senders; no Redis (single process); no per-workspace tenancy (MAIN has none); route is `/chat.html`, API is `/api/workplace/chat`, not `/api/v1/*` | **Partially Implemented** |
| **Phone** | link to portal `/app/phone` (404 outside the unified nginx) | Portal v4.3: PSTN telephony via Twilio (inbound routing, voicemail, click-to-call, browser dialer token), **off by default, never run against a real account** | The spec asks for in-app WebRTC audio/video calls between users, contacts, hold, device selection, incoming-call ring. Meet has WebRTC rooms but no 1:1 call model, no TURN, no call history for user-to-user calls | **Partially Implemented** (different feature: PSTN, unverified) |
| **Docs** | link to portal `/app/suite` (same limitation) | Portal v4.4: documents/sheets/slides in PostgreSQL with immutable versions, explicit sharing, optimistic concurrency, AI drafts. MAIN `docs.js`: 25 MB upload of meeting attachments into an **in-memory** catalogue | No collaborative (multi-cursor) editing, no object storage for uploads, no folders/organising, no rich-text editor (plain textarea / grids), MAIN upload catalogue is not persistent and shows no auth middleware | **Partially Implemented** |
| **Clips** | link to portal `/app/meet` (placeholder) | Nothing. Meet has a local-recording button (`MediaRecorder`) that saves in the browser only | Entire module: recorder UI, upload, storage, processing, library, playback, sharing | **Not Implemented** |

## Decisions required before building (these change the architecture)

1. **Where does v1.1 live?** (a) Extend MAIN (JSON-file store, no orgs) or (b) build the four modules in the portal (PostgreSQL, workspaces, roles, entitlements, audit already exist, one auth bridge). Recommendation: **(b)**, with MAIN's chat migrated into PostgreSQL by a one-way import. Building tenant isolation, attachments and audit a second time inside MAIN would duplicate the portal.
2. **Infrastructure to provision:** object storage (S3-compatible, e.g. MinIO for staging), a TURN server (coturn) with credentials, Redis (WebSocket fan-out, presence, rate limits), an FFmpeg worker image. None exist today, and calls "between two real devices" and Clips processing cannot be certified without them.
3. **Frontend framework:** the repository is plain HTML/JS. Re-platforming to React/TypeScript is a separate, large decision; the spec says "reuse existing". Recommendation: keep the current static/ES-module approach for v1.1.
4. **Chat migration:** existing encrypted JSON chats must be imported without loss; plan a dry-run importer with row-count and checksum verification.

## Proposed order and exit criteria (unchanged from the brief)

1. Chat -> PostgreSQL + attachments + search + receipts + Redis fan-out; two-account persistence test across restart.
2. Phone (WebRTC 1:1) -> signalling over the existing socket layer, coturn, call history; **two real devices** test.
3. Docs -> object storage uploads, folders, sharing, autosave, collaborative editing service (CRDT, e.g. Yjs), reuse of the v4.4 permission model.
4. Clips -> MediaRecorder studio, signed uploads, FFmpeg transcode/thumbnail worker, library, playback, sharing.

A module is reported Implemented only with: UI + API + migrations + permission tests + cross-workspace isolation test + an end-to-end test. Nothing in this audit is certified.
