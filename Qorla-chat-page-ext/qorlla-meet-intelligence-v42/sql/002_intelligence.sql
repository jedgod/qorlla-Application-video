BEGIN;
CREATE SCHEMA IF NOT EXISTS meet_more;
CREATE TABLE IF NOT EXISTS meet_more.intelligence_consent (
 occurrence_id text NOT NULL, actor_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('transcription','ai')),
 granted boolean NOT NULL, policy_version text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(occurrence_id,actor_id,kind));
CREATE TABLE IF NOT EXISTS meet_more.intelligence_sessions (
 occurrence_id text PRIMARY KEY, transcription_state text NOT NULL DEFAULT 'off'
 CHECK(transcription_state IN ('off','starting','active','stopping','failed')),
 capture_id text, consent_policy text NOT NULL DEFAULT 'all_required',
 updated_by text, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS meet_more.intelligence_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), occurrence_id text NOT NULL, actor_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('summary','takeaways','answer')),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','failed','cancelled')),
 prompt_question text, idempotency_key text NOT NULL, result_id uuid,
 error_code text, attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(occurrence_id,actor_id,idempotency_key));
CREATE INDEX IF NOT EXISTS intelligence_jobs_pending_idx ON meet_more.intelligence_jobs(state,created_at) WHERE state='queued';
CREATE TABLE IF NOT EXISTS meet_more.intelligence_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, occurrence_id text NOT NULL,
 actor_id text NOT NULL, action text NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS intelligence_audit_occ_idx ON meet_more.intelligence_audit(occurrence_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS transcript_segment_capture_dedupe ON meet_more.transcript_segments(occurrence_id,start_ms,end_ms,speaker_id);
CREATE INDEX IF NOT EXISTS transcript_occ_cursor_idx ON meet_more.transcript_segments(occurrence_id,id);
CREATE INDEX IF NOT EXISTS intelligence_artifact_occ_idx ON meet_more.ai_artifacts(occurrence_id,created_at DESC);
COMMIT;
