-- Qorlla Workplace v4.2 - AI Meeting Intelligence.
-- Requires meet-sync/sql/006_meeting_directory.sql (view public.portal_meeting_directory) and 001/002 of this schema.
-- Reverse with sql/rollback/004_meeting_ai.down.sql (take a backup first: it drops transcripts, reports, jobs and usage records).
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.portal_meeting_directory') IS NULL THEN
    RAISE EXCEPTION 'apply meet-sync/sql/006_meeting_directory.sql first (view public.portal_meeting_directory is missing)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Consent. Nothing is processed without an ACTIVE row here. Attested by the meeting host (the verified account that owns the
-- scheduled meeting); revocation purges derived data. 'recording' is recorded for completeness but v4.2 never processes recordings.
CREATE TABLE IF NOT EXISTS portal.meeting_ai_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  meet_meeting_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('transcription','summary','recording')),
  basis text NOT NULL DEFAULT 'host_attestation' CHECK (basis IN ('host_attestation')),
  notice_version text NOT NULL, notice_text text NOT NULL,
  granted_by uuid NOT NULL, granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid, revoked_at timestamptz, revoke_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS meeting_ai_consent_active_uq ON portal.meeting_ai_consents(workspace_id, meet_meeting_id, scope) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS meeting_ai_consent_meeting_idx ON portal.meeting_ai_consents(workspace_id, meet_meeting_id);

-- ---------------------------------------------------------------------------------------------------------------------------
-- Jobs: an idempotent, leased queue (same pattern as MAIN's Meet sync worker).
CREATE TABLE IF NOT EXISTS portal.meeting_ai_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  meet_meeting_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('meet_chat','transcript_import')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','blocked','cancelled')),
  stage text NOT NULL DEFAULT 'fetch' CHECK (stage IN ('fetch','summarize','done')),
  idempotency_key text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz, lease_token uuid,
  error_code text, error_message text,
  transcript_id uuid, report_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS meeting_ai_jobs_due_idx ON portal.meeting_ai_jobs(next_attempt_at) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS meeting_ai_jobs_ws_idx ON portal.meeting_ai_jobs(workspace_id, created_at DESC);

-- ---------------------------------------------------------------------------------------------------------------------------
-- Transcripts. segments = [{speaker, text, at?, start_ms?}]. speaker_labels says how far the labels can be trusted:
--   'unverified' = display names typed by participants (Meet guests have no accounts); 'none' = unlabelled text.
CREATE TABLE IF NOT EXISTS portal.meeting_transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  meet_meeting_id uuid NOT NULL,
  job_id uuid NOT NULL UNIQUE REFERENCES portal.meeting_ai_jobs(id),
  source text NOT NULL CHECK (source IN ('meet_chat','transcript_import')),
  language text, speaker_labels text NOT NULL DEFAULT 'none' CHECK (speaker_labels IN ('unverified','none')),
  segments jsonb NOT NULL, full_text text NOT NULL, content_sha256 text NOT NULL,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  purged_at timestamptz, purge_reason text
);
CREATE INDEX IF NOT EXISTS meeting_transcripts_meeting_idx ON portal.meeting_transcripts(workspace_id, meet_meeting_id);

