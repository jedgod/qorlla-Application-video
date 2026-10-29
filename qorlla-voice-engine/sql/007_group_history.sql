-- Qorlla Voice v1.10: group call history. The history is written in the SAME transaction as every room change (no separate projector, so it cannot lag or disagree with the room): each member's
-- outcome, one participation segment per stay (a person who leaves and rejoins has several), and a timeline of what happened. Additive and idempotent. Run with the migration role.
ALTER TABLE voice_room_members ADD COLUMN IF NOT EXISTS outcome text CHECK (outcome IN ('missed','declined','cancelled','completed','kicked'));
CREATE TABLE IF NOT EXISTS voice_room_segments (
  room_id uuid NOT NULL,
  account_id text NOT NULL,
  segment_id uuid NOT NULL,
  joined_at timestamptz NOT NULL,
  left_at timestamptz,
  PRIMARY KEY (room_id, account_id, segment_id),
  FOREIGN KEY (room_id, account_id) REFERENCES voice_room_members (room_id, account_id) ON DELETE CASCADE,
  CHECK (left_at IS NULL OR left_at >= joined_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS voice_room_one_open_segment ON voice_room_segments (room_id, account_id) WHERE left_at IS NULL;
CREATE TABLE IF NOT EXISTS voice_room_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES voice_rooms(id) ON DELETE CASCADE,
  subject_account_id text NOT NULL,
  actor_account_id text,
  kind text NOT NULL CHECK (kind IN ('invited','joined','left','declined','kicked','missed','cancelled','host_transferred')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS voice_room_events_room ON voice_room_events (room_id, id);
CREATE INDEX IF NOT EXISTS voice_room_members_history ON voice_room_members (account_id, room_id);
-- Best-effort backfill for rooms that existed before this migration (only where nothing has been recorded yet).
UPDATE voice_room_members SET outcome = CASE status WHEN 'left' THEN 'completed' WHEN 'declined' THEN 'declined' WHEN 'removed' THEN 'kicked' WHEN 'missed' THEN 'missed' END
  WHERE outcome IS NULL AND status IN ('left','declined','removed','missed');
INSERT INTO voice_room_segments (room_id, account_id, segment_id, joined_at, left_at)
  SELECT m.room_id, m.account_id, gen_random_uuid(), m.joined_at, m.left_at FROM voice_room_members m
  WHERE m.joined_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM voice_room_segments s WHERE s.room_id = m.room_id AND s.account_id = m.account_id)
    AND (m.left_at IS NULL OR m.left_at >= m.joined_at);
