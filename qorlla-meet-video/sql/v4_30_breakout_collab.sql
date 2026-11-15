-- Qorlla Meet breakout rooms V1.1 (v4.30): room-scoped Polls and Notes, and "Ask for help". Idempotent.
-- Run as the database owner BEFORE sql/005_app_role.sql, AFTER sql/v4_29_breakouts.sql.
-- Rollback: DROP TABLE more_breakout_help, more_room_notes; ALTER TABLE meeting_polls DROP COLUMN breakout_room;
BEGIN;
-- a poll made inside a breakout room belongs to that room (NULL = the main room). No foreign key on purpose: deleting a room must never turn its polls into main-room polls.
ALTER TABLE meeting_polls ADD COLUMN IF NOT EXISTS breakout_room uuid;
CREATE INDEX IF NOT EXISTS meeting_polls_room ON meeting_polls (meeting_id, breakout_room);
-- the notes of one breakout room (same shape as meeting_notes; the main-room notes stay where they are). No history or edit grants: everybody in the room may edit.
CREATE TABLE IF NOT EXISTS more_room_notes (
  meeting_id      uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  room_id         uuid NOT NULL,
  doc             jsonb NOT NULL,
  version         integer NOT NULL,
  updated_by      uuid,
  updated_by_name text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, room_id)
);
-- "Ask for help": a person in a room asks the host to come. One open request per person (database-enforced).
CREATE TABLE IF NOT EXISTS more_breakout_help (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id   uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  room_id      uuid NOT NULL,
  requester_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS more_breakout_help_one_open ON more_breakout_help (meeting_id, requester_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS more_breakout_help_meeting ON more_breakout_help (meeting_id, status, created_at);
COMMIT;
