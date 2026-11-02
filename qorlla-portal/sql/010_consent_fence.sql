-- Qorlla Workplace - the Meet AI consent fence. Reverse with sql/rollback/010_consent_fence.down.sql.
-- Meet numbers every consent decision (monotonic, v4_20_ai_consent_seq.sql). A result records the numbers of the agreements it was built on (consent_basis); it may be shown only while no included
-- person has objected AFTER those numbers. Withdrawal is persisted (a report is never silently restored) and audited with NEW appended records: existing audit rows are never touched.
BEGIN;
ALTER TABLE portal.meeting_ai_job_participants ADD COLUMN IF NOT EXISTS transcription_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE portal.meeting_ai_job_participants ADD COLUMN IF NOT EXISTS summary_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE portal.meeting_ai_jobs ADD COLUMN IF NOT EXISTS consent_revision bigint;
ALTER TABLE portal.meeting_reports ADD COLUMN IF NOT EXISTS consent_basis jsonb;
ALTER TABLE portal.meeting_ai_consent_audit DROP CONSTRAINT IF EXISTS meeting_ai_consent_audit_event_check;
ALTER TABLE portal.meeting_ai_consent_audit ADD CONSTRAINT meeting_ai_consent_audit_event_check CHECK (event IN
  ('host_consent_granted','host_consent_revoked','job_snapshot','job_blocked','processing_stopped','result_discarded','result_published','citation_refused','citation_opened','report_withdrawn','consent_unverifiable'));
COMMIT;
