BEGIN;
CREATE SCHEMA IF NOT EXISTS meet_collab;
CREATE TABLE meet_collab.files (
 id uuid PRIMARY KEY, tenant_id text NOT NULL, occurrence_id text NOT NULL,
 room_id text, uploader_id text NOT NULL, filename text NOT NULL,
 declared_type text NOT NULL, detected_type text, bytes bigint NOT NULL CHECK(bytes BETWEEN 1 AND 104857600),
 sha256 text CHECK(sha256 ~ '^[a-f0-9]{64}$'), object_key text NOT NULL UNIQUE,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','scanning','clean','rejected','deleted')),
 visibility text NOT NULL DEFAULT 'room' CHECK(visibility IN ('room','meeting','host_only')),
 host_approved boolean NOT NULL DEFAULT false, scan_engine text, scan_result text,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 version bigint NOT NULL DEFAULT 0, deleted_at timestamptz,
 UNIQUE(tenant_id,occurrence_id,id)
);
CREATE INDEX files_scope ON meet_collab.files(tenant_id,occurrence_id,room_id,state);
CREATE TABLE meet_collab.file_access (
 file_id uuid NOT NULL REFERENCES meet_collab.files(id) ON DELETE CASCADE,
 participant_id text NOT NULL, action text NOT NULL CHECK(action IN ('read','write')),
 PRIMARY KEY(file_id,participant_id,action)
);
CREATE TABLE meet_collab.transcript_sessions (
 id uuid PRIMARY KEY, tenant_id text NOT NULL, occurrence_id text NOT NULL, room_id text,
 status text NOT NULL DEFAULT 'awaiting_consent' CHECK(status IN ('awaiting_consent','active','paused','stopped')),
 consent_epoch bigint NOT NULL DEFAULT 1, language text NOT NULL DEFAULT 'en',
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), stopped_at timestamptz,
 UNIQUE(tenant_id,occurrence_id,id)
);
CREATE TABLE meet_collab.transcript_participants (
 session_id uuid NOT NULL REFERENCES meet_collab.transcript_sessions(id) ON DELETE CASCADE,
 participant_id text NOT NULL, consent boolean NOT NULL DEFAULT false,
 consent_at timestamptz, revoked_at timestamptz,
 PRIMARY KEY(session_id,participant_id)
);
CREATE TABLE meet_collab.transcript_segments (
 id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES meet_collab.transcript_sessions(id) ON DELETE CASCADE,
 tenant_id text NOT NULL, speaker_id text NOT NULL, consent_epoch bigint NOT NULL,
 start_ms bigint NOT NULL CHECK(start_ms>=0), end_ms bigint NOT NULL CHECK(end_ms>=start_ms),
 text text NOT NULL CHECK(length(text)<=10000), confidence real CHECK(confidence BETWEEN 0 AND 1),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(session_id,speaker_id,start_ms,end_ms)
);
CREATE INDEX transcript_segments_session ON meet_collab.transcript_segments(session_id,start_ms);
CREATE TABLE meet_collab.collab_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id text NOT NULL,
 occurrence_id text NOT NULL, actor_id text NOT NULL, action text NOT NULL,
 target_id text NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb,
 at timestamptz NOT NULL DEFAULT now()
);
COMMIT;