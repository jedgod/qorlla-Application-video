# Meet More tab (v4.27): what is real and what is not

Built from the "More V4.1" design package (`Qorla-chat-page-ext/qorlla-meet-more-v41`), but wired into **Meet's own** token authentication, admitted-participant check, PostgreSQL and Socket.IO
(`server/more.mjs`, `sql/v4_27_more.sql`). The package's standalone router needs an adapter Meet did not have; rather than adding a second auth path or the `zod` dependency, the same API
shape was implemented directly on Meet's `auth` + `member`. A meeting row is one occurrence (a reused Meeting ID + password starts a new row), so nothing leaks between runs.

## Real
| Tool | Behaviour |
| --- | --- |
| Q&A | any admitted participant asks and upvotes (a second vote takes it back); the host answers, edits an answer, hides or unhides; hidden questions are invisible to guests and cannot be voted on |
| Timer | host starts (10 s to 3 h) or stops; the **server clock** decides the end, every participant counts down to the same moment; a chip shows in the meeting bar |
| Attendance | host only; from the connection sessions Meet already records (who, how long, how many joins, still in the room) |
| Focus mode / Layout | per person, saved server-side, restored on rejoin |
| Lock meeting, Recording, Invite, Settings, Reactions | use the existing Meet controls (host settings, recording consent flow, invitation link, settings dialog, socket reaction) |

Every change is written to `more_events` first (cursor: `GET /more/events?after=<id>`) and then pushed on the `more` socket event; a client that missed a push catches up from the log.

## Collaboration (v4.3 package, v4.28 migration)
From `Qorla-chat-page-ext/qorlla-meet-collaboration-v43`, again on Meet's own auth/DB/sockets rather than the package's adapter + WebSocket server:
* **Whiteboard (real):** one shared board per meeting occurrence. The host opens, closes, reopens, clears it and decides whether participants may draw. Every drawing is an operation (pen, line, box, oval, text, note, erase, undo-mine) that the
  server validates (bounded coordinates, `#rrggbb` colours, ids, 400 points per stroke, 200 characters of text, 5000 operations per board) and appends to `more_board_ops`; clients replay from a cursor, so people who join late or reconnect see
  the same board. Save PNG is client-side. Not built: live partial strokes (a stroke appears when its author lifts the pen), snapshots, export of the operation log.
* **Q&A:** anonymous option (others see "Anonymous"; the host and the asker still see the name, and the checkbox says so).
* **Reactions:** five more emojis behind the ... button; the server accepts the ten and allows at most 8 per person every 10 s.
* **Breakout rooms, Shared files:** still disabled. Breakouts need atomic media routing between rooms; files need private storage, quarantine and a malware scanner (none exists; chat attachments are also off for that reason).

## Meeting intelligence (v4.2 package, Portal route)
The v4.2 package (`Qorla-chat-page-ext/qorlla-meet-intelligence-v42`) needs capture/STT, a quota authority and a private-gateway adapter that Meet does not have, and the Workplace Portal already runs a
consent-gated AI Meeting Intelligence (AI provider, quota, reports, PDF/DOCX export). So the cards use what is real instead of a second AI stack:
* **AI Summary / Key Takeaways:** show live consent counts from Meet (`GET /consent-status`, `GET /ai-consent`); the host can ask everyone (`POST /ai-consent/request`); once someone agreed the button opens the Workplace page
  (`<mainOrigin>/app/ai`) where the report is generated from the messages of people who agreed. Guests see their own choice. Answers are refreshed every 8 s while the tab is on screen.
* **Live Transcript, Ask QorllaMate:** stay disabled (no speech-to-text service, no question endpoint on the gateway).

## Not built (buttons stay visible but disabled; the API answers 503 `This tool is not available yet`)
Breakout rooms (media routing), Shared files (quarantine, malware scan, encrypted object storage), Live transcript (STT pipeline + consent),
AI Summary / Key Takeaways / Ask QorllaMate (the consent-gated private AI gateway), Background & effects (video effects pipeline). See the package README for each gate.

## Operations
* Apply `sql/v4_27_more.sql` as the database owner, then re-run `sql/005_app_role.sql` (it grants the app role the new tables and DELETE on `more_question_votes`).
* Rollback: `DROP TABLE more_question_votes, more_questions, more_timers, more_preferences, more_events;` and deploy the previous image.
* Tests: `node --test tests/more.test.mjs` (real PostgreSQL) and `tests/e2e/meet-tabs.e2e.mjs` (host + guest in a real browser).
* Production stays NO-GO: no load, reconnect-storm, or independent security review has been done on this module.
