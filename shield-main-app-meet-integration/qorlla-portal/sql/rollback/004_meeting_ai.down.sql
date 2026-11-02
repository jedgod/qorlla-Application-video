-- Reverses sql/004_meeting_ai.sql. DESTROYS AI consents, jobs, transcripts, action items, usage records and share links.
-- Reports created before v4.2 (if any) keep their original columns. Take a backup first.
BEGIN;
DELETE FROM portal.entitlements WHERE feature = 'ai.meeting_reports_per_month';
DROP TABLE IF EXISTS portal.ai_usage_events;
ALTER TABLE portal.report_shares DROP CONSTRAINT IF EXISTS report_shares_shape;
DROP INDEX IF EXISTS portal.report_shares_token_uq;
DROP INDEX IF EXISTS portal.report_shares_member_uq;
DELETE FROM portal.report_shares WHERE recipient_email IS NULL;
ALTER TABLE portal.report_shares
  DROP COLUMN IF EXISTS kind, DROP COLUMN IF EXISTS recipient_user_id, DROP COLUMN IF EXISTS recipient_label, DROP COLUMN IF EXISTS token_hash,
  DROP COLUMN IF EXISTS include_transcript, DROP COLUMN IF EXISTS expires_at, DROP COLUMN IF EXISTS revoked_by, DROP COLUMN IF EXISTS access_count,
  DROP COLUMN IF EXISTS last_accessed_at;
ALTER TABLE portal.report_shares ALTER COLUMN recipient_email SET NOT NULL;
DROP TABLE IF EXISTS portal.meeting_action_items;
DROP INDEX IF EXISTS portal.meeting_reports_ws_idx;
ALTER TABLE portal.meeting_reports
  DROP COLUMN IF EXISTS meet_meeting_id, DROP COLUMN IF EXISTS job_id, DROP COLUMN IF EXISTS transcript_id, DROP COLUMN IF EXISTS decisions,
  DROP COLUMN IF EXISTS topics, DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS visibility, DROP COLUMN IF EXISTS generated_by,
  DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS host_user_id, DROP COLUMN IF EXISTS updated_at, DROP COLUMN IF EXISTS deleted_at;
DROP TABLE IF EXISTS portal.meeting_transcripts;
DROP TABLE IF EXISTS portal.meeting_ai_jobs;
DROP TABLE IF EXISTS portal.meeting_ai_consents;
COMMIT;
