# Private room AI reports, shared room events and relay-only TURN (Meet v4.32/v4.33, Portal 017, Voice Engine admin TURN API)

Branch `feature/qorlla-room-ai-events-turn` (worktree `C:\Users\cj_wo\qv-roomai`). Built on `feature/qorlla-meet-chat-on-qlaunch` (5310774). **Nothing here is merged, deployed or applied to any live service.** All migrations were run only on scratch PostgreSQL databases.

## Release decision

| Scope | Decision |
|---|---|
| Isolated development and staging with scratch data | **GO** |
| Portal migration 017 and Portal deployment | **NO-GO until separately approved** (needs: the open items below, an owner review of the consent rules, a staging run against a real Meet) |
| Meet v4.32/v4.33 and Voice Engine deployment | **NO-GO until separately approved** (needs a real coturn run, a two-process Meet run, and an independent security review) |
| Any claim of "server-verified media" | **Not made, and not possible** with this infrastructure |

## What was built

### 1. Private AI room reports (Portal `meeting-ai` + Meet read-only export)
* Portal job source `meet_room_chat` (`room_id` required, rejected for other sources). It reuses the existing queue, worker, consent fence, atomic plan quota (`ai.meeting_reports_per_month`), overage metering, retention sweep, withdrawal and audit. **No new AI path:** the model is reached only through the existing Portal gateway.
* Meet `GET /api/integrations/meetings/:id/chat?room=<id>` and `/ai-consent?room=<id>` (read-only secret). The room consent list is the people assigned to the room plus everyone who wrote in it. Unknown room is 404, never an empty answer.
* **Behaviour change:** the meeting-wide chat export now holds **only the main-room chat**. Before, a meeting-wide AI report could absorb what people said inside breakout rooms.
* **Unanimous consent:** the host's request is open and every person Meet lists for the room agreed to both purposes. One pending, declined or withdrawn person refuses the whole room (HTTP 403 before any job or quota unit exists). A message from somebody not in the list blocks the job at the worker.
* **Room restricted:** `meeting_reports.room_id` with a database CHECK (room reports are never `workspace` visible), no public link shares, named-member shares only. Freshness on every read asks Meet about **that room's** people (`consent_basis.room`); an objection in the main room or another room does not hide it, an objection in the room does.
* **No double charge:** same idempotency key returns the same job; a second submission for a room with a live job returns that job (unique partial index); metering is keyed by job; five racing submissions on Basic create at most 3 jobs.
* Migration `sql/017_room_reports.sql`, rollback `sql/rollback/017_room_reports.down.sql` (deletes room jobs/reports/transcripts first).

