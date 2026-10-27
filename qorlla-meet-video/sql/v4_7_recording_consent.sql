-- Qorlla Meet: recording requests, participant consent records and the recording audit trail (v4.7).
-- Idempotent. Run as the database owner BEFORE sql/005_app_role.sql (which then limits the application role: consents and audit events are APPEND-ONLY).
-- Rollback: DROP TABLE recording_audit, recording_consents, recording_sessions;  (consent history is lost; do this only after stopping the new Meet version)
CREATE TABLE IF NOT EXISTS recording_sessions (
  id                  uuid PRIMARY KEY,
  meeting_id          uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  requested_by        uuid NOT NULL REFERENCES participants(id),
  status              text NOT NULL CHECK (status IN ('awaiting','blocked','ready','recording','paused','stopped','cancelled')),
  purpose             text NOT NULL,
  recipients          text NOT NULL,
  retention           text NOT NULL,
  controller          text NOT NULL,
  privacy_contact     text NOT NULL,
  privacy_url         text,
  want_video          boolean NOT NULL,
  want_audio          boolean NOT NULL,
  policy_version      text NOT NULL,
  recorder_participant uuid REFERENCES participants(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  ended_at            timestamptz,
  end_reason          text,
  CHECK (want_video OR want_audio)
);
-- at most ONE live request/recording per meeting
CREATE UNIQUE INDEX IF NOT EXISTS recording_one_active ON recording_sessions (meeting_id) WHERE status IN ('awaiting','blocked','ready','recording','paused');
CREATE TABLE IF NOT EXISTS recording_consents (          -- append-only: the latest row per participant is the current decision
  id               uuid PRIMARY KEY,
  session_id       uuid NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  meeting_id       uuid NOT NULL,
  participant_id   uuid NOT NULL,                        -- the guest session / participant id
  participant_name text NOT NULL,
  role             text NOT NULL,
  decision         text NOT NULL CHECK (decision IN ('agree','decline','withdraw')),
  video            boolean NOT NULL DEFAULT false,
  audio            boolean NOT NULL DEFAULT false,
  ai               boolean NOT NULL DEFAULT false,       -- AI transcription/summaries are not offered by this version; always false
  notice_reviewed  boolean NOT NULL DEFAULT false,
  policy_version   text NOT NULL,
  audit_ref        uuid NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recording_consents_session ON recording_consents (session_id, participant_id, created_at DESC);
CREATE TABLE IF NOT EXISTS recording_audit (             -- append-only
  id           bigserial PRIMARY KEY,
  audit_ref    uuid NOT NULL UNIQUE,
  meeting_id   uuid NOT NULL,
  session_id   uuid,
  actor        uuid,
  actor_role   text,
  action       text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,       -- never contains media, passcodes or tokens
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recording_audit_meeting ON recording_audit (meeting_id, id DESC);
