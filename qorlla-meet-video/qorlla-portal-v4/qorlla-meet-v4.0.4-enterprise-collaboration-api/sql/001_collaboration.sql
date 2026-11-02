CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS meet_collab_meetings (
 id uuid PRIMARY KEY, owner_sub text NOT NULL, title text NOT NULL DEFAULT 'Meeting', locked boolean NOT NULL DEFAULT false,
 recording_state text NOT NULL DEFAULT 'off' CHECK (recording_state IN ('off','consent_pending','recording','stopped')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meet_collab_members (
 meeting_id uuid NOT NULL REFERENCES meet_collab_meetings(id) ON DELETE CASCADE,
 sub text NOT NULL, role text NOT NULL CHECK (role IN ('host','cohost','presenter','participant')),
 removed_at timestamptz, joined_at timestamptz, last_seen_at timestamptz,
 PRIMARY KEY(meeting_id,sub)
);
CREATE TABLE IF NOT EXISTS meet_collab_attendance (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), meeting_id uuid NOT NULL REFERENCES meet_collab_meetings(id), sub text NOT NULL,
 joined_at timestamptz NOT NULL DEFAULT now(), left_at timestamptz, reason text
);
CREATE INDEX IF NOT EXISTS meet_attendance_idx ON meet_collab_attendance(meeting_id,sub,joined_at DESC);
CREATE TABLE IF NOT EXISTS meet_collab_audit (
 id bigserial PRIMARY KEY, meeting_id uuid NOT NULL REFERENCES meet_collab_meetings(id), actor_sub text NOT NULL,
 event_type text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meet_collab_whiteboard (
 id bigserial PRIMARY KEY, meeting_id uuid NOT NULL REFERENCES meet_collab_meetings(id), room_id uuid,
 author_sub text NOT NULL, operation_id uuid NOT NULL UNIQUE, operation jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meet_collab_breakouts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), meeting_id uuid NOT NULL REFERENCES meet_collab_meetings(id), name text NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meet_collab_breakout_members (
 room_id uuid NOT NULL REFERENCES meet_collab_breakouts(id) ON DELETE CASCADE, sub text NOT NULL,
 PRIMARY KEY(room_id,sub)
);
CREATE TABLE IF NOT EXISTS meet_collab_files (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), meeting_id uuid NOT NULL REFERENCES meet_collab_meetings(id), uploader_sub text NOT NULL,
 object_key text NOT NULL UNIQUE, display_name text NOT NULL, content_type text NOT NULL, size_bytes bigint NOT NULL CHECK(size_bytes > 0 AND size_bytes <= 104857600),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','quarantined','ready','rejected')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meet_collab_questions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), meeting_id uuid NOT NULL REFERENCES meet_collab_meetings(id), author_sub text NOT NULL,
 body text NOT NULL, anonymous boolean NOT NULL DEFAULT false, answered boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meet_collab_question_votes (
 question_id uuid NOT NULL REFERENCES meet_collab_questions(id) ON DELETE CASCADE, sub text NOT NULL, PRIMARY KEY(question_id,sub)
);
CREATE TABLE IF NOT EXISTS meet_collab_notes (
 meeting_id uuid PRIMARY KEY REFERENCES meet_collab_meetings(id), markdown text NOT NULL DEFAULT '', revision bigint NOT NULL DEFAULT 0,
 updated_by text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meet_collab_consents (
 meeting_id uuid NOT NULL REFERENCES meet_collab_meetings(id), sub text NOT NULL, scope text NOT NULL CHECK(scope IN ('recording','transcription','ai_summary','translation')),
 granted boolean NOT NULL, notice_version text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(meeting_id,sub,scope)
);
CREATE TABLE IF NOT EXISTS meet_collab_transcripts (
 id bigserial PRIMARY KEY, meeting_id uuid NOT NULL REFERENCES meet_collab_meetings(id), provider_event_id text NOT NULL UNIQUE,
 speaker_sub text, language text NOT NULL, text text NOT NULL, start_ms bigint NOT NULL CHECK(start_ms >= 0), end_ms bigint NOT NULL CHECK(end_ms >= start_ms),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meet_collab_captions (
 id bigserial PRIMARY KEY, transcript_id bigint NOT NULL REFERENCES meet_collab_transcripts(id), language text NOT NULL, text text NOT NULL,
 UNIQUE(transcript_id,language)
);
CREATE TABLE IF NOT EXISTS meet_collab_summaries (
 meeting_id uuid PRIMARY KEY REFERENCES meet_collab_meetings(id), content jsonb NOT NULL, provider text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meet_collab_settings (
 meeting_id uuid NOT NULL REFERENCES meet_collab_meetings(id), sub text NOT NULL, settings jsonb NOT NULL DEFAULT '{}',
 PRIMARY KEY(meeting_id,sub)
);
CREATE TABLE IF NOT EXISTS meet_collab_recordings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), meeting_id uuid NOT NULL REFERENCES meet_collab_meetings(id), object_key text UNIQUE,
 state text NOT NULL CHECK(state IN ('requested','recording','processing','ready','failed','deleted')),
 started_at timestamptz, ended_at timestamptz, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
