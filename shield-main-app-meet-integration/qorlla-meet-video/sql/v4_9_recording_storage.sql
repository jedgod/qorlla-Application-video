-- Qorlla Meet v4.0.3: recording media storage metadata, short-lived access tokens, separate AI consent, tamper-evident audit. Idempotent.
-- Run as the database owner BEFORE sql/005_app_role.sql and AFTER v4_7_recording_consent.sql.
-- Rollback: stop Meet, DROP TABLE ai_consents, recording_access_tokens, recording_chunks, recordings; ALTER TABLE recording_audit DROP COLUMN prev_hash, DROP COLUMN hash; ALTER TABLE recording_sessions DROP COLUMN retention_days;
ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS retention_days integer;
ALTER TABLE recording_audit ADD COLUMN IF NOT EXISTS prev_hash text;
ALTER TABLE recording_audit ADD COLUMN IF NOT EXISTS hash text;

CREATE TABLE IF NOT EXISTS recordings (                    -- the media artifact of one consented recording session (metadata only: media lives in private object storage)
  id                uuid PRIMARY KEY,
  meeting_id        uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  session_id        uuid NOT NULL UNIQUE REFERENCES recording_sessions(id),
  recorder          uuid NOT NULL,                         -- the participant whose browser captures; only this participant may upload media
  status            text NOT NULL CHECK (status IN ('recording','finalizing','available','failed','deleted')),
  mime              text NOT NULL DEFAULT 'video/webm',
  has_video         boolean NOT NULL,
  has_audio         boolean NOT NULL,
  key_id            text NOT NULL,                         -- which master key wraps the data key
  wrapped_key       bytea,                                 -- the per-recording data key, wrapped; set to NULL on deletion (crypto-shredding)
  chunk_count       integer NOT NULL DEFAULT 0,
  bytes             bigint NOT NULL DEFAULT 0,             -- plaintext bytes
  partial           boolean NOT NULL DEFAULT false,        -- true when finalized without every chunk the recorder reported
  fail_reason       text,
  retention_days    integer NOT NULL,
  retention_until   timestamptz,
  legal_hold        boolean NOT NULL DEFAULT false,
  legal_hold_reason text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  last_chunk_at     timestamptz,
  ended_at          timestamptz,
  end_reason        text,
  finalized_at      timestamptz,
  deleted_at        timestamptz,
  deleted_by        text,
  delete_reason     text
);
CREATE INDEX IF NOT EXISTS recordings_meeting ON recordings (meeting_id, started_at DESC);
CREATE INDEX IF NOT EXISTS recordings_status ON recordings (status);
CREATE TABLE IF NOT EXISTS recording_chunks (
  recording_id uuid NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  seq          integer NOT NULL CHECK (seq >= 0),
  size         integer NOT NULL,                           -- plaintext bytes
  object_key   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recording_id, seq)
);
CREATE TABLE IF NOT EXISTS recording_access_tokens (        -- download links: short-lived and single-use
  jti            uuid PRIMARY KEY,
  recording_id   uuid NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ai_consents (                    -- SEPARATE from recording consent: agreeing to be recorded never implies AI processing. Append-only.
  id               uuid PRIMARY KEY,
  meeting_id       uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_id   uuid NOT NULL,
  participant_name text NOT NULL,
  purpose          text NOT NULL CHECK (purpose IN ('transcription','summary','translation','third_party')),
  decision         text NOT NULL CHECK (decision IN ('agree','decline','withdraw')),
  policy_version   text NOT NULL,
  audit_ref        uuid NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_consents_lookup ON ai_consents (meeting_id, participant_id, purpose, created_at DESC);

-- Append-only for EVERY role (including the owner): rows cannot be updated or deleted unless a maintenance session explicitly sets qorlla.allow_purge = on.
CREATE OR REPLACE FUNCTION qorlla_append_only() RETURNS trigger AS $$
BEGIN
  IF current_setting('qorlla.allow_purge', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS recording_audit_append_only ON recording_audit;
CREATE TRIGGER recording_audit_append_only BEFORE UPDATE OR DELETE ON recording_audit FOR EACH ROW EXECUTE FUNCTION qorlla_append_only();
DROP TRIGGER IF EXISTS recording_consents_append_only ON recording_consents;
CREATE TRIGGER recording_consents_append_only BEFORE UPDATE OR DELETE ON recording_consents FOR EACH ROW EXECUTE FUNCTION qorlla_append_only();
DROP TRIGGER IF EXISTS ai_consents_append_only ON ai_consents;
CREATE TRIGGER ai_consents_append_only BEFORE UPDATE OR DELETE ON ai_consents FOR EACH ROW EXECUTE FUNCTION qorlla_append_only();
