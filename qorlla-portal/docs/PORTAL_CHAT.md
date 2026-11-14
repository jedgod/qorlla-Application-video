# Portal Chat (PostgreSQL, beside the main-app JSON chat)

Status: **implemented and tested in an isolated stack. Not production-certified. Production: NO-GO** (see section 8).
Decision record: `docs/CHAT_V1_PORTAL_INTEGRATION_MAP.md` (option A: a new Portal chat beside the old one). Nothing of the existing chat was changed:
`/api/workplace/chat`, `chat_changed`, the legacy room events, Meet's in-meeting chat and its integration export are untouched.

## 1. What it is

Workspace chat in the Portal service: **channels** (public: everyone in the workspace; or private), **groups** (private, 3+ people) and **direct messages** (exactly two, one per pair).
Code: `server/chat.mjs` (routes), `server/chat/markup.mjs` (rich-text sanitizer), `server/chat/hub.mjs` (live updates), `sql/017_portal_chat.sql` (+ rollback),
`public/assets/chat.js` (the page, `/app/chat`). Consumed helpers added to `server/entitlements.mjs`: `consumeQuota`.

| Feature | Notes |
|---|---|
| Everyone | every workspace has one shared **Everyone / All-on-Board** channel, created on first use (race-safe), the same for all members, with a reserved name; it cannot be renamed, archived or restricted |
| Messages | sanitized rich text (`<b> <i> <u> <s> <br> <ul> <li> <h2> <h3> <blockquote> <a href=https>` plus a FIXED palette of six colours `<fc-red|orange|green|blue|purple|gray>` and three sizes `<fs-sm|lg|xl>`, no attributes: `style`, `color`, `size`, `class`, `onclick` and every other attribute or tag is dropped or becomes text), plain `body` kept for search/export/AI; replies; edit with full version history; soft delete (text and every stored version are blanked); idempotent send (`client_key`); per-conversation sequence numbers |
| Conversation roles | workspace `owner`/`admin` create channels and pin, manage any conversation; a group's creator manages the group; everyone else reads/posts (unless the channel is admin-only or archived) |
| Reading state | read receipts and unread counts per person per conversation |
| Personal | private bookmarks; tasks created from a message (title, assignee who can see the conversation, due date, status open/done) |
| Search | per conversation, server-side, `%`/`_` taken literally; pinned / bookmarked filters |
| Save chat | `GET .../export` (text/plain download), members only, audited, never includes deleted messages |
| QorllaMate | `POST .../ai`: through the Qorlla AI Gateway only, private profile, see section 5 |
| Live updates | Server-Sent Events, see section 6 |
| Entitlements | `chat`, `chat.channels.max`, `chat.ai` rows in `portal.entitlements` (no row = 402) |

## 2. API (all under `/api/v1/chat`, all behind the Portal `member` middleware)

`GET config`, `GET conversations`, `POST conversations`, `GET|PATCH conversations/:cid` (the GET also returns `audience`: `workspace` + count, or `members`), `POST conversations/:cid/join`, `POST|DELETE conversations/:cid/members[/:uid]`,
`GET|POST conversations/:cid/messages` (`?limit&before&after&q&pinned=1&bookmarked=1`), `PATCH|DELETE .../messages/:mid`, `GET .../messages/:mid/versions`,
`PUT|DELETE .../messages/:mid/bookmark`, `PUT|DELETE .../messages/:mid/pin`, `POST .../messages/:mid/tasks`, `GET tasks`, `PATCH tasks/:tid`,
`POST conversations/:cid/read`, `GET conversations/:cid/export`, `POST conversations/:cid/ai`, `GET stream` (SSE), plus the switched-off `POST conversations/:cid/attachments` and `GET gifs`.
Identity, CSRF (double-submit token bound into the JWT), Origin and workspace come from the existing middleware; **nothing in a body, query or header is trusted for who someone is**
(`?workspace=` / `X-Workspace-Id` is only a selector that is checked against `portal.members`).

## 3. Isolation rules (tested)

