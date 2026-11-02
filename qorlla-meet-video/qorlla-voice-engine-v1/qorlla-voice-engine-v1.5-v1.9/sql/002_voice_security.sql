-- Run with the dedicated migration role, not the runtime role.
CREATE TABLE IF NOT EXISTS voice_ws_tickets (
 token_hash text PRIMARY KEY, account_id text NOT NULL REFERENCES voice_identities(account_id),
 origin text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_ws_tickets_expiry_idx ON voice_ws_tickets(expires_at);
CREATE INDEX IF NOT EXISTS voice_calls_ringing_expiry_idx ON voice_calls(created_at) WHERE status='ringing';
