-- Reverses sql/v4_33_relay_observation.sql and sql/v4_32_room_events.sql (in that order). Roll the CODE back first or together: v4.32 code expects these objects.
-- Deletes only the shared room event log, its outbox and inbox, and the relay observation columns. No meeting, chat, notes, poll, room or classroom data is touched.
BEGIN;
ALTER TABLE more_breakout_moves DROP COLUMN IF EXISTS relay_observed_at;
ALTER TABLE more_breakout_moves DROP COLUMN IF EXISTS relay_observation;
DROP TABLE IF EXISTS more_room_inbox;
DROP TABLE IF EXISTS more_room_outbox;
DROP TABLE IF EXISTS more_room_events;
COMMIT;
