-- Qorlla Voice Engine v1.1: one-use WebSocket tickets (only a SHA-256 hash is stored) and the ring-timeout index. Idempotent. Run with the migration role.
CREATE TABLE IF NOT EXISTS voice_ws_tickets (
  token_hash text PRIMARY KEY,
  account_id text NOT NULL REFERENCES voice_identities(account_id),
  origin text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_ws_tickets_expiry_idx ON voice_ws_tickets (expires_at);
CREATE INDEX IF NOT EXISTS voice_ws_tickets_account_idx ON voice_ws_tickets (account_id) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS voice_calls_ringing_expiry_idx ON voice_calls (created_at) WHERE status = 'ringing';
