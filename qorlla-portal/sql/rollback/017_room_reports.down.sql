-- Reverses 017_room_reports.sql. Room reports and room jobs are DELETED first (they cannot exist without the room columns); everything else is untouched.
-- Roll the code back first or together: the old code does not know source 'meet_room_chat'.
BEGIN;
DELETE FROM portal.meeting_action_items WHERE report_id IN (SELECT id FROM portal.meeting_reports WHERE room_id IS NOT NULL);
DELETE FROM portal.report_shares WHERE report_id IN (SELECT id FROM portal.meeting_reports WHERE room_id IS NOT NULL);
DELETE FROM portal.meeting_reports WHERE room_id IS NOT NULL;
DELETE FROM portal.meeting_transcripts WHERE source = 'meet_room_chat';
DELETE FROM portal.ai_usage_events WHERE job_id IN (SELECT id FROM portal.meeting_ai_jobs WHERE source = 'meet_room_chat');
DELETE FROM portal.meeting_ai_job_participants WHERE job_id IN (SELECT id FROM portal.meeting_ai_jobs WHERE source = 'meet_room_chat');
DELETE FROM portal.meeting_ai_jobs WHERE source = 'meet_room_chat';
DROP INDEX IF EXISTS portal.meeting_reports_room;
ALTER TABLE portal.meeting_reports DROP CONSTRAINT IF EXISTS meeting_reports_room_restricted;
ALTER TABLE portal.meeting_reports DROP COLUMN IF EXISTS room_name;
ALTER TABLE portal.meeting_reports DROP COLUMN IF EXISTS room_id;
ALTER TABLE portal.meeting_transcripts DROP CONSTRAINT IF EXISTS meeting_transcripts_source_check;
ALTER TABLE portal.meeting_transcripts ADD CONSTRAINT meeting_transcripts_source_check CHECK (source IN ('meet_chat','transcript_import'));
DROP INDEX IF EXISTS portal.meeting_ai_jobs_room_active_uq;
ALTER TABLE portal.meeting_ai_jobs DROP CONSTRAINT IF EXISTS meeting_ai_jobs_room_scope;
ALTER TABLE portal.meeting_ai_jobs DROP CONSTRAINT IF EXISTS meeting_ai_jobs_source_check;
ALTER TABLE portal.meeting_ai_jobs ADD CONSTRAINT meeting_ai_jobs_source_check CHECK (source IN ('meet_chat','transcript_import'));
ALTER TABLE portal.meeting_ai_jobs DROP COLUMN IF EXISTS room_name;
ALTER TABLE portal.meeting_ai_jobs DROP COLUMN IF EXISTS room_id;
COMMIT;
