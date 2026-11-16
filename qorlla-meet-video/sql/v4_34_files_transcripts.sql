-- Qorlla Meet shared files (immutable scan pipeline) and consent-gated live transcripts (v4.34). Idempotent.
-- Run as the database owner BEFORE sql/005_app_role.sql, AFTER sql/v4_33_relay_observation.sql.
-- Rollback: sql/rollback/v4_34.down.sql
-- Both features are OFF unless MEET_FILES=on / MEET_TRANSCRIPT=on and their back ends are configured. Nothing here stores audio.
BEGIN;

-- presence heartbeat: every Meet instance refreshes the sessions of its own sockets every 30 s, so a crashed instance leaves a ghost for at most 90 s (not until somebody notices)
ALTER TABLE participant_sessions ADD COLUMN IF NOT EXISTS seen_at timestamptz NOT NULL DEFAULT now();

-- ---------------------------------------------------------------- shared files
-- An upload is written to a QUARANTINE object that only the server can name, scanned as exactly those bytes, and promoted to a write-once, content-addressed CLEAN object (clean/<sha256>)
-- only when it is clean. There is no upload URL a client could reuse to overwrite a scanned object. A download re-hashes the clean object and refuses if it no longer matches sha256.
CREATE TABLE IF NOT EXISTS more_files (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id     uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  room_id        uuid,                                         -- NULL = main room; no foreign key: deleting a room must not delete or expose its files
  uploader_id    uuid NOT NULL REFERENCES participants(id),
  filename       text NOT NULL CHECK (length(filename) BETWEEN 1 AND 180),
  declared_type  text NOT NULL,
  detected_type  text,
  bytes          bigint,
  sha256         text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  state          text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading','scanning','clean','rejected','deleted')),
  reason         text,                                         -- why it was rejected (a code, never file content)
  visibility     text NOT NULL DEFAULT 'room' CHECK (visibility IN ('room','meeting','host_only')),
  host_approved  boolean NOT NULL DEFAULT false,
  quarantine_key text,                                         -- server-chosen, unique per upload, removed after the scan
  scan_attempts  integer NOT NULL DEFAULT 0,
  scan_lease     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  scanned_at     timestamptz,
  expires_at     timestamptz NOT NULL,
  deleted_at     timestamptz
);
CREATE INDEX IF NOT EXISTS more_files_meeting ON more_files (meeting_id, state, created_at);
CREATE INDEX IF NOT EXISTS more_files_sha ON more_files (sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS more_files_sweep ON more_files (expires_at) WHERE state <> 'deleted';

-- ---------------------------------------------------------------- live transcripts
-- A session belongs to ONE room scope. Every person who is in that scope must agree; a join, leave, move or withdrawal bumps the epoch and pauses it. Each participant's page records ONLY their own microphone; a
-- chunk is processed only while the speaker's own consent and the current epoch hold, re-checked in the same transaction that stores the result.
CREATE TABLE IF NOT EXISTS more_transcript_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id   uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  room_id      uuid,                                          -- NULL = main room
  created_by   uuid NOT NULL REFERENCES participants(id),
  language     text NOT NULL DEFAULT 'en' CHECK (language ~ '^[a-z]{2,3}$'),
  status       text NOT NULL DEFAULT 'awaiting_consent' CHECK (status IN ('awaiting_consent','active','paused','stopped')),
  epoch        bigint NOT NULL DEFAULT 1,
  stopped_reason text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  stopped_at   timestamptz,
  expires_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS more_transcript_sessions_meeting ON more_transcript_sessions (meeting_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS more_transcript_one_live_per_scope ON more_transcript_sessions (meeting_id, COALESCE(room_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status <> 'stopped';
CREATE TABLE IF NOT EXISTS more_transcript_consents (
  session_id     uuid NOT NULL REFERENCES more_transcript_sessions(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  consent        boolean NOT NULL,
  decided_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, participant_id)
);
CREATE TABLE IF NOT EXISTS more_transcript_segments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES more_transcript_sessions(id) ON DELETE CASCADE,
  speaker_id  uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  epoch       bigint NOT NULL,
  start_ms    bigint NOT NULL CHECK (start_ms >= 0),
  end_ms      bigint NOT NULL CHECK (end_ms >= start_ms),
  text        text NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  chunk_id    uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS more_transcript_segments_session ON more_transcript_segments (session_id, start_ms);
CREATE INDEX IF NOT EXISTS more_transcript_segments_speaker ON more_transcript_segments (session_id, speaker_id);
-- chunk bookkeeping only (idempotency, never audio)
CREATE TABLE IF NOT EXISTS more_transcript_chunks (
  session_id   uuid NOT NULL REFERENCES more_transcript_sessions(id) ON DELETE CASCADE,
  chunk_id     uuid NOT NULL,
  speaker_id   uuid NOT NULL,
  epoch        bigint NOT NULL,
  status       text NOT NULL CHECK (status IN ('processing','done','failed','rejected')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, chunk_id)
);
COMMIT;