* every query filters by the caller's workspace; an object in another workspace, or a private conversation the caller is not in, is a **404** (never 403), so ids cannot be probed;
* a reply must be in the same conversation as its target (a quoted preview can never leak text from another conversation);
* losing the `portal.members` row (removal from the workspace) cuts off every route at once, and open streams close within `revalidateMs` (60 s by default);
* removing someone from a conversation stops its live events immediately (the audience is recomputed from the database for every event);
* an admin cannot read a private conversation they are not in; admins may delete any message and pin in conversations they can see.

## 4. Database

`sql/017_portal_chat.sql`: additive, idempotent, `BEGIN/COMMIT`, schema `portal`, ten new tables (`chat_conversations`, `chat_members`, `chat_messages`, `chat_message_versions`, `chat_events`,
`chat_pins`, `chat_bookmarks`, `chat_tasks`, `chat_ai_requests`, `chat_audit`) and 12 entitlement rows. Rollback: `sql/rollback/017_portal_chat.down.sql` (**destroys all chat data**; take a backup).
The application role keeps its default `SELECT/INSERT/UPDATE`; the migration grants `DELETE` on exactly `chat_bookmarks`, `chat_pins`, `chat_members` (when the role exists). `chat_audit` is append-only
(trigger), holds no message text and no question. `docker-compose.yml` gets one additive mount line (`012i_portal_017_chat.sql`) so a fresh stack has the tables; existing databases must run the migration by hand like 015/016.

### Entitlement seed (a decision for the operator)
The migration seeds `chat` (granted) for all four plans, `chat.channels.max` = 5 / 100 / 1000 / unlimited and `chat.ai` = 10 / 500 / 2000 / unlimited per month
(basic / pro / business / enterprise). These numbers are **placeholders chosen by the developer, not a pricing decision**: change the rows in `portal.entitlements` (no deploy needed).
Delete a plan's `chat` row to switch chat off for that plan.

## 5. QorllaMate in chat

* Goes only through `createAiGateway().generateJson` with `ctx {feature:'chat', actorId, workspaceId, profile:'private', externalProcessing:false}`: private/self-hosted providers only,
  the gateway's own consent, rate and audit hooks apply (`portal.ai_gateway_audit` keeps a prompt hash and counts, never text).
* The **context is built by the server** from the last 40 non-deleted messages of that conversation (the caller must be able to read it), names replaced by labels ("Person 1", "Asker"), capped at 12 000 characters;
  nothing the browser sends as context is read. The system prompt tells the model that the excerpt is data, not instructions.
* Quota: `consumeQuota` reserves one unit under the workspace lock **before** the model is called; the same `client_key` never spends twice (409); a failed call is marked `failed` and **not counted**.
  The question and the answer are not stored (only who asked, where, when, status). `share:true` posts the answer as a `QorllaMate` message.
* Not verified: answer quality with a real private model (the tests use a stub adapter behind the real gateway).

## 6. Live updates (SSE) and its limits

`GET /api/v1/chat/stream?workspace=<id>` (cookie auth, `Last-Event-ID` or `?last_event_id=` to resume). Events: `chat` (a message was created, edited, deleted, pinned or unpinned; carries the CURRENT state, never old text),
`resync` (too many missed events: refetch), `ready`, `bye`. Heartbeat comment every 20 s; at most 5 streams per person; the session and workspace membership are re-checked every 60 s.
`GET .../messages?after=<seq>` is the REST catch-up.

* **Fan-out is in-process.** With more than one Portal instance, an event published on instance A is not pushed to a client connected to B; that client sees it only after reconnecting (replay) or via `?after=`.
  Running several replicas needs a shared adapter (Postgres LISTEN/NOTIFY or Redis pub/sub): not built.
* nginx: proxy the path with buffering off (`proxy_buffering off; proxy_read_timeout 1h;`; the server already sends `X-Accel-Buffering: no`). The deployed nginx config was **not** edited.
* Replay overlap: ids are assigned at insert and commits can finish out of order, so a reconnect also re-sends the last 5 seconds; the page applies events idempotently.
* A 15-minute Portal token that lapses ends the stream; the page renews the token and reconnects by itself.

## 6.1 The page (`/app/chat`, `public/assets/chat.js`)

