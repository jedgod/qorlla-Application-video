-- Qorlla Meet relay observation (v4.33): what the TURN relay says it carried for a person's current room epoch. Idempotent.
-- Run as the database owner BEFORE sql/005_app_role.sql, AFTER sql/v4_32_room_events.sql. Rollback: ALTER TABLE more_breakout_moves DROP COLUMN relay_observation, DROP COLUMN relay_observed_at;
-- This is the RELAY's observation (an allocation exists / bytes crossed it for that credential). It is never proof of what the media contained: the label is "Relay observed", never "verified".
BEGIN;
ALTER TABLE more_breakout_moves ADD COLUMN IF NOT EXISTS relay_observation text CHECK (relay_observation IN ('allocation_observed','traffic_observed'));
ALTER TABLE more_breakout_moves ADD COLUMN IF NOT EXISTS relay_observed_at timestamptz;
COMMIT;
