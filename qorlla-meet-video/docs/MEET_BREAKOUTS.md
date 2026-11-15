# Meet breakout rooms (v4.29)

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

## Recording and consent
Recording in Meet is a local capture of the host's page, so with rooms open it would hold only one room: starting rooms is refused while a recording session exists, and `/recording/start` answers 409 while rooms are open.
No new consent purpose is introduced: nothing is captured, transcribed or sent to AI because of a room. The portal's AI export still reads the Everyone-chat of people who consented to AI, including room chat.

## Not covered (honest list)
* **Notes and Polls** are meeting-wide host tools and are not room-scoped.
* **Group leads, "ask for help", room-to-room moves by guests, a re-join prompt**: not built; guests cannot leave a room themselves.
* **Multi-instance**: the scope map is in memory (rebuilt from PostgreSQL per process); a deployment with several Meet processes needs the scope shared (Socket.IO adapter / Redis) or sticky routing per meeting.
* **TURN relay-only, Safari, real phones, load, malicious-signalling fuzzing and an independent security review** have not been done. Production stays NO-GO.

## Operations
* Apply `sql/v4_29_breakouts.sql` as the database owner, then re-run `sql/005_app_role.sql` (grants the new tables; DELETE on `more_breakout_rooms`).
* Rollback: `DROP TABLE more_breakout_assignments, more_breakout_rooms, more_breakout_sessions; ALTER TABLE messages DROP COLUMN breakout_room;` and deploy the previous image.
* Tests: `node --test tests/breakouts.test.mjs` (real PostgreSQL: setup, moves, scoping, expiry, restore, chat isolation) and `tests/e2e/breakouts.e2e.mjs` (host + two guests, real WebRTC, visit, expiry, recall).
