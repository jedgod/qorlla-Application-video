# Qorlla Chat V1.0-V1.7: where it can attach in the real code (integration map)

Status: **design and findings only. No chat code is added by this document. Production: NO-GO.**
Source of the findings: a read-only inspection of this checkout (the qlaunch stack's source). Line numbers are approximate. Re-check them before relying on them.
Subject: the standalone packages `qorlla-chat-consolidated_v1.0-v1.7` (and the Meet chat packages), which were written against *assumed* Portal/Meet contracts.

## 1. There are three apps, not one "Portal"

| App | Where | Store | Owns |
|---|---|---|---|
| **MAIN** | repo root (`server.js`, `auth.js`, `workplace.js`, `store.js`) | JSON files (`store.js`, optional AES-256-GCM) | accounts, login sessions, the real product chat (`/api/workplace/chat`), the legacy built-in room chat |
| **Workplace Portal** | `qorlla-portal/` (ESM Express) | PostgreSQL, schema `portal` | workspaces, members and roles, plans, entitlements, usage, AI gateway, audit |
| **Meet** | `qorlla-meet-video/` | its own PostgreSQL (schema `public`) | meetings, participants, in-meeting chat (`messages`), Shield enforcement |

## 2. The real contracts (what the packages must be written against)

**Identity.** MAIN is the only login: opaque 32-byte token in the HttpOnly cookie `qs` (only its sha256 is stored). The verified user is `auth.getUser(req)`: `id` = `u_<uuid>`, `username`, `displayName`, `email`, optional `plan`; **no tenant/workspace/org fields**. CSRF in MAIN is opt-in per route (`X-CSRF-Token`). The Portal accepts a 15-minute RS256 JWT in the cookie `qorlla_portal_session` (claims `sub` = account UUID without `u_`, `sid`, `csrf`; keys at `/.well-known/jwks.json`), checks session liveness against `GET /api/auth/internal/session/:sid` (bearer `PORTAL_INTROSPECTION_SECRET`, 5 s cache) and requires Origin + double-submit CSRF on unsafe methods. Portal fails closed (503) if auth is not configured. **Meet does not accept Portal JWTs**: it issues its own HS256 meeting-scoped token `{meetingId, participantId, role, name}` (8 h). MAIN-to-Meet trust is by shared secrets (`x-qorlla-bridge-secret`, `x-qorlla-readonly-secret`) or a single-use handoff code.

**Membership.** Workspaces exist only in the Portal DB: `portal.workspaces`, `portal.members(workspace_id, user_id, role owner|admin|billing|member)`; the `member` middleware validates `X-Workspace-Id` and sets `req.workspace`/`req.role`. MAIN has **no** workspace concept (chat membership is a JSON array of user ids). In Meet, host/guest is `participants.role`, admission is `admitted|waiting|denied`, and `org_id`/`account_id` are free text used only for the Shield. The Shield decides whether an admitted participant may keep a signalling session; it is **not** a chat ACL.

**Existing chat that must keep working.** (a) MAIN `/api/workplace/chat/*` (channels, spaces, DMs, polls, folders, bots) and the socket event `chat_changed`; (b) the legacy room events `send_chat_message` / `chat_message_received`; (c) Meet's socket event `chat`, the `messages` table and `GET /api/integrations/meetings/:id/chat` (consumed by the Portal AI consent export). User-id model `u_<uuid>` must be preserved.

**Subscriptions.** Two unsynchronised places: MAIN `user.plan` (JSON; `meeting-limit.js`, "real billing is not connected") and the Portal `portal.plans / entitlements / subscriptions / usage_events` with helpers `quotaFor`, `effectivePlan`, `PlanLimitError` (402), `withWorkspaceLock`. An atomic quota **consume** exists only inline in `POST /usage` (workspace lock, idempotency key, sum, insert); it is not a reusable function. AI per-day quota counts audit rows and is not atomic. Meet enforces no plan limits except the free-plan time limit that MAIN registers.

**Database conventions.** Portal SQL `qorlla-portal/sql/NNN_name.sql` (idempotent, `BEGIN/COMMIT`, rollbacks in `sql/rollback/`), explicitly listed in `docker-compose.yml`; app role `qorlla_portal_app` gets SELECT/INSERT/UPDATE on schema `portal` by default privileges, DELETE only per listed table; audit tables use immutability triggers. Meet SQL `sql/v4_N_*.sql`, re-run `005_app_role.sql` afterwards. 015/016 are not mounted in compose; 012-014 are absent.

**AI (QorllaMate / private Ollama).** Only the Portal reaches Ollama, through `server/ai/gateway.mjs` (`createAiGateway`) and the Ollama adapter (allow-listed host, HTTPS for remote, DNS-rebinding guard, concurrency/queue/size caps, fail-closed config). Feature code calls it with `{feature, actorId, workspaceId, orgId, profile:'private'}`; `portal.ai_gateway_audit` stores hashes and counts, never prompts. External providers need `workspace_ai_settings.external_processing` (default off). Raw chat from other people must pass the Meet AI-consent gate (`stillConsented`, `requireAiSource('chat')`).

**Not present at all:** Redis, object storage in MAIN/Meet, a malware scanner, any cloud-drive OAuth client (Google Drive, OneDrive, Dropbox, Box, SharePoint), an `x-actor`/`x-tenant` header scheme, a `qorlla_chat` schema, a multi-instance realtime layer (presence maps are in-process).

## 3. Mismatches with the packages' assumptions

| Package assumes | Reality | Consequence |
|---|---|---|
| `tenantId` | only `portal.workspaces.id` (Portal) | map tenant to workspace id, or drop it; MAIN has none |
| `x-actor` style identity | cookies (`qs`, Portal JWT + CSRF) | adapters must verify the cookie/JWT, never a header |
| schema `qorlla_chat` | app roles only touch `portal` (Portal) or `public` (Meet) | put tables in `portal` (new numbered migration) or add a role + grants |
| Redis fan-out | no Redis | use the existing socket.io `notify` -> `user:<id>` rooms, or build an adapter |
| SQL message store | MAIN chat is JSON (`u_<uuid>`, 5000-char text, no edits/attachments) | new module beside it, or a one-way import; do not rewrite the JSON store in place |
| Portal introspection `{token}` -> `{active,userId,workspaceIds}` | introspection is `GET /api/auth/internal/session/:sid` -> `{active, sub}`; no workspace list | workspace comes from `portal.members` |
| generic entitlement/quota service | `quotaFor` + inline atomic usage insert | extract a reusable `consumeQuota()` first |
| direct Ollama proxy (V1.6) | Ollama only behind the Portal AI gateway | V1.6's orchestrator must call the gateway, not Ollama |
| Meet membership by user id | Meet keys on `participant_id` (per-meeting session) | meeting chat stays in Meet; the Portal reads it through the existing export |

## 4. Recommended seams (least change, most reuse)

1. **Workspace chat (V1.0-V1.5 features): a new module in the Portal service**, mounted like `docs-extension.mjs` (`member`, `roles`, `withWorkspaceLock`, `quotaFor`, `PlanLimitError`), tables in schema `portal` (`qorlla-portal/sql/0NN_chat_*.sql` + rollback + compose mount), audit with the append-only trigger pattern. Workspace UUID is the tenant; identity/CSRF/Origin come for free.
2. **Keep `/api/workplace/chat` and `chat_changed` working.** Run the new chat beside it; any move of old data is a separate, reversible, one-way import.
3. **QorllaMate in chat: call `createAiGateway.generateJson` with `profile:'private'`**; reuse its audit, consent and quota hooks. Do not add a second Ollama client.
4. **Meeting chat stays in Meet** (own branch: `feature/qorlla-meet-chat-upgrade`). Portal consumers keep using `GET /api/integrations/meetings/:id/chat`, which must never include private (direct) messages or deleted messages.
5. **Realtime:** reuse MAIN's socket.io rooms for notifications; a Portal-side socket needs an nginx path and a new auth step. Single-process only until a shared adapter exists.

## 5. Decision needed before any build

The user-facing Workspace Chat today lives in MAIN (JSON, cookie `qs`), while the SQL chat with workspaces, plans and quotas can only live in the Portal. Pick one:
* **A. New Portal chat beside the old one** (recommended): new tables and routes, new UI entry that calls Portal APIs with the Portal JWT; old chat untouched. Cost: two chats until a migration.
* **B. Extend MAIN's JSON chat** (edits, pins, tasks, attachments): least new infrastructure, but there is no workspace/tenant concept or quota authority there, so V1.3 (membership) and V1.4 (entitlements) cannot be met as specified.

## 6. Phases (each ends with tests; none is started)

| Phase | Work | Exit criteria |
|---|---|---|
| P0 | Decide A/B; extract `consumeQuota()`; add rollback-able `portal` chat migration | migration applies and rolls back on a scratch DB |
| P1 | Messaging core: conversations, members from `portal.members`, messages, edits, pins, bookmarks, tasks, idempotency, audit; real-time via `notify` | authorization and cross-workspace isolation tests (negative cases), 100% of routes behind `member` |
| P2 | Entitlements: `ai.chat`/`chat.*` features in `portal.entitlements`; quota consume with idempotency | concurrent-consume test cannot exceed quota |
| P3 | QorllaMate via the AI gateway, private profile, consent-filtered context built **server-side** | no client-supplied context; audit rows hold hashes only |
| P4 | Attachments: private object store + malware scan + quarantine + signed URLs | **blocked**: no scanner or object store exists; EICAR test required |
| P5 | Cloud-drive OAuth (PKCE, server-side encrypted tokens) | **blocked**: needs provider app registrations and credentials; none exist |
| P6 | Browser regressions: existing chat page, Meet chat, Shield, admission, subscription gating; load test | full regression green; independent review |

## 6.1 Not verified

Everything above is read from code, not exercised. Re-confirm line numbers and the plan/entitlement behaviour in a running stack. This document grants no readiness.
