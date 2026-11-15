-- Qorlla Meet breakout rooms V1.2 to V1.7 (v4.31): move epochs, group leads, room Mission Board, timed exercises, room whiteboard, group reports. Idempotent.
-- Run as the database owner BEFORE sql/005_app_role.sql, AFTER sql/v4_30_breakout_collab.sql.
-- Rollback: DROP TABLE more_class_reports, more_room_board_ops, more_class_submissions, more_class_exercises, more_mission_reports, more_mission_tasks, more_room_missions, more_breakout_leads, more_breakout_moves;
--           ALTER TABLE more_breakout_assignments DROP COLUMN move_epoch;
-- No table here has a foreign key to more_breakout_rooms on purpose: deleting a room must never delete the work done in it (the host keeps reading it).
BEGIN;

-- V1.2: every move bumps the person's epoch. Signals carry it, so a message sent before a move is refused after it.
ALTER TABLE more_breakout_assignments ADD COLUMN IF NOT EXISTS move_epoch bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS more_breakout_moves (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id     uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  from_room      uuid,
  to_room        uuid,
  epoch          bigint NOT NULL,
  state          text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','client_reported','failed','superseded')),   -- 'client_reported' is what the person's PAGE said, never proof
  issued_at      timestamptz NOT NULL DEFAULT now(),
  reported_at    timestamptz,
  UNIQUE (meeting_id, participant_id, epoch)
);
CREATE INDEX IF NOT EXISTS more_breakout_moves_meeting ON more_breakout_moves (meeting_id, issued_at DESC);

-- V1.2: group leads. A lead is a guest inside a room with a few room-only powers; never a host power.
CREATE TABLE IF NOT EXISTS more_breakout_leads (
  meeting_id     uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  room_id        uuid NOT NULL,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  capability     text NOT NULL CHECK (capability IN ('help_triage','room_announcement','room_notes','room_polls')),
  granted_by     uuid,
  granted_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, participant_id, capability)
);

-- V1.3: Room Mission Board
CREATE TABLE IF NOT EXISTS more_room_missions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id   uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  room_id      uuid NOT NULL,
  title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  instructions text NOT NULL DEFAULT '' CHECK (length(instructions) <= 12000),
  state        text NOT NULL DEFAULT 'open' CHECK (state IN ('open','submitted','closed')),
  created_by   uuid,
  version      bigint NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS more_room_missions_scope ON more_room_missions (meeting_id, room_id, created_at);
CREATE TABLE IF NOT EXISTS more_mission_tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id  uuid NOT NULL REFERENCES more_room_missions(id) ON DELETE CASCADE,
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  assignee_id uuid,
  state       text NOT NULL DEFAULT 'todo' CHECK (state IN ('todo','doing','done')),
  version     bigint NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS more_mission_reports (
  mission_id   uuid PRIMARY KEY REFERENCES more_room_missions(id) ON DELETE CASCADE,
  submitted_by uuid,
  report       text NOT NULL CHECK (length(report) <= 12000),
  submitted_at timestamptz NOT NULL DEFAULT now()
);

-- V1.4/V1.5: timed exercises (the database clock decides when they end) and one submission per person
CREATE TABLE IF NOT EXISTS more_class_exercises (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id  uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  room_id     uuid NOT NULL,
  mission_id  uuid REFERENCES more_room_missions(id) ON DELETE SET NULL,
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  prompt      text NOT NULL DEFAULT '' CHECK (length(prompt) <= 12000),
  duration_s  integer NOT NULL CHECK (duration_s BETWEEN 30 AND 14400),
  state       text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','running','closed')),
  started_at  timestamptz,
  ends_at     timestamptz,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS more_class_exercises_scope ON more_class_exercises (meeting_id, room_id, state);
CREATE TABLE IF NOT EXISTS more_class_submissions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_id    uuid NOT NULL REFERENCES more_class_exercises(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  answer         text NOT NULL CHECK (length(answer) <= 12000),
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exercise_id, participant_id)
);

-- V1.5: the whiteboard of one room: an append-only operation log, replayed from a cursor. Idempotent per op_id.
CREATE TABLE IF NOT EXISTS more_room_board_ops (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  room_id    uuid NOT NULL,
  op_id      uuid NOT NULL UNIQUE,
  actor_id   uuid,
  op         jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS more_room_board_ops_cursor ON more_room_board_ops (meeting_id, room_id, id);

-- V1.7: the written report of a room (kept for the host after the rooms close)
CREATE TABLE IF NOT EXISTS more_class_reports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  room_id    uuid NOT NULL,
  mission_id uuid REFERENCES more_room_missions(id) ON DELETE SET NULL,
  title      text NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  content    text NOT NULL CHECK (length(content) <= 20000),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS more_class_reports_scope ON more_class_reports (meeting_id, room_id, created_at);
COMMIT;
