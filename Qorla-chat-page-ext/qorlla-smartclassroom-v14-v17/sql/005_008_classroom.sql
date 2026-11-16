-- Requires 001-004 and meet_breakouts schema. Apply in isolated PostgreSQL first.
CREATE TABLE IF NOT EXISTS meet_breakouts.classroom_exercises (
 id uuid PRIMARY KEY, occurrence_id text NOT NULL, room_id uuid NOT NULL,
 mission_id uuid REFERENCES meet_breakouts.room_missions(id),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 180),
 prompt text NOT NULL CHECK(length(prompt)<=12000),
 starts_at timestamptz NOT NULL DEFAULT now(), ends_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','running','closed')),
 created_by text NOT NULL, version bigint NOT NULL DEFAULT 1,
 FOREIGN KEY (occurrence_id,room_id) REFERENCES meet_breakouts.rooms(occurrence_id,id),
 CHECK(ends_at>starts_at)
);
CREATE INDEX IF NOT EXISTS exercises_room ON meet_breakouts.classroom_exercises(occurrence_id,room_id,state);
CREATE TABLE IF NOT EXISTS meet_breakouts.exercise_submissions (
 id uuid PRIMARY KEY, exercise_id uuid NOT NULL REFERENCES meet_breakouts.classroom_exercises(id),
 participant_id text NOT NULL, answer text NOT NULL CHECK(length(answer)<=12000),
 submitted_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(exercise_id,participant_id)
);
CREATE TABLE IF NOT EXISTS meet_breakouts.classroom_boards (
 id uuid PRIMARY KEY, occurrence_id text NOT NULL, room_id uuid NOT NULL,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(occurrence_id,room_id),
 FOREIGN KEY(occurrence_id,room_id) REFERENCES meet_breakouts.rooms(occurrence_id,id)
);
CREATE TABLE IF NOT EXISTS meet_breakouts.classroom_board_ops (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 board_id uuid NOT NULL REFERENCES meet_breakouts.classroom_boards(id),
 op_id uuid NOT NULL UNIQUE, actor_id text NOT NULL,
 op jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS classroom_board_cursor ON meet_breakouts.classroom_board_ops(board_id,id);
CREATE TABLE IF NOT EXISTS meet_breakouts.classroom_ai_jobs (
 id uuid PRIMARY KEY, occurrence_id text NOT NULL, room_id uuid NOT NULL,
 requested_by text NOT NULL, consent_record_id text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','failed','cancelled')),
 source_hash text NOT NULL, output jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 FOREIGN KEY(occurrence_id,room_id) REFERENCES meet_breakouts.rooms(occurrence_id,id)
);
CREATE TABLE IF NOT EXISTS meet_breakouts.classroom_reports (
 id uuid PRIMARY KEY, occurrence_id text NOT NULL, room_id uuid NOT NULL,
 mission_id uuid REFERENCES meet_breakouts.room_missions(id),
 title text NOT NULL, content jsonb NOT NULL, created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(occurrence_id,room_id) REFERENCES meet_breakouts.rooms(occurrence_id,id)
);
CREATE TABLE IF NOT EXISTS meet_breakouts.classroom_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, occurrence_id text NOT NULL,
 actor_id text NOT NULL, action text NOT NULL, resource_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