-- ---------------------------------------------------------------------------------------------------------------------------
-- Reports (extends the table created in 001).
ALTER TABLE portal.meeting_reports ADD COLUMN IF NOT EXISTS meet_meeting_id uuid;
ALTER TABLE portal.meeting_reports ADD COLUMN IF NOT EXISTS job_id uuid UNIQUE REFERENCES portal.meeting_ai_jobs(id);
ALTER TABLE portal.meeting_reports ADD COLUMN IF NOT EXISTS transcript_id uuid REFERENCES portal.meeting_transcripts(id);
ALTER TABLE portal.meeting_reports ADD COLUMN IF NOT EXISTS decisions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE portal.meeting_reports ADD COLUMN IF NOT EXISTS topics jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE portal.meeting_reports ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'final' CHECK (status IN ('final','withdrawn'));
ALTER TABLE portal.meeting_reports ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'restricted' CHECK (visibility IN ('restricted','workspace'));
ALTER TABLE portal.meeting_reports ADD COLUMN IF NOT EXISTS generated_by text;
ALTER TABLE portal.meeting_reports ADD COLUMN IF NOT EXISTS created_by uuid;
ALTER TABLE portal.meeting_reports ADD COLUMN IF NOT EXISTS host_user_id uuid;
ALTER TABLE portal.meeting_reports ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE portal.meeting_reports ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS meeting_reports_ws_idx ON portal.meeting_reports(workspace_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS portal.meeting_action_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  report_id uuid NOT NULL REFERENCES portal.meeting_reports(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  owner_hint text, due_hint text,                                  -- what the model suggested (text only, never trusted)
  owner_id uuid, due_at timestamptz,                               -- set by people: owner must be a workspace member
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  completed_at timestamptz, source text NOT NULL DEFAULT 'ai' CHECK (source IN ('ai','manual')),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_action_items_owner_idx ON portal.meeting_action_items(workspace_id, owner_id, status);
CREATE INDEX IF NOT EXISTS meeting_action_items_report_idx ON portal.meeting_action_items(report_id);

-- ---------------------------------------------------------------------------------------------------------------------------
-- Report shares (extends the table created in 001): 'member' = a workspace member; 'link' = bearer link for people without an account.
ALTER TABLE portal.report_shares ALTER COLUMN recipient_email DROP NOT NULL;
ALTER TABLE portal.report_shares ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'link' CHECK (kind IN ('member','link'));
ALTER TABLE portal.report_shares ADD COLUMN IF NOT EXISTS recipient_user_id uuid;
ALTER TABLE portal.report_shares ADD COLUMN IF NOT EXISTS recipient_label text;
ALTER TABLE portal.report_shares ADD COLUMN IF NOT EXISTS token_hash text;                 -- SHA-256 of the link token; the token itself is shown once
ALTER TABLE portal.report_shares ADD COLUMN IF NOT EXISTS include_transcript boolean NOT NULL DEFAULT false;
ALTER TABLE portal.report_shares ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE portal.report_shares ADD COLUMN IF NOT EXISTS revoked_by uuid;
ALTER TABLE portal.report_shares ADD COLUMN IF NOT EXISTS access_count integer NOT NULL DEFAULT 0;
ALTER TABLE portal.report_shares ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS report_shares_token_uq ON portal.report_shares(token_hash) WHERE token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS report_shares_member_uq ON portal.report_shares(report_id, recipient_user_id) WHERE kind = 'member' AND revoked_at IS NULL;
-- Shares recorded before v4.2 never granted any access (no recipient mechanism existed): retire them instead of guessing a meaning.
UPDATE portal.report_shares SET revoked_at = COALESCE(revoked_at, now()) WHERE token_hash IS NULL AND recipient_user_id IS NULL;
ALTER TABLE portal.report_shares DROP CONSTRAINT IF EXISTS report_shares_shape;
ALTER TABLE portal.report_shares ADD CONSTRAINT report_shares_shape CHECK (revoked_at IS NOT NULL OR (kind = 'member' AND recipient_user_id IS NOT NULL AND token_hash IS NULL) OR (kind = 'link' AND token_hash IS NOT NULL AND expires_at IS NOT NULL));

-- ---------------------------------------------------------------------------------------------------------------------------
-- AI usage accounting. One row per (workspace, idempotency_key): a retried job can never be billed twice.
CREATE TABLE IF NOT EXISTS portal.ai_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  job_id uuid REFERENCES portal.meeting_ai_jobs(id),
  feature text NOT NULL CHECK (feature IN ('meeting_report','llm_input_tokens','llm_output_tokens')),
  units bigint NOT NULL CHECK (units >= 0),
  idempotency_key text NOT NULL, plan_slug text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS ai_usage_ws_idx ON portal.ai_usage_events(workspace_id, created_at DESC);

-- Plan entitlement: the pricing page promises 3 hosted-meeting summaries per month on Basic; paid plans are unlimited.
INSERT INTO portal.entitlements(plan_slug, feature, quota, description) VALUES
  ('basic','ai.meeting_reports_per_month',3,'AI meeting reports per month'), ('pro','ai.meeting_reports_per_month',NULL,'AI meeting reports per month'),
  ('business','ai.meeting_reports_per_month',NULL,'AI meeting reports per month'), ('enterprise','ai.meeting_reports_per_month',NULL,'AI meeting reports per month')
ON CONFLICT (plan_slug, feature) DO NOTHING;
COMMIT;
