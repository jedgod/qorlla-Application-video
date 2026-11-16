# Qorlla Meet Chat — repository integration candidate

**NOT PRODUCTION CERTIFIED.** This is an installable source-code integration candidate, not a verified patch to the actual Qorlla repository. No demo identity or authorization bypass is included. Chat denies access when the real Portal and Meet authorities are unavailable.

## Contents
- `server/index.mjs`: Express API, Portal introspection adapter, Meet membership checks, policies, messaging, Redis fan-out and authenticated WebSocket.
- `sql/001_chat.sql`: isolated PostgreSQL schema for conversations, membership, messages, versions, receipts, idempotency, pins, bookmarks, tasks, event log, audit.
- `web/src/main.jsx`: dark Meet Chat panel, header, settings menu, permission controls, pop-out, Everyone, New Chat, messages, Reply/More, formatting and composer.
- `tests/security.test.mjs`: starter sanitization tests.

## Setup in isolated test environment
1. `npm install` (Node 20+).
2. Provision PostgreSQL and Redis with private networking, TLS, credentials and backups.
3. Run `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/001_chat.sql` using a migration role.
4. Set `.env` values via your secrets manager; do not commit credentials.
5. Implement the *real* Portal and Meet internal authority contracts expected by `requestAuthority`; these URLs are placeholders until verified.
6. `npm test`; `npm run build`; `npm start`.
7. Mount `Chat` inside Qorlla Meet and pass actual `meetId`, `meetingTitle` and authorized `participantOptions`. Configure the reverse proxy to serve the API and WebSocket on the same origin.

## Explicit gaps / production blockers
- **No access to actual Qorlla source or service contracts.** Portal and Meet adapters are assumed POST JSON shapes and cannot be declared verified.
- No cloud OAuth, file upload, quarantine or malware-scanning implementation; attachment button is intentionally disabled.
- No GIPHY proxy; GIF button explains why GIF lookup is disabled.
- No QorllaMate / Ollama integration in this package.
- Pop-out opens a URL but actual Meet embedding/router must mount the chat view and preserve auth.
- No hardened CSRF integration, rate limiting, RLS, full audit on all mutations, durable outbox, distributed websocket subscription management, authorization revocation push, WS replay protocol, or complete event ordering for edits.
- `document.execCommand` is deprecated and formatting buttons require replacement with a supported structured editor.
- Missing complete policy semantics (host-to-host/direct cases), export permission rules, and task entitlement checks.
- No live PostgreSQL/Redis tests, browser E2E, load tests, Shield/Meet regressions, OAuth/attachment scans, or production certification.

**Do not deploy this package to production.** Integrate with Qorlla's actual source and close the blockers above first.
