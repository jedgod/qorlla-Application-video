-- Reverses sql/010_consent_fence.sql. DESTROYS the per-report consent basis and the sequence numbers kept with each job's participants; reports then cannot be verified and the portal refuses to show them.
-- The consent audit trail is append-only: the two new event kinds are removed only after the protective trigger is switched off for this one statement. Back up first.
BEGIN;
ALTER TABLE portal.meeting_ai_consent_audit DISABLE TRIGGER meeting_ai_consent_audit_no_change;
DELETE FROM portal.meeting_ai_consent_audit WHERE event IN ('report_withdrawn','consent_unverifiable');
ALTER TABLE portal.meeting_ai_consent_audit ENABLE TRIGGER meeting_ai_consent_audit_no_change;
ALTER TABLE portal.meeting_ai_consent_audit DROP CONSTRAINT IF EXISTS meeting_ai_consent_audit_event_check;
ALTER TABLE portal.meeting_ai_consent_audit ADD CONSTRAINT meeting_ai_consent_audit_event_check CHECK (event IN
  ('host_consent_granted','host_consent_revoked','job_snapshot','job_blocked','processing_stopped','result_discarded','result_published','citation_refused','citation_opened'));
ALTER TABLE portal.meeting_reports DROP COLUMN IF EXISTS consent_basis;
ALTER TABLE portal.meeting_ai_jobs DROP COLUMN IF EXISTS consent_revision;
ALTER TABLE portal.meeting_ai_job_participants DROP COLUMN IF EXISTS summary_seq;
ALTER TABLE portal.meeting_ai_job_participants DROP COLUMN IF EXISTS transcription_seq;
COMMIT;
