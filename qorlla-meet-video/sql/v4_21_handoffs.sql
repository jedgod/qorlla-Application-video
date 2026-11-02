-- Qorlla Meet v4.21: single-use hand-off codes (replaces putting an 8-hour bearer session token in the URL). Idempotent.
-- The Workplace server joins a person to a meeting on their behalf, then asks Meet (bridge secret) for a CODE for that participant. The browser receives only the code, in the URL fragment;
-- Meet redeems it exactly once, within a minute, and mints the session itself, taking the role and name from its own participant row (the caller can choose neither). Only a hash of the code is stored.
-- Rollback: DROP TABLE handoffs;  (Workplace then falls back to the old fragment only for a Meet that answers 404 to POST /api/integrations/handoffs)
CREATE TABLE IF NOT EXISTS handoffs (
  code_hash      text PRIMARY KEY,
  meeting_id     uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  redeemed_at    timestamptz
);
CREATE INDEX IF NOT EXISTS handoffs_expiry ON handoffs (expires_at);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qorlla_meet_app') THEN GRANT SELECT, INSERT, UPDATE, DELETE ON handoffs TO qorlla_meet_app; END IF;
END $$;
