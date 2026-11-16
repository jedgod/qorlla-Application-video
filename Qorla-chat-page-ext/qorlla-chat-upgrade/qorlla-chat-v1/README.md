# Qorlla Chat Integration V1.0 — integration worktree, NOT production certified

This is a PostgreSQL-backed integration foundation and a retained UI reference. It is NOT a production-ready Qorlla application. No existing Qorlla repository, API contracts, verified identity introspection schema, Meet/Shield membership endpoints, object storage, cloud OAuth app registrations, or CI infrastructure was available to connect or certify. Do not deploy.

## Included
- PostgreSQL schema for conversations, memberships, messages, bookmarks, pins, tasks, attachment metadata, audit records.
- Fail-closed API authentication via a required Qorlla introspection endpoint (assumed request `{token}`, response `{active,userId,workspaceIds}`); membership authority (assumed request `{userId,workspaceId,meetingId,action}`, response `{allowed}`); **these are proposed adapter contracts, not verified existing Qorlla APIs**.
- Server-side HTML allowlist, parameterized SQL, moderator-only pin/unpin, owner-only edit, rate limit, WebSocket room events with authorization and 60-second forced reconnect.
- Tailwind build configuration and retained prototype React styling.

## Explicitly incomplete / blocked
- Frontend retained from prior prototype still assumes demo user IDs and endpoints not yet implemented; it must be adapted to actual Qorlla authenticated fetch and room navigation. Do not expose it as a live chat app.
- Conversation creation and membership enrollment require authoritative Qorlla directory and Meet/Portal integration; intentionally not implemented.
- Attachment upload/download is **not enabled**. Require private object storage, authenticated signed URLs, streamed malware scanning/quarantine and clean-status checks before delivery. Schema alone does not implement scanning.
- GIPHY integration currently uses a browser API key in the reference UI; production requires privacy/consent and server proxy policy. GIF and file message types are not enabled in backend.
- Cloud OAuth connectors (Google Drive, OneDrive, Dropbox, Box, SharePoint) not implemented; require provider credentials, OAuth authorization code + PKCE, server-side token storage/encryption and provider-specific scopes.
- Multi-instance real-time events require Redis pub/sub or transactional outbox; current WS broadcast is process-local and does not guarantee delivery.
- CSRF/origin handling, CSP policy, multi-tenant role policy, audit insertion, message deletion/retention, content moderation, accessibility, observability, backups, migrations/rollback and full security testing remain to be integrated and certified.
- This package does not preserve unknown existing Qorlla API contracts; it must be reconciled with the real repository.

## Local backend prerequisites
`DATABASE_URL`, `QORLLA_AUTH_INTROSPECT_URL`, `QORLLA_AUTH_SERVICE_TOKEN`, `QORLLA_MEMBERSHIP_URL`, `QORLLA_MEMBERSHIP_SERVICE_TOKEN`, `QORLLA_WEB_ORIGIN`, optional `PORT`, `PGSSL=require` for TLS.

Run migration with your managed migration tool using `sql/001_chat.sql`. Start with `npm install && npm run server`. Server refuses startup if required identity authority settings are missing. Do not assume a passing startup implies production readiness.

## Release gates
1. Map existing Qorlla Chat routes/navigation, Portal session model, Meet membership and Shield admission.
2. Replace proposed auth/membership adapters with verified contracts and contract tests.
3. Build secure conversation provisioning, object-store upload scanning, provider OAuth, and multi-instance real-time delivery.
4. Adapt UI to live identity, authorization, new-chat directory, rich-text editor and backend routes.
5. Run Postgres integration, E2E, authorization-negative, XSS, IDOR, OAuth callback, malware EICAR, WebSocket revocation, reconnect, load, accessibility and rollback tests.
6. Obtain explicit release approval. **Current verdict: NO-GO**.
