-- Reverses sql/009_meet_ai_consent.sql. DESTROYS the Meet AI consent audit trail, the per-job participant snapshots and report citations. Back up first.
BEGIN;
DROP TABLE IF EXISTS portal.meeting_ai_job_participants;
DROP TABLE IF EXISTS portal.meeting_ai_consent_audit;
DROP FUNCTION IF EXISTS portal.meeting_ai_consent_audit_immutable();
ALTER TABLE portal.meeting_reports DROP COLUMN IF EXISTS citations;
DELETE FROM portal.platform_flags WHERE key = 'meet_ai';
ALTER TABLE portal.platform_flags DROP CONSTRAINT IF EXISTS platform_flags_key_check;
ALTER TABLE portal.platform_flags ADD CONSTRAINT platform_flags_key_check CHECK (key IN ('checkout','plan_changes','ai','overage_billing'));
COMMIT;
