# Qorlla Chat V1.0–V1.5 source integration kit (NOT production certified)

This source kit includes a React/Tailwind reference UI, Express/PostgreSQL backend, Redis outbox, rich text sanitation, optimistic idempotency, message edit history, read receipts, soft deletion, OAuth PKCE primitives, ClamAV INSTREAM scanner adapter, and optional private Ollama adapter. It is **not** an integrated or certified Qorlla deployment.

## Install and validate

- Node 22+, PostgreSQL 16+, Redis 7+, ClamAV daemon, and your **real** Qorlla Portal/Shield authority services are required.
- `npm install`, `npm test`, `npm run build`.
- Apply `sql/001_chat.sql`, then `sql/002_durable.sql` using `psql -v ON_ERROR_STOP=1` to a **disposable database** first.
- Configure `.env.example` via your secrets manager, never commit secrets.
- `npm run server` starts the API; `npm run dev` starts the frontend development server.

## Authority contract that MUST be verified

`POST QORLLA_AUTH_INTROSPECT_URL` with service bearer and `{token}` must return `{active:true,userId:string,tenantId:string}`. `POST QORLLA_MEMBERSHIP_URL` with service bearer and `{userId,tenantId,workspaceId,meetingId,action}` must return `{allowed:true}` only when authorized. These are **assumed adapter contracts**, not established Qorlla API facts. Do not use this kit against live services until confirmed.

## Existing UI caveats

The UI is inherited from the prior V1 prototype. It has unintegrated endpoints (new conversation, bookmarks, pin, tasks, upload), no real Portal token acquisition, and uses legacy `execCommand` editing. These controls must not be represented as fully working in this kit. It is intentionally not seeded with demo users. A Portal integration must inject an authorized session and replace the legacy editor with a structured editor such as TipTap/ProseMirror, then validate content on the server.

## Security/release blockers (NO-GO)

1. Actual Portal/Meet/Shield source and exact authorization contracts unavailable; need explicit action scopes, tenant identifiers, guest policy, and revocation semantics.
2. Tenant ID backfill and NOT NULL constraints are pending for pre-existing rows; no live migration has been run. Application role privileges and RLS must be established, tested and audited before use.
3. Attachments module provides ClamAV scanning and quarantine-to-clean promotion primitives but **does not yet expose safe upload/download routes**, storage ACLs, or MIME magic-byte verification. No attachment should be accepted in production.
4. OAuth supports PKCE state and encrypted token storage but **does not implement remote provider revocation**, full file browsing, provider-specific token refresh, webhook validation, or secure callback session binding across browser redirects. OAuth must remain disabled.
5. Redis outbox uses at-least-once publishing. Clients must deduplicate by outbox ID. Event replay is via sequenced message GET; edits/deletions need separate event replay, not yet present.
6. Chat message edits/deletes are protected by membership checks but outbox event sequencing for mutations reuses the original message sequence; a separate monotonically increasing event counter is needed for reliable cross-instance event replay.
7. AI endpoint accepts caller-supplied messages, which must be replaced with server-fetched authorized chat messages. The entitlement check is a placeholder authority action, not verified against subscription service. Do not enable in production.
8. Browser still uses a development-oriented authentication pattern; CSRF, cookie policy, websocket credential lifecycle, distributed rate limits, Origin policy, and OAuth redirect validation require integration.
9. No complete PostgreSQL, Redis, ClamAV, cloud OAuth, browser, security, performance, or Workspace/Meet/Shield regression suite has been run.

## Suggested integration order

1. Inspect the real Qorlla GitHub repo, current Chat routes, session middleware, tenant IDs, Meet/Shield contracts, navigation, and migration runner.
2. Implement a narrow Portal-backed adapter and integration tests, deny on unavailable authority.
3. Migrate and backfill tenant columns in a transaction; test RLS with real roles and concurrent tenants.
4. Complete event sequencing and replay; then wire UI and Cloud/attachments.
5. Run threat model, negative tests, isolated stack, full browser and service regression, and formal release gate.

**Verdict: NO-GO for production. No deployment or repository changes performed.**
