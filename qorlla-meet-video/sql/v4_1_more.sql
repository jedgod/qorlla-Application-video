-- Run as the database owner, then reapply 005_app_role.sql. No automatic migration.
-- A meeting UUID is terminal in this service. A reused public code must resolve
-- to a NEW meeting UUID; it never reopens a prior occurrence.
CREATE TABLE IF NOT EXISTS meet_more_occurrences (
 id uuid PRIMARY KEY, meeting_id uuid NOT NULL UNIQUE REFERENCES meetings(id) ON DELETE CASCADE,
 guest_chat boolean NOT NULL DEFAULT true, reactions boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meet_more_moderators (
 occurrence_id uuid NOT NULL REFERENCES meet_more_occurrences(id) ON DELETE CASCADE,
 participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
 active boolean NOT NULL DEFAULT true, PRIMARY KEY(occurrence_id,participant_id)
);
CREATE TABLE IF NOT EXISTS meet_more_questions (
 id uuid PRIMARY KEY, occurrence_id uuid NOT NULL REFERENCES meet_more_occurrences(id) ON DELETE CASCADE,
 author_id uuid NOT NULL REFERENCES participants(id), question varchar(1000) NOT NULL,
 answer varchar(2000) NOT NULL DEFAULT '',
 status varchar(12) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','published','answered','dismissed')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(occurrence_id,id)
);
CREATE INDEX IF NOT EXISTS meet_more_questions_occurrence ON meet_more_questions(occurrence_id,created_at);
CREATE TABLE IF NOT EXISTS meet_more_votes (
 occurrence_id uuid NOT NULL, question_id uuid NOT NULL, participant_id uuid NOT NULL REFERENCES participants(id),
 active boolean NOT NULL DEFAULT true, PRIMARY KEY(occurrence_id,question_id,participant_id),
 FOREIGN KEY(occurrence_id,question_id) REFERENCES meet_more_questions(occurrence_id,id) ON DELETE CASCADE
);
