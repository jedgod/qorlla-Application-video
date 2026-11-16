# More V4.1 — Collaboration and Meeting Controls

This enhancement stays inside the existing five-tab sidebar: **Chat, People, Notes, Polls, More**. More is a compact, scrollable set of five native expandable groups. Desktop initially opens Collaboration; phones start with all five groups collapsed for a compact overview. Desktop and phone layouts use the current sidebar rather than a replacement navigation or a separate app.

## Available in this milestone

- Real-time reactions on the existing `reaction` Socket.IO event, with acknowledgments and a per-participant limit of three reactions per five seconds. The existing connection event budget remains in force.
- Durable meeting Q&A: participant questions await moderation; only the author and managers see pending/dismissed questions. Hosts/co-hosts publish, dismiss and answer; published/answered questions support one active vote per admitted participant. Questions and answers use text nodes in the UI. Meeting-wide and per-participant question caps bound storage.
- Host-assigned co-hosts. Only the primary host assigns/removes co-hosts; nobody can assign a participant from another meeting or demote the primary host. The backend reads current roles; revocation does not require a replacement JWT.
- Hosts/co-hosts manage chat, reactions, meeting lock, notes, polls and ending the meeting. A lock refuses new guest admission while keeping previously authorized participants connected. Existing join/passcode checks remain.
- Invitation copying, session information and a manager-only view of recent security-event names/times. No raw event details, secrets or addresses are shown.
- Personal countdown, focus view, existing gallery/speaker/stage layouts, device selection, larger text, reduced motion and manually refreshed WebRTC diagnostics. Diagnostics are actual current samples, not extrapolated quality scores. Timers/view preferences are local; they are not shared meeting state.

## Intentionally unavailable

Whiteboard, breakout rooms, secure shared files, captions, transcription, summaries/action items, QorllaMate, background effects and recording remain visible and disabled. No AI gateway is called, no transcript is captured, and the previous unconsented local recording button is disabled. Future intelligence needs explicit consent, verified entitlement and server-selected occurrence context through the private gateway. Files need scanning, access control and audit storage; recording needs consent, storage and retention.

**Managed screen-sharing permissions are also unavailable.** Current media is peer-to-peer. The signaling server cannot reliably distinguish camera video from a screen track already sent to peers. A client-only switch would give false assurance, so this panel does not advertise an enforced sharing restriction. A verified media-policy layer is required before enabling that control.

## Database and lifecycle

Apply `sql/v4_1_more.sql` as the database owner, then reapply `sql/005_app_role.sql`. No running database is migrated automatically by this enhancement. Without the migration, Q&A and advanced permission controls report unavailable; baseline reactions and primary-host meeting lock remain usable. Missing/failed storage never produces a successful Q&A response.

Every collaboration record references an opaque `meet_more_occurrences.id`. That occurrence is linked to the immutable meeting UUID, never the public Meeting ID/code. Current Meet UUIDs are terminal: ended meetings cannot be revived. A reused public code must resolve to a **new** meeting UUID and a fresh occurrence. Ended-meeting membership is checked for REST and every incoming socket event; expired tokens/ended meetings are disconnected. Q&A mutations lock the meeting/occurrence rows to serialize with termination.

Future whiteboards, breakouts, files, recordings and AI artifacts must reference the same occurrence identifier and enforce their own consent/access/retention policies. If recurring/reopen support is added, it must mint a new occurrence, renew admission credentials and scope the existing notes/polls/history to that new occurrence before launch. Do not add a generic `ended_at=NULL` operation.

## qv-chat compatibility contract

The linked `qv-chat` worktree was discovered and reviewed read-only through Git's worktree inventory: branch `feature/qorlla-meet-chat-upgrade`, reported HEAD `35ae1f0` (working files reviewed; no clean-worktree assertion). Its five tab names/IDs match. Its richer chat, collaboration and recording modules must be preserved. No files in that worktree were changed, branches merged, or external workstream messages sent. Preserve these hooks when integrating:

