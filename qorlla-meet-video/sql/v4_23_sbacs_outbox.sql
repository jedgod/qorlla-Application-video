-- Meet v4.23: SBACS settlement outbox. When the entitlement service cannot be reached, work that has ALREADY been done (media accepted for an authorised recording, a reservation that
-- could not be finalized or released) is written here and settled later with stable operation keys, so usage is neither lost nor double counted. Safe to re-run.
-- Reverse: DROP TABLE sbacs_outbox; (only after every row is settled, or usage for that work is lost).
CREATE TABLE IF NOT EXISTS sbacs_outbox (
  op_key text PRIMARY KEY,                                   -- the stable operation id (the same key the reservation used), so a retry can never be counted twice
  kind text NOT NULL CHECK (kind IN ('record', 'finalize', 'release')),
  account_id text NOT NULL,
  feature text NOT NULL,
  units integer NOT NULL CHECK (units >= 0),
  reservation_id uuid,
  meeting_id uuid,
  recording_id uuid,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE INDEX IF NOT EXISTS sbacs_outbox_open_idx ON sbacs_outbox (created_at) WHERE settled_at IS NULL;
CREATE INDEX IF NOT EXISTS sbacs_outbox_recording_idx ON sbacs_outbox (recording_id) WHERE settled_at IS NULL AND kind = 'record';
