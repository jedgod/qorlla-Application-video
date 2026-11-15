-- Qorlla Meet "More" tab (v4.27): Q&A, the server-clock timer, per-person view preferences and an event cursor. Run as the database owner BEFORE sql/005_app_role.sql.
-- Rollback: DROP TABLE more_question_votes, more_questions, more_timers, more_preferences, more_events;
-- Everything is keyed by meetings(id): a meeting row IS one occurrence (a reused Meeting ID + password starts a NEW row), so nothing leaks from one run into the next.
BEGIN;
CREATE TABLE IF NOT EXISTS more_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meeting_id  uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  actor_id    uuid NOT NULL,
  kind        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS more_events_meeting ON more_events (meeting_id, id);
CREATE TABLE IF NOT EXISTS more_questions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id   uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  author_id    uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  question     text NOT NULL CHECK (length(question) BETWEEN 1 AND 2000),
  state        text NOT NULL DEFAULT 'open' CHECK (state IN ('open','answered','hidden')),
  answer       text,
  answered_by  uuid REFERENCES participants(id) ON DELETE SET NULL,
  answered_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS more_questions_meeting ON more_questions (meeting_id, created_at DESC);
CREATE TABLE IF NOT EXISTS more_question_votes (
  question_id uuid NOT NULL REFERENCES more_questions(id) ON DELETE CASCADE,
  voter_id    uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, voter_id)
);
CREATE TABLE IF NOT EXISTS more_timers (
  meeting_id  uuid PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  label       text NOT NULL DEFAULT '',
  ends_at     timestamptz,
  running     boolean NOT NULL DEFAULT false,
  updated_by  uuid NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS more_preferences (
  meeting_id     uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  focus_mode     boolean NOT NULL DEFAULT false,
  layout         text NOT NULL DEFAULT 'gallery' CHECK (layout IN ('gallery','speaker','stage')),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, participant_id)
);
COMMIT;
