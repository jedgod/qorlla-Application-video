-- Qorlla Meet v4.23: ASCS v1-v2 screen-share state. Idempotent.
--   meeting_shares : one row per share attempt. The partial unique index below is what makes "one active presenter per meeting" true even when two
--                    start requests arrive at the same instant (the loser gets a unique violation, never a second share).
--   UNIQUE(meeting_id, owner_id, request_id) : the idempotency key. A repeated request returns the SAME outcome, even after the share has stopped.
--   meetings.share_revision : monotonically increasing per meeting. Every state change takes the next number, so a late or replayed event can be recognised
--                             and can never bring a stopped share back to life.
-- The feature is OFF unless the server runs with ASCS_ENABLED=true; the tables are inert until then.
-- Rollback: DROP TABLE meeting_shares; ALTER TABLE meetings DROP COLUMN share_revision;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS share_revision bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS meeting_shares (
  id uuid PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('screen','window','tab')),
  mode text NOT NULL DEFAULT 'content' CHECK (mode = 'content'),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  state text NOT NULL CHECK (state IN ('active','stopped','revoked','expired')),
  revision bigint NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text,
  UNIQUE (meeting_id, owner_id, request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_share_per_meeting ON meeting_shares (meeting_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_meeting_shares_lease ON meeting_shares (lease_expires_at) WHERE state = 'active';
