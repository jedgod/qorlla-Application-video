-- Apply through controlled migrations; ownership belongs to MAIN identity.
CREATE TABLE IF NOT EXISTS qorlla_client_devices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
 installation_hash text NOT NULL UNIQUE, platform text NOT NULL CHECK(platform IN ('windows','macos','linux','android','ios')),
 push_token_ciphertext bytea, created_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz, last_seen_at timestamptz
);
CREATE INDEX IF NOT EXISTS qorlla_client_devices_user_active_idx ON qorlla_client_devices(user_id) WHERE revoked_at IS NULL;
-- Application roles must not have direct DELETE privileges; expose authorized functions only.