- Navigation: `.tabs [data-tab="chat|people|notes|polls|more"]` and `#tab-chat`, `#tab-people`, `#tab-notes`, `#tab-polls`, `#tab-more`. Tabs gain keyboard navigation and ARIA relationships; names and order remain stable.
- Existing chat socket event and acknowledgment format remain `chat` / `{ok,error}`. Backend host permission checks apply even to old/custom clients.
- Current chat input hooks `#chatText` / `#chatForm` continue to work. Replacements can consume the DOM event `qorlla:meet-permissions` with `{meetingId,occurrenceId,canManage,isHost,guestChat,reactions}`. The event is a UI notification, never an authorization credential.
- New REST endpoints are exclusively under `/api/meetings/:id/more`. New socket nudge `more:changed` contains only the meeting UUID; clients refetch the authorized view. Pending question content is never broadcast in a nudge.
- More is isolated in `public/more-panel.{html,css,js}` and `server/more.mjs`. Its integration preserves the pre-existing media-device recovery changes in `public/app.js`.

### Confirmed integration boundaries — do not overwrite qv-chat

| Area | Current workspace enhancement | qv-chat adoption requirement |
|---|---|---|
| Sidebar | Stable five `data-tab` values and `tab-*` IDs | Retain qv-chat's dock, resizer, panel lock, pop-out and keyboard behavior. Its mobile/docking grid must remain authoritative. |
| More renderer | `initMorePanel` | `public/collab.js` currently owns `buildMore()`, called by initialization, `load()` and `refreshMore()`. Delegate only that renderer; keep its structured notes/polls and socket listeners. Do not let two renderers replace `tab-more`. |
| Rich chat | Basic Everyone-chat boolean policy | qv-chat owns `public/chat-ui.js`, `server/chat.mjs` and four `chat_policy` values: `none`, `hosts`, `group`, `all`. Adapt the More control to the existing GET/PUT `/api[/v1]/meetings/:id/chat/policy` and `chat-policy` event. Do not flatten these policies to a boolean, widen private-chat access, or bypass conversation membership. Co-host support must be reconciled with that backend's host-only policy authority before enabling it there. |
| Notes/polls | Basic host/co-host controls | Preserve qv-chat's document revisions, edit grants, poll lifecycle and post-meeting access. Do not replace those authorization rules with a generic UI role check. |
| Recording | Unavailable in this workspace's implementation | qv-chat has consent/storage/recording modules. Preserve those flows and bind to their verified capability state; do not replace them with the former local recorder or infer readiness from the presence of source files. |
| URL mounting | Caller-provided API function; template loaded relative to module URL | Pass qv-chat's BASE-aware transport and use relative asset URLs for `/meet/` mounts. |
| Lifecycle | New occurrence per terminal meeting UUID | Preserve terminal UUIDs. Any future reuse/reopen support must mint and authorize a new occurrence for every artifact before enabling this module. |

This is an integration contract, **not a claim that the branches have been merged or that qv-chat has passed the new suite**. Adoption needs cross-workstream integration tests for the rich chat policy and structured notes/polls before deployment.

## Validation and rollout

`npm run check` includes SQL-backed in-memory PostgreSQL-compatible tests for moderation/privacy, votes, role revocation, reaction limits and occurrence isolation. Root Playwright tests in `tests/meet-more-ui.spec.js` exercise the actual UI with isolated API/media fixtures, including phone width, keyboard tabs, disabled recording/AI and text-injection safety. UI fixtures do not certify carrier, AI or actual device/media infrastructure.

Before production rollout, validate the migration/grants and concurrent transactions on a disposable real PostgreSQL database; validate multi-client sockets and device switching against real media; run capacity tests on a stable host. The in-memory SQL engine does not prove PostgreSQL locking/concurrency. Existing authentication, privacy, deployment and certification blockers from the security audit still apply. No protected services are restarted, migrated or deployed by source implementation/testing.


### Local validation evidence

- Meet syntax/backend checks: **9 passed, 0 failed**.
- Targeted More browser checks: **3 passed, 0 failed**; desktop and phone rendering inspected.
- Meet production dependency audit: **0 known vulnerabilities**.
- Screenshots and source hashes: `evidence/meet-more-v4.1/` at the repository root. The pictures use isolated meeting/media fixtures.
- No real PostgreSQL migration, real-media device certification, protected-service restart, merge or deployment was performed.