Qorlla styling only. Left: **Everyone** first, then channels, groups, direct messages, **+ New chat** (a *To:* box that filters people, chips for the chosen people: one person starts a direct message, two or more start a private group; admins also get "Create a channel instead") and *My tasks*.
Each message: the author's avatar and name, time, an **edited** marker, and a hover toolbar *beside* the message with **Reply** and **More (...)**; on touch screens and narrow windows the same buttons sit *below* the message and are always visible, and every control is a real button, so the keyboard reaches it.
**More** menu, in this order: Copy, Quote, Edit (your own text messages), -, Bookmark, -, Pin for everyone (workspace owners/admins only), -, Create task (assignee, due date, status), then Delete (your own, or any as an admin). Arrow keys move through it, Escape closes it and returns focus.
Composer: **Who can see your messages?** (a popover filled from the server: the whole workspace and its size, or exactly the members; admins outside a private conversation cannot read it; QorllaMate reads a conversation only when asked and nothing goes to third-party AI), **T** (format toolbar: bold, italic, underline, strikethrough, text colour from the six-colour palette, text size small/normal/large/extra large, link (https only), headings, more), **GIF** and **File**.
The *Pinned* button opens a panel of the conversation's pinned messages (click to jump); search filters the loaded messages; *Save chat* downloads a text file; *Ask QorllaMate* opens the question dialog.
The format toolbar can only ever produce palette colours and the three sizes: the page maps the editor's `<font>` colours/sizes to the fixed tags and drops everything else, and the **server sanitizes again** (arbitrary `style=`/`color=`/`size=`/`onclick=` cannot be stored or rendered, tested). Pasting is plain text only.
The File menu lists Dropbox, Microsoft OneDrive, Google Drive, Box and Microsoft SharePoint as **disabled** entries ("Not connected: needs provider setup by an administrator") and *Your computer* (disabled with an explanation unless `CHAT_ATTACHMENTS_ENABLED=true`, and even then the server answers 501). No connector routes exist.

## 7. Switched off on purpose

| Feature | Server behaviour | Why |
|---|---|---|
| Attachments | `POST .../attachments`: 404 outside the conversation, **403 `feature_disabled`** when off, **501** even when `CHAT_ATTACHMENTS_ENABLED=true`; nothing is stored | no private object store and no malware scanner exist |
| GIFs | `GET gifs` and `kind:"gif"` messages: 403 unless `CHAT_GIF_ENABLED=true` and `CHAT_GIPHY_API_KEY` is set; then proxied server-side, only GIPHY https URLs accepted | the key stays on the server; search words go to GIPHY (a privacy decision) |
| Cloud-drive OAuth (Google Drive, OneDrive, Dropbox, Box, SharePoint) | **no routes exist** (404) | no provider app registrations or credentials; a fake flow would be worse than none |

The page shows the GIF and file buttons **visible but disabled with an explanatory tooltip** when the server says they are off, and the backend rejects the requests regardless of what the page does.

## 8. Not verified / blockers (production: NO-GO)

1. No real browser run against a deployed stack with a real MAIN login, no load test, no accessibility audit, no independent security review.
2. Attachments (object store + malware scan + quarantine + signed URLs) and cloud OAuth are not built.
3. Realtime is single-instance; no shared adapter.
4. Entitlement numbers are placeholders; real billing/plans must be confirmed.
5. The main-app JSON chat and the new chat are separate: no data migration, no shared unread counts or notifications (`chat_changed`).
6. Retention/moderation/legal hold for chat are not implemented; a deleted message is blanked, but its tombstone, pins and task titles remain.
7. The AI answer path is tested only against a stub model behind the real gateway.
8. Search filters the loaded messages (the 100 most recent) in the page; the API's `?q=` is not wired to a results list yet. There is no message "load older" control yet.
9. Not run: Safari/Firefox, a real phone, screen-reader testing, and the existing deployed-stack Playwright specs in `e2e/` (they need the full stack).

## 9. Lock-order note (a bug found by testing)
Conversation and message rows are locked with `FOR NO KEY UPDATE`, not `FOR UPDATE`: other transactions take a KEY SHARE lock on the same rows for foreign-key checks (a read receipt, a QorllaMate reservation), and `FOR UPDATE` conflicts with it, which could deadlock a post racing the same person's read receipt. A regression test races posts, read receipts, edits, pins, bookmarks and AI questions 12 times and requires zero 5xx.
