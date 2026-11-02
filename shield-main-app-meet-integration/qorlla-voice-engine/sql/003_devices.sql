-- Qorlla Voice Engine v1.2: device ownership. A WebSocket ticket is bound to the device that asked for it, and each participant of a call has ONE current media device (a lease with a
-- generation number that only ever grows). Idempotent. Run with the migration role.
ALTER TABLE voice_ws_tickets ADD COLUMN IF NOT EXISTS device_id uuid;
CREATE TABLE IF NOT EXISTS voice_media_leases (
  call_id uuid NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES voice_identities(account_id),
  device_id uuid NOT NULL,
  lease_token uuid NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (call_id, account_id)
);
CREATE INDEX IF NOT EXISTS voice_media_leases_expiry ON voice_media_leases (expires_at);