### 2. Shared room events (Meet `server/room-events.mjs`, `sql/v4_32_room_events.sql`)
* Event log + transactional outbox (event and outbox row in one statement, or inside the caller's transaction), lease worker (`FOR UPDATE SKIP LOCKED`, fenced by a lease token), retry with backoff, dead letters (`requeueDead`), idempotent inbox, one ordered queue per instance for remote events, catch-up poll that does not trust a high-water mark (the bus may deliver 10 before 9), 24 h retention purge.
* Buses: PostgreSQL LISTEN/NOTIFY (default `ROOM_EVENTS=pg`) and Redis Streams (`ROOM_EVENTS=redis`, needs `npm install redis` and `REDIS_URL`; it is not added to package.json to keep `npm ci` unchanged). `ROOM_EVENTS` unset/`off` = exactly the old single-instance behaviour.
* Delivery is decided **on the receiving instance** from its own view of rooms (scope, hosts, one person, lead capability), never copied from the sender. A reconnecting page sends `room-replay {after}` and gets only replayable notices it may see **now**.
* Shared across instances: scope map, epochs, session start/end, room list, group leads, announcements, help requests, classroom/poll change notices, expiry (one instance ends a session, the others apply it).
* **Not shared (stays per instance):** rosters/presence, WebRTC signaling relay, chat, notes, hands/reactions/media-state. Multi-instance deployment therefore **still needs sticky routing per meeting**. Notes content is deliberately not put in the log.

### 3. Relay-only TURN (Voice Engine admin API + Meet `server/media-relay.mjs`, `sql/v4_33_relay_observation.sql`)
* Voice Engine: `POST /v1/voice/admin/turn/meet-credentials | revoke | observe` (admin secret or Shield workload identity, existing `adminAuth`). Principal `meet:<meeting>:<participant>:<epoch>`; userdb mode issues opaque revocable credentials, REST mode issues 5-minute HMAC credentials. `observe` reports allocations and bytes from the relay's own admin CLI.
* Meet (`VOICE_ENGINE_URL` + `VOICE_ENGINE_ADMIN_SECRET`, `ICE_TRANSPORT_POLICY=relay`): `/ice` returns credentials for the participant's **current epoch**; moving rooms revokes the previous epoch's credentials and cancels its live allocations; ending the rooms or leaving revokes the rest; if the Voice Engine is unreachable the page gets a 503 and a message, **never a direct-connection fallback**. Pages fetch the new credentials before building peers for a new room and after a reconnect.
* Stale-room signaling rejection is the v4.31 epoch fence (a signal made before the sender's last move is refused; the recipient's epoch is stamped and older ones are dropped by the page).
* **Labels** in the host list: `Client reported`, `Relay observed` (bytes crossed the relay for that credential), `Media verification unavailable`. The word "verified" is never used; `verified:false` is always returned.

## Files
Meet: `server/{room-events,media-relay,chat-export}.mjs`, `server/{breakouts,ai-consent,index}.js|mjs`, `public/{app,collab}.js`, `sql/v4_32_room_events.sql`, `sql/v4_33_relay_observation.sql`, `sql/005_app_role.sql` (DELETE on the event tables), `sql/rollback/v4_32_v4_33.down.sql`, tests `room-events`, `room-export`, `media-relay`.
Portal: `server/meeting-ai.mjs`, `server/ai/{worker,meet-client,meet-consent,consent-source}.mjs`, `sql/017_room_reports.sql` (+rollback), tests `room-reports`, fake Meet/helpers.
Voice Engine: `src/turn.mjs` (`observeAccount`, `parseSessionUsage`), `src/app.mjs` (3 admin routes), test `turn-meet.pg`.

## Order of operations (when approved) and rollback
1. Portal: apply `017_room_reports.sql` as owner; deploy Portal code. Rollback: Portal code first, then `rollback/017_room_reports.down.sql`.
2. Meet: apply `v4_32_room_events.sql`, `v4_33_relay_observation.sql` as owner; grant `DELETE` on the three event tables to the app role (`005_app_role.sql` needs `-v app_pw`); deploy Meet. Rollback: Meet image first, then `rollback/v4_32_v4_33.down.sql`.
3. Voice Engine: deploy the admin routes; no migration.
4. Enable features one at a time: `ROOM_EVENTS`, then `VOICE_ENGINE_URL`/`ICE_TRANSPORT_POLICY=relay`. Both default to off.
Rollback scripts were run up, down and up again on scratch databases.

## Test evidence (this machine, scratch databases, test doubles labelled)
| Suite | Result |
|---|---|
| Portal: meeting-ai, meet-ai-consent, consent-fence, consent-review, migrations, entitlements, **room-reports (11 new)** | 99/99 |
| Meet unit (real PostgreSQL): all files, incl. **room-events (10), room-export (2), media-relay (4)** | 81/81 (three consecutive clean runs before the relay work; one run after) |
| Meet real browsers (3 Chromium, fake devices, real WebRTC): classroom / breakouts V1.1 / breakouts / meet-tabs | 19/19, 20/20, 16/16 (two of five runs showed a timing-sensitive host-chip check that was then made to wait), 41/41 (one run showed the old chat unread-marker flake) |
| Voice Engine: **turn-meet (4 new)**, server | 4/4; server 10/10 twice (unmodified baseline: 9/10 once, so those tests are load-sensitive) |
| Migrations up / down / up (Portal 017, Meet 032/033) | pass, idempotent |
Events were exercised with two instances sharing one database over a memory bus, a real LISTEN/NOTIFY bus, and a **fake** Redis client. The relay and Voice Engine CLI were **fakes**.

## Security findings
1. **Room consent is per person and unanimous**, but membership of a room after the rooms close is only "people who wrote in it" (assignments are cleared). A silent member's consent is not required because their words are not used. Documented, intended.
2. **Deleted room:** if a host deletes a room, Meet answers 404 and an existing room report becomes unverifiable and is hidden (fail closed).
3. **Event log content:** events carry routing data, but `breakout-announcement` (up to 300 characters of host/lead text) and `breakout-help` (a name) are stored for the 24 h retention window. Notes, chat and answers are not.
4. **Replay** shows a returning page the notices of the room it is in now, including ones sent before it joined that room but after its cursor. Low risk; noted.
5. **REST-mode TURN credentials cannot be deleted.** A credential for a room epoch a person has left can allocate again until it expires (5 minutes); revoking cancels live allocations only. **Use userdb mode (`TURN_AUTH_MODE=userdb`) where stale-room relay media must stop immediately.**
6. **Secret handling:** Meet holds `VOICE_ENGINE_ADMIN_SECRET` (≥32 chars). Prefer Shield workload identity/mTLS for this call before production.
7. **Relay observation proves traffic crossed the relay for a credential, not what it carried.** A malicious client in full-mesh P2P (relay policy off) can still bypass any relay; relay-only policy is required for the relay to be in the path at all, and even then content isolation is not verifiable without an SFU/media gateway.
8. The room-export endpoints reuse the read-only secret and stay read-only.
9. Idempotency: replaying a job key for another room is a 409 (`idempotency_conflict`).

## Not built / open
* No Portal or Meet **UI** for requesting or viewing room reports (API only).
* Real **coturn** + browser relay-only run, Safari/iOS/Android, load, Redis outage drills with a real Redis, a real two-process Meet, outbox failover under load: **not done**.
* Chat, presence and signaling are not distributed (sticky routing required).
* Transactional append is available (`publish(..., {client})`) but the breakout routes append **after** their commit, so a crash between commit and append loses a notification (pages reload state on reconnect; scope is rebuilt from PostgreSQL).
* Independent security review: **not done**.
