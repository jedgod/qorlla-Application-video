-- Execute with migration role. Do not grant unrestricted write access to client roles.
CREATE TABLE IF NOT EXISTS voice_media_leases (
 call_id uuid NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
 account_id text NOT NULL REFERENCES voice_identities(account_id),
 device_id uuid NOT NULL,
 lease_token uuid NOT NULL,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(call_id,account_id)
);
CREATE INDEX IF NOT EXISTS voice_media_leases_expiry ON voice_media_leases(expires_at);
