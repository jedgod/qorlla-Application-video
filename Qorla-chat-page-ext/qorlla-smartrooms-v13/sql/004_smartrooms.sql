-- Requires Meet breakout migrations 001-003. Apply to disposable PostgreSQL first.
CREATE TABLE IF NOT EXISTS meet_breakouts.room_missions (
 id uuid PRIMARY KEY, occurrence_id text NOT NULL, room_id uuid NOT NULL,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 180), instructions text NOT NULL DEFAULT '',
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','submitted','closed')),
 created_by text NOT NULL, version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (occurrence_id,room_id) REFERENCES meet_breakouts.rooms(occurrence_id,id)
);
CREATE INDEX IF NOT EXISTS room_missions_scope ON meet_breakouts.room_missions(occurrence_id,room_id,state);
CREATE TABLE IF NOT EXISTS meet_breakouts.mission_tasks (
 id uuid PRIMARY KEY, mission_id uuid NOT NULL REFERENCES meet_breakouts.room_missions(id) ON DELETE CASCADE,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 180), assignee_id text,
 state text NOT NULL DEFAULT 'todo' CHECK(state IN ('todo','doing','done')),
 version bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meet_breakouts.mission_reports (
 mission_id uuid PRIMARY KEY REFERENCES meet_breakouts.room_missions(id) ON DELETE CASCADE,
 submitted_by text NOT NULL, report text NOT NULL CHECK(length(report)<=12000),
 submitted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meet_breakouts.room_progress_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, occurrence_id text NOT NULL,
 room_id uuid NOT NULL, actor_id text NOT NULL, kind text NOT NULL,
 payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS progress_room_events ON meet_breakouts.room_progress_events(occurrence_id,room_id,id);
