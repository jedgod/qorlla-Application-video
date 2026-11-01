-- Qorlla Workplace - Meet AI consent evidence, report citations and the Meet AI kill switch. Reverse with sql/rollback/009_meet_ai_consent.down.sql.
-- Adds to (never replaces) the host attestation in portal.meeting_ai_consents and Meet's per-person ai_consents (read through Meet's read-only integration):
--   * an APPEND-ONLY consent audit trail (who/what/when/which scope; counts only: never transcript text, names or messages)
--   * a per-job snapshot of which participants' content was used (participant id + decisions, no names, no text)
--   * citations on a report: signed references to transcript segments (ids, hashes and positions; the text is looked up again, with fresh checks, when someone opens one)
--   * a separate platform kill switch for Meet AI.
BEGIN;

CREATE TABLE IF NOT EXISTS portal.meeting_ai_consent_audit (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  workspace_id uuid NOT NULL, meet_meeting_id uuid, job_id uuid,
  actor text,                                   -- a user id, or 'system:ai-worker'
  event text NOT NULL CHECK (event IN ('host_consent_granted','host_consent_revoked','job_snapshot','job_blocked','processing_stopped','result_discarded','result_published','citation_refused','citation_opened')),
  scope text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb      -- counts and reason codes only
);
CREATE INDEX IF NOT EXISTS meeting_ai_consent_audit_meeting ON portal.meeting_ai_consent_audit(workspace_id, meet_meeting_id, at DESC);
CREATE OR REPLACE FUNCTION portal.meeting_ai_consent_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'portal.meeting_ai_consent_audit is append-only'; END $$;
DROP TRIGGER IF EXISTS meeting_ai_consent_audit_no_change ON portal.meeting_ai_consent_audit;
CREATE TRIGGER meeting_ai_consent_audit_no_change BEFORE UPDATE OR DELETE ON portal.meeting_ai_consent_audit FOR EACH ROW EXECUTE FUNCTION portal.meeting_ai_consent_audit_immutable();

CREATE TABLE IF NOT EXISTS portal.meeting_ai_job_participants (
  job_id uuid NOT NULL REFERENCES portal.meeting_ai_jobs(id),
  participant_id text NOT NULL,                 -- Meet's participant id (pseudonymous); no display name is kept
  transcription text NOT NULL, summary text NOT NULL,
  included boolean NOT NULL, reason text,
  PRIMARY KEY (job_id, participant_id)
);

ALTER TABLE portal.meeting_reports ADD COLUMN IF NOT EXISTS citations jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE portal.platform_flags DROP CONSTRAINT IF EXISTS platform_flags_key_check;
ALTER TABLE portal.platform_flags ADD CONSTRAINT platform_flags_key_check CHECK (key IN ('checkout','plan_changes','ai','overage_billing','meet_ai'));
INSERT INTO portal.platform_flags(key) VALUES ('meet_ai') ON CONFLICT DO NOTHING;
COMMIT;
