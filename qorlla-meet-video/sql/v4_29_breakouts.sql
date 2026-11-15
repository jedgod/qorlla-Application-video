-- Qorlla Meet breakout rooms (v4.29): rooms, assignments and one session per meeting occurrence, plus the room a chat message was written in.
-- Run as the database owner BEFORE sql/005_app_role.sql, AFTER sql/v4_27_more.sql. Rollback: DROP TABLE more_breakout_assignments, more_breakout_rooms, more_breakout_sessions; ALTER TABLE messages DROP COLUMN breakout_room;
BEGIN;
CREATE TABLE IF NOT EXISTS more_breakout_sessions (
  meeting_id  uuid PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  state       text NOT NULL DEFAULT 'idle' CHECK (state IN ('idle','active')),
  deadline    timestamptz,
  revision    bigint NOT NULL DEFAULT 0,
  started_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS more_breakout_rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id  uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, id)
);
CREATE TABLE IF NOT EXISTS more_breakout_assignments (
  meeting_id     uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  room_id        uuid REFERENCES more_breakout_rooms(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, participant_id)
);
-- a message written inside a breakout room belongs to that room: only the people in it read it (NULL = the main room)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS breakout_room uuid;
CREATE INDEX IF NOT EXISTS messages_breakout_room ON messages (meeting_id, breakout_room) WHERE breakout_room IS NOT NULL;
COMMIT;
