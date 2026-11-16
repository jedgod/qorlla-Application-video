BEGIN;
CREATE SCHEMA IF NOT EXISTS meet_collab;
CREATE TABLE IF NOT EXISTS meet_collab.meeting_occurrences (
 id uuid PRIMARY KEY, meet_meeting_id text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended')),
 created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS meet_collab.events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, occurrence_id uuid NOT NULL REFERENCES meet_collab.meeting_occurrences(id),
 kind text NOT NULL, actor_id text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS events_replay_idx ON meet_collab.events(occurrence_id,id);
CREATE TABLE IF NOT EXISTS meet_collab.reactions (
 id uuid PRIMARY KEY, occurrence_id uuid NOT NULL REFERENCES meet_collab.meeting_occurrences(id), actor_id text NOT NULL,
 emoji text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS reactions_rate_idx ON meet_collab.reactions(occurrence_id,actor_id,created_at DESC);
CREATE TABLE IF NOT EXISTS meet_collab.boards (
 id uuid PRIMARY KEY, occurrence_id uuid NOT NULL REFERENCES meet_collab.meeting_occurrences(id), title text NOT NULL,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS meet_collab.board_ops (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, board_id uuid NOT NULL REFERENCES meet_collab.boards(id),
 actor_id text NOT NULL, operation jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS board_ops_replay_idx ON meet_collab.board_ops(board_id,id);
CREATE TABLE IF NOT EXISTS meet_collab.breakout_rooms (
 id uuid PRIMARY KEY, occurrence_id uuid NOT NULL REFERENCES meet_collab.meeting_occurrences(id), title text NOT NULL,
 lead_participant_id text, state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','open','closed')),
 deadline_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS meet_collab.breakout_assignments (
 occurrence_id uuid NOT NULL REFERENCES meet_collab.meeting_occurrences(id), participant_id text NOT NULL,
 room_id uuid NOT NULL REFERENCES meet_collab.breakout_rooms(id), assigned_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(occurrence_id,participant_id));
CREATE TABLE IF NOT EXISTS meet_collab.shared_files (
 id uuid PRIMARY KEY, occurrence_id uuid NOT NULL REFERENCES meet_collab.meeting_occurrences(id), uploader_id text NOT NULL,
 filename text NOT NULL, mime text NOT NULL, size_bytes bigint NOT NULL CHECK(size_bytes > 0),
 storage_key text NOT NULL UNIQUE, sha256 text NOT NULL,
 status text NOT NULL DEFAULT 'quarantined' CHECK(status IN ('quarantined','clean','blocked','deleted')),
 created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS meet_collab.questions (
 id uuid PRIMARY KEY, occurrence_id uuid NOT NULL REFERENCES meet_collab.meeting_occurrences(id), actor_id text NOT NULL,
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 4000), anonymous boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','answered','hidden')),
 answer text, answered_by text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS meet_collab.question_votes (
 question_id uuid NOT NULL REFERENCES meet_collab.questions(id), actor_id text NOT NULL, PRIMARY KEY(question_id,actor_id));
CREATE TABLE IF NOT EXISTS meet_collab.transcript_sessions (
 id uuid PRIMARY KEY, occurrence_id uuid NOT NULL REFERENCES meet_collab.meeting_occurrences(id),
 requested_by text NOT NULL, state text NOT NULL CHECK(state IN ('pending_consent','active','stopped','failed')),
 started_at timestamptz, ended_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS meet_collab.transcript_segments (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, session_id uuid NOT NULL REFERENCES meet_collab.transcript_sessions(id),
 speaker_participant_id text, start_ms bigint NOT NULL, end_ms bigint NOT NULL,
 text text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS meet_collab.audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, occurrence_id uuid NOT NULL, actor_id text NOT NULL,
 action text NOT NULL, target_id text, created_at timestamptz NOT NULL DEFAULT now());
COMMIT;
