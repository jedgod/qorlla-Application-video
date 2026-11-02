-- Lets the Workplace portal (separate role, no access to MAIN's tables) discover WHICH verified account owns a Meet meeting,
-- so AI Meeting Intelligence can be offered only to the host (or a workspace admin of the host's workspace). Read-only, narrow view.
ALTER TABLE qorlla_schedules ADD COLUMN IF NOT EXISTS owner_user_id uuid;       -- set when the schedule is created/edited by a signed-in account
CREATE INDEX IF NOT EXISTS qorlla_schedules_owner_idx ON qorlla_schedules(owner_user_id);
CREATE OR REPLACE VIEW public.portal_meeting_directory AS
  SELECT source_id, meet_uuid, meet_code, title, owner_user_id, scheduled_at, status
  FROM qorlla_schedules
  WHERE meet_uuid IS NOT NULL AND owner_user_id IS NOT NULL;
