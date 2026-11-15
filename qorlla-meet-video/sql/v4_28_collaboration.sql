-- Qorlla Meet "More" > Collaboration (v4.28): the shared whiteboard and anonymous Q&A. Run as the database owner BEFORE sql/005_app_role.sql, AFTER sql/v4_27_more.sql.
-- Rollback: DROP TABLE more_board_ops, more_boards; ALTER TABLE more_questions DROP COLUMN anonymous;
-- One board per meeting occurrence (a meeting row IS one occurrence: a reused Meeting ID + password starts a new row and so a new, empty board).
BEGIN;
CREATE TABLE IF NOT EXISTS more_boards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id  uuid NOT NULL UNIQUE REFERENCES meetings(id) ON DELETE CASCADE,
  state       text NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
  allow_draw  boolean NOT NULL DEFAULT true,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS more_board_ops (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  board_id    uuid NOT NULL REFERENCES more_boards(id) ON DELETE CASCADE,
  actor_id    uuid NOT NULL,
  op          jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS more_board_ops_replay ON more_board_ops (board_id, id);
ALTER TABLE more_questions ADD COLUMN IF NOT EXISTS anonymous boolean NOT NULL DEFAULT false;
COMMIT;
