# Meet breakout rooms (v4.29, V1.1 = v4.30)

Built from `Qorla-chat-page-ext/qorlla-breakouts-v1` and the V1.1 milestone ("real WebRTC room switching"), integrated into Meet's own `server/index.js` signaling, token authentication and PostgreSQL
instead of the package's adapter interfaces (`sql/v4_29_breakouts.sql`, `server/breakouts.mjs`, scope hooks in `server/index.js`, `server/chat.mjs`, `server/more.mjs`, UI in `public/collab.js` and `public/app.js`).
The five tabs (Chat, People, Notes, Polls, More) are unchanged; the controls live in More, Collaboration, Breakout rooms.

## How a room works
Every participant has a **scope**: the main room or one breakout room. Meet already builds one `RTCPeerConnection` per person in the `roster` event, so scoping is done where the lists and relays are made:
* `roster`, `names`, `participant-online/offline`, `hand`, `media-state`, `reaction` are delivered only inside a scope; `signal` (offer/answer/ICE) is refused between two scopes, so no media can cross rooms
  even from a hostile page.
* **Moving someone**: the old scope is told they left, the new scope that they arrived, and the mover gets a new `roster` + `breakout-scope`. The page closes every old peer connection and tile and negotiates
  the new ones (the same code path as joining a meeting, including glare handling and epochs), then reloads the chat for the new room. Verified in three real browsers with fake-device media: people in a room decode
  each other's frames, nobody outside does.
* **Chat (Everyone)** written in a room is stored with that room (`messages.breakout_room`) and delivered, listed, exported (Save chat), edited, deleted, pinned and task-listed only inside it. Private (direct) chats are not scoped.
* **Main-room tools** (Q&A, whiteboard, timer) answer 409 inside a room, their pushes go to the main room only, and their buttons are disabled for people in a room.
* **Timer**: the host picks 1 to 240 minutes; the deadline is stored on the session. A background tick (every 5 s) ends sessions whose time is up with one atomic UPDATE (safe with several instances), clears assignments and
  brings everyone back. A chip shows the room name and the countdown; one minute before the end everyone is told.
* **Host**: creates/deletes rooms, assigns people (also live, while rooms are open), "Split people" evenly, opens the rooms, **visits** a room (and leaves it), brings everyone back. Only the host (Meet has two roles; the package's
  "cohost" does not exist here). Every action is audited in `more_events` (`breakout.*`).
* **Reconnect**: the scope map is rebuilt from PostgreSQL (`ensure`), so a restarted server or a reconnecting person returns to the right room (unit-tested).

## V1.1 (v4.30): room-scoped Notes and Polls, return to the main room, ask for help
Built from `Qorla-chat-page-ext/qorlla-breakouts-v11` (the `qorlla-breakouts-consolidated-integration` folder is byte-identical copies of v1 and v11) and adapted to Meet's own code (`sql/v4_30_breakout_collab.sql`, `server/breakouts.mjs`, `server/collab.mjs`, `public/collab.js`).
The package's adapter interfaces (`meetAuthority`, `mediaCoordinator`, `eventHub`, `meet_breakouts.*` tables, a "cohost" role) do not exist in Meet, so the same rules were implemented on Meet's token, signaling and tables.
* **Polls**: `meeting_polls.breakout_room` (NULL = main room). A poll belongs to the room the host is in, or to the room they pick in the poll form ("Send this poll to"; rooms must be open). Only people in that room list, read, vote on or get events for it
  (a person in another room gets 404, not 403: the poll does not exist for them). The host sees every poll, tagged with its room, and can vote only inside the poll's room. After the rooms close, room polls stay with the host (review, export) and are no longer listed for guests.
* **Notes**: each room has its own document (`more_room_notes`); the server picks the main or the room document from the caller's scope, so the Notes tab is unchanged (it shows "Room notes · <room>"). Everybody in the room edits it; there is no version history, restore or edit-grant inside a room (409/empty).
  The host reads any room read-only (`GET /notes?room=<id>`, "Notes" button per room in the panel). `notes-updated` goes only to the room. The legacy meeting-wide socket events (`notes`, `poll-create`, `poll-vote`) refuse while rooms are open so they cannot reach a room.
* **Return to the main room**: `POST /breakouts/return` (any guest in a room; the host uses Leave room). The server changes the scope first (media from the room is refused at once), persists the choice (a restart keeps it), cancels the person's open help request and tells both rooms; their page then rebuilds its peers like any move. The host can still move them again.
* **Ready acknowledgement**: after a move the page says `breakout-ready` once its peers are connected (or after 15 s). Until then the host's list shows "(connecting…)". This is informational and client-reported: authorization never waits for it (the package's *trusted* media ACK needs a media server that can verify readiness; Meet's media is peer-to-peer, so there is nothing trusted to ask).
* **Ask for help**: `POST /breakouts/help` (only a person in an open room; one open request per person enforced by a unique index; 30 s cool-down). Only the host's sockets get `breakout-help`; the host chip counts requests, the panel lists them with Visit and Resolve; the asker can cancel; ending the rooms or moving the person closes the request. Audited as `breakout.help.*`, `breakout.returned`.
* **Fixed on the way**: the breakout panel no longer wipes a half-typed room name when a refresh arrives; the page drops unsaved note edits typed in the last second before a room change (with a message) instead of saving them into the new room.

## Recording and consent
Recording in Meet is a local capture of the host's page, so with rooms open it would hold only one room: starting rooms is refused while a recording session exists, and `/recording/start` answers 409 while rooms are open.
No new consent purpose is introduced: nothing is captured, transcribed or sent to AI because of a room. The portal's AI export still reads the Everyone-chat of people who consented to AI, including room chat.

## Not covered (honest list)
* **Group leads** (a guest with limited powers inside a room), room-to-room moves by guests (a guest can only return to the main room), a re-join prompt: not built. Room notes have no version history; a guest cannot read the notes of the room they left.
* **Multi-instance**: the scope map is in memory (rebuilt from PostgreSQL per process); a deployment with several Meet processes needs the scope shared (Socket.IO adapter / Redis) or sticky routing per meeting.
* **TURN relay-only, Safari, real phones, load, malicious-signalling fuzzing and an independent security review** have not been done. Production stays NO-GO.

## Operations
* Apply `sql/v4_29_breakouts.sql`, then `sql/v4_30_breakout_collab.sql`, as the database owner, then re-run `sql/005_app_role.sql` (grants the new tables; DELETE on `more_breakout_rooms`).
* Rollback: `DROP TABLE more_breakout_help, more_room_notes; ALTER TABLE meeting_polls DROP COLUMN breakout_room;` (V1.1), then `DROP TABLE more_breakout_assignments, more_breakout_rooms, more_breakout_sessions; ALTER TABLE messages DROP COLUMN breakout_room;` (v4.29), and deploy the previous image.
* Tests: `node --test tests/breakouts.test.mjs tests/breakouts-v11.test.mjs` (real PostgreSQL: setup, moves, scoping, expiry, restore, chat isolation; V1.1: help, return, ready, polls, notes) and `tests/e2e/breakouts.e2e.mjs`, `tests/e2e/breakouts-v11.e2e.mjs` (real browsers with real WebRTC: host + two guests).
