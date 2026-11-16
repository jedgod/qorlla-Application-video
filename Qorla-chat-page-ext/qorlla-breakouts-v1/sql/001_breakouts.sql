-- Run inside Meet's existing PostgreSQL database after mapping meeting occurrence IDs.
CREATE SCHEMA IF NOT EXISTS meet_breakouts;
CREATE TABLE IF NOT EXISTS meet_breakouts.sessions (
  occurrence_id text PRIMARY KEY, revision bigint NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'idle' CHECK(state IN ('idle','active','closing','closed')),
  deadline timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meet_breakouts.rooms (
  id uuid PRIMARY KEY, occurrence_id text NOT NULL REFERENCES meet_breakouts.sessions(occurrence_id) ON DELETE CASCADE,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(occurrence_id,id)
);
CREATE TABLE IF NOT EXISTS meet_breakouts.assignments (
  occurrence_id text NOT NULL REFERENCES meet_breakouts.sessions(occurrence_id) ON DELETE CASCADE,
  participant_id text NOT NULL, room_id uuid REFERENCES meet_breakouts.rooms(id) ON DELETE SET NULL,
  role text NOT NULL DEFAULT 'member' CHECK(role IN ('member','lead')),
  revision bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(occurrence_id,participant_id)
);
CREATE TABLE IF NOT EXISTS meet_breakouts.events (
  occurrence_id text NOT NULL, seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS breakout_events_replay ON meet_breakouts.events(occurrence_id,seq);
CREATE TABLE IF NOT EXISTS meet_breakouts.audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, occurrence_id text NOT NULL,
  actor_id text NOT NULL, action text NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
