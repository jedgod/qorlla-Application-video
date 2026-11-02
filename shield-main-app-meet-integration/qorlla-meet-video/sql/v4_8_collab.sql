-- Qorlla Meet: collaborative notes (autosave, revisions, edit grants) and server-authoritative polls (v4.8). Idempotent.
-- Run as the database owner BEFORE sql/005_app_role.sql. Rollback: DROP TABLE poll_ballots, poll_voters, meeting_polls, notes_editors, meeting_notes_revisions, meeting_notes;
CREATE TABLE IF NOT EXISTS meeting_notes (
  meeting_id      uuid PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  doc             jsonb NOT NULL,
  version         integer NOT NULL,
  updated_by      uuid,
  updated_by_name text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meeting_notes_revisions (      -- snapshots, append-only: a restore adds a new revision, it never rewrites history
  id            bigserial PRIMARY KEY,
  meeting_id    uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  version       integer NOT NULL,
  doc           jsonb NOT NULL,
  saved_by      uuid,
  saved_by_name text,
  reason        text NOT NULL DEFAULT 'edit',             -- edit | manual | restore | template
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, version)
);
CREATE TABLE IF NOT EXISTS notes_editors (                -- people the host allowed to edit (the host always can)
  meeting_id     uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL,
  granted_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, participant_id)
);
CREATE TABLE IF NOT EXISTS meeting_polls (
  id           uuid PRIMARY KEY,
  meeting_id   uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  created_by   uuid,
  question     text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('single','multiple','yesno','rating','ranking')),
  options      jsonb NOT NULL DEFAULT '[]'::jsonb,
  scale        integer,
  anonymous    boolean NOT NULL DEFAULT false,
  live_results boolean NOT NULL DEFAULT false,
  quiz         boolean NOT NULL DEFAULT false,
  correct      jsonb,
  explanation  text,
  duration_sec integer,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  published    boolean NOT NULL DEFAULT false,            -- host-controlled: results visible to everyone
  created_at   timestamptz NOT NULL DEFAULT now(),
  opened_at    timestamptz,
  closes_at    timestamptz,
  closed_at    timestamptz
);
CREATE INDEX IF NOT EXISTS meeting_polls_meeting ON meeting_polls (meeting_id, created_at DESC);
CREATE TABLE IF NOT EXISTS poll_voters (                  -- WHO voted (one row per participant per poll): enforces one ballot, never says what they chose
  poll_id        uuid NOT NULL REFERENCES meeting_polls(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL,
  PRIMARY KEY (poll_id, participant_id)
);
CREATE TABLE IF NOT EXISTS poll_ballots (                 -- WHAT was chosen. participant_id is NULL for anonymous polls and there is no timestamp, so a ballot cannot be tied to a person
  id             uuid PRIMARY KEY,
  poll_id        uuid NOT NULL REFERENCES meeting_polls(id) ON DELETE CASCADE,
  participant_id uuid,
  choices        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS poll_ballots_poll ON poll_ballots (poll_id);
