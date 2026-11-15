-- Portal: private AI reports for ONE Meet breakout room (source 'meet_room_chat'). Idempotent. Rollback: sql/rollback/017_room_reports.down.sql
-- A room report is built only from that room's chat, only when EVERY person in the room agreed (see server/ai/meet-consent.mjs roomAllowed), goes through the same job queue,
-- the same atomic plan quota and the same consent fence as every other Meeting AI job, and can never be made visible to the whole workspace or shared by public link.
BEGIN;

ALTER TABLE portal.meeting_ai_jobs ADD COLUMN IF NOT EXISTS room_id uuid;
ALTER TABLE portal.meeting_ai_jobs ADD COLUMN IF NOT EXISTS room_name text;
ALTER TABLE portal.meeting_ai_jobs DROP CONSTRAINT IF EXISTS meeting_ai_jobs_source_check;
ALTER TABLE portal.meeting_ai_jobs ADD CONSTRAINT meeting_ai_jobs_source_check CHECK (source IN ('meet_chat','transcript_import','meet_room_chat'));
ALTER TABLE portal.meeting_ai_jobs DROP CONSTRAINT IF EXISTS meeting_ai_jobs_room_scope;
ALTER TABLE portal.meeting_ai_jobs ADD CONSTRAINT meeting_ai_jobs_room_scope CHECK ((source = 'meet_room_chat') = (room_id IS NOT NULL));
-- one live room job per meeting and room: a second submission (with another idempotency key) gets the first one back instead of a second quota unit
CREATE UNIQUE INDEX IF NOT EXISTS meeting_ai_jobs_room_active_uq ON portal.meeting_ai_jobs (workspace_id, meet_meeting_id, room_id) WHERE source = 'meet_room_chat' AND status IN ('queued','running');

ALTER TABLE portal.meeting_transcripts DROP CONSTRAINT IF EXISTS meeting_transcripts_source_check;
ALTER TABLE portal.meeting_transcripts ADD CONSTRAINT meeting_transcripts_source_check CHECK (source IN ('meet_chat','transcript_import','meet_room_chat'));

ALTER TABLE portal.meeting_reports ADD COLUMN IF NOT EXISTS room_id uuid;
ALTER TABLE portal.meeting_reports ADD COLUMN IF NOT EXISTS room_name text;
ALTER TABLE portal.meeting_reports DROP CONSTRAINT IF EXISTS meeting_reports_room_restricted;
ALTER TABLE portal.meeting_reports ADD CONSTRAINT meeting_reports_room_restricted CHECK (room_id IS NULL OR visibility = 'restricted');
CREATE INDEX IF NOT EXISTS meeting_reports_room ON portal.meeting_reports (workspace_id, meet_meeting_id, room_id) WHERE room_id IS NOT NULL;

COMMIT;
