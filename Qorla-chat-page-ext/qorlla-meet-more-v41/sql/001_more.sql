-- Isolated Qorlla Meet More v4.1 schema. Requires PostgreSQL 15+.
-- meeting_occurrence_id and actor_id are opaque identifiers supplied by Meet adapters.
BEGIN;
CREATE SCHEMA IF NOT EXISTS meet_more;
CREATE TABLE IF NOT EXISTS meet_more.occurrence_state (
 occurrence_id text PRIMARY KEY, locked boolean NOT NULL DEFAULT false,
 recording_state text NOT NULL DEFAULT 'off' CHECK(recording_state IN ('off','requested','active','stopping','failed')),
 settings jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS meet_more.events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, occurrence_id text NOT NULL,
 actor_id text NOT NULL, kind text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS more_events_occ_idx ON meet_more.events(occurrence_id,id);
CREATE TABLE IF NOT EXISTS meet_more.reactions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, occurrence_id text NOT NULL,
 actor_id text NOT NULL, emoji text NOT NULL CHECK(emoji IN ('👍','👏','❤️','🎉','😂')),
 created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS more_reactions_occ_idx ON meet_more.reactions(occurrence_id,created_at DESC);
CREATE TABLE IF NOT EXISTS meet_more.questions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), occurrence_id text NOT NULL,
 author_id text NOT NULL, question text NOT NULL CHECK(length(question) BETWEEN 1 AND 2000),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','answered','hidden')),
 answer text, answered_by text, answered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS more_questions_occ_idx ON meet_more.questions(occurrence_id,created_at DESC);
CREATE TABLE IF NOT EXISTS meet_more.question_votes (
 question_id uuid NOT NULL REFERENCES meet_more.questions(id) ON DELETE CASCADE,
 actor_id text NOT NULL, PRIMARY KEY(question_id,actor_id));
CREATE TABLE IF NOT EXISTS meet_more.whiteboards (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), occurrence_id text NOT NULL,
 title text NOT NULL DEFAULT 'Whiteboard', created_by text NOT NULL,
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')),
 created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS meet_more.whiteboard_ops (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, board_id uuid NOT NULL REFERENCES meet_more.whiteboards(id),
 actor_id text NOT NULL, operation jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS more_board_ops_idx ON meet_more.whiteboard_ops(board_id,id);
CREATE TABLE IF NOT EXISTS meet_more.breakout_rooms (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), occurrence_id text NOT NULL,
 name text NOT NULL, state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')),
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS meet_more.breakout_assignments (
 room_id uuid NOT NULL REFERENCES meet_more.breakout_rooms(id) ON DELETE CASCADE,
 participant_id text NOT NULL, PRIMARY KEY(room_id,participant_id));
CREATE TABLE IF NOT EXISTS meet_more.files (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), occurrence_id text NOT NULL,
 uploaded_by text NOT NULL, object_key text NOT NULL UNIQUE, filename text NOT NULL,
 mime_type text NOT NULL, bytes bigint NOT NULL CHECK(bytes >= 0),
 scan_state text NOT NULL DEFAULT 'quarantined' CHECK(scan_state IN ('quarantined','clean','infected','error')),
 created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS meet_more.transcript_segments (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, occurrence_id text NOT NULL,
 speaker_id text, body text NOT NULL, start_ms bigint NOT NULL CHECK(start_ms >= 0),
 end_ms bigint NOT NULL CHECK(end_ms >= start_ms), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS meet_more.ai_artifacts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), occurrence_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('summary','takeaways','answer')),
 created_by text NOT NULL, body text NOT NULL, gateway_request_id text,
 created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS meet_more.invites (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), occurrence_id text NOT NULL,
 created_by text NOT NULL, recipient text NOT NULL, state text NOT NULL DEFAULT 'pending',
 created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS meet_more.attendance (
 occurrence_id text NOT NULL, participant_id text NOT NULL, joined_at timestamptz NOT NULL,
 left_at timestamptz, PRIMARY KEY(occurrence_id,participant_id,joined_at));
CREATE TABLE IF NOT EXISTS meet_more.timers (
 occurrence_id text PRIMARY KEY, ends_at timestamptz, running boolean NOT NULL DEFAULT false,
 updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS meet_more.preferences (
 occurrence_id text NOT NULL, actor_id text NOT NULL,
 focus_mode boolean NOT NULL DEFAULT false, layout text NOT NULL DEFAULT 'gallery',
 background text NOT NULL DEFAULT 'none', device_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
 other_settings jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(occurrence_id,actor_id));
COMMIT;
