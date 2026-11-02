-- Qorlla Meet: connection sessions, so a meeting's attendance (who really was in the room, for how long, how many at once) can be reported (v4.11).
-- Idempotent. Run as the database owner BEFORE sql/005_app_role.sql.
-- Rollback: DROP TABLE participant_sessions;  (attendance history for Meet-hosted meetings is lost)
CREATE TABLE IF NOT EXISTS participant_sessions (
  id              uuid PRIMARY KEY,
  meeting_id      uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_id  uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  connected_at    timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz
);
CREATE INDEX IF NOT EXISTS participant_sessions_meeting ON participant_sessions (meeting_id, connected_at);
