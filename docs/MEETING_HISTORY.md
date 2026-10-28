# Meeting History and Activity Report

One meeting record (same meeting ID) carries everything: `title`, `topic` (the subject, kept separate from the title), `description`, `agenda` (up to 20 items), `category` (team, training, presentation, interview, webinar, other), scheduled and actual start/end, attendance, outcome and action items. Topic, category and agenda are entered when scheduling (More options), on the Start screen, and via `POST /api/meetings/create`; edits before the meeting ends are mirrored onto the live record.

**Lifecycle.** scheduled -> active -> completed (host ended, or everyone left for 30 min: `HISTORY_IDLE_MS`) | partial (Meet-hosted meeting whose attendance could not be verified) ; missed (never started, time passed) ; cancelled (schedule deleted before it started). Finished records are frozen: schedule edits/deletes, Reschedule and new occurrences never change them, and they cannot be joined or restarted. Only the host's outcome and action items stay editable.

**Attendance.** Built-in room: join/leave events recorded by the server. Meet-hosted: Meet's `participant_sessions` (`sql/v4_11_history.sql`), pulled through the bridge (`GET /api/integrations/scheduled-meetings/:sourceId/activity`). Unique = distinct people (name per role), peak = most people connected at once.

**API (signed-in).** `GET /api/history/meetings?q=&status=&category=&host=&from=&to=&offset=`, `GET /api/history/meetings/:id`, `PATCH /api/history/meetings/:id` (host: `outcome`, `actionItems`), `GET /api/history/meetings/:id/report[?format=json]` (host: CSV with attendance, formula-safe). Host sees attendee names; someone who attended sees the banner, description, agenda, outcome and action items, not the attendee list; anyone else gets 404. Reschedule is a client action that creates a NEW meeting (new ID, `rescheduledFrom` link).

**Not done.** AI summaries; recordings are not linked into History (the details say so); no PDF report; meeting categories are a fixed list; invitees of a past meeting are not copied into Reschedule; attendance for Meet-hosted meetings needs Meet reachable (otherwise `partial`/stale numbers are shown as last known).
