-- Qorlla Meet v4.22: host-controlled tools. Idempotent.
--   meetings.guest_tools : which tools the host has switched ON for guests ({"share":true,"polls":true,"breakout":false,"whiteboard":false}). A missing key means OFF: guests see nothing of a tool until the host activates it.
--   participants.can_share : the host let this one person share their screen even though sharing is not on for everyone.
-- Rollback: ALTER TABLE meetings DROP COLUMN guest_tools; ALTER TABLE participants DROP COLUMN can_share;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS guest_tools jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS can_share boolean NOT NULL DEFAULT false;
