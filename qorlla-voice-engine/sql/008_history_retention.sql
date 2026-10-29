-- Qorlla Voice v1.11: group call history retention, user deletion and legal holds. Additive and idempotent. Run with the migration role.
--   history_hidden_at   a member asked for their record to be deleted while the room is under a legal hold: it disappears from their view at once and is deleted when the hold is released.
--   participant_count   frozen on first deletion so one person deleting their record does not change the "people who took part" figure the others see.
--   voice_legal_holds   a held room is never deleted (the foreign key makes the database itself refuse), by retention or by a user.
--   voice_history_ops   what the cleanup and deletions did (counts only: no account ids, no content).
ALTER TABLE voice_room_members ADD COLUMN IF NOT EXISTS history_hidden_at timestamptz;
ALTER TABLE voice_rooms ADD COLUMN IF NOT EXISTS participant_count integer;
ALTER TABLE voice_room_events DROP CONSTRAINT IF EXISTS voice_room_events_kind_check;
ALTER TABLE voice_room_events ADD CONSTRAINT voice_room_events_kind_check CHECK (kind IN ('invited','joined','left','declined','kicked','missed','cancelled','host_transferred','device_claimed'));
CREATE TABLE IF NOT EXISTS voice_legal_holds (
  room_id uuid PRIMARY KEY REFERENCES voice_rooms(id),
  placed_by text NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  placed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS voice_history_ops (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('user_delete','user_clear','retention','hold_placed','hold_released')),
  rooms integer NOT NULL DEFAULT 0,
  detail text
);
CREATE INDEX IF NOT EXISTS voice_history_ops_at ON voice_history_ops (at DESC);
CREATE INDEX IF NOT EXISTS voice_room_members_hidden ON voice_room_members (room_id) WHERE history_hidden_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS voice_rooms_ended_at ON voice_rooms (ended_at) WHERE status = 'ended';
