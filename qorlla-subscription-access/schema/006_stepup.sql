-- Qorlla Subscription Access - 006 step-up authentication (WebAuthn / passkeys, TOTP as alternative or recovery)
-- A privileged action needs a FRESH proof, bound to the session that is acting and to the action itself, verified server-side.
-- Nothing a client sends (a "mfa_verified" flag, a timestamp) is ever accepted as proof: only a verified assertion creates a grant.

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  credential_id text PRIMARY KEY CHECK (char_length(credential_id) BETWEEN 1 AND 1400),
  user_id text NOT NULL CHECK (char_length(user_id) BETWEEN 1 AND 100),
  public_key bytea NOT NULL,
  sign_count bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports text[] NOT NULL DEFAULT '{}',
  device_type text,
  backed_up boolean NOT NULL DEFAULT false,
  label text NOT NULL DEFAULT '' CHECK (char_length(label) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS webauthn_credentials_user_idx ON webauthn_credentials (user_id) WHERE revoked_at IS NULL;

-- TOTP: the secret is stored ENCRYPTED (AES-256-GCM, key held by the service, never in the database).
-- last_step gives replay prevention (a time step is accepted once); failures/locked_until give rate limiting.
CREATE TABLE IF NOT EXISTS totp_factors (
  user_id text PRIMARY KEY CHECK (char_length(user_id) BETWEEN 1 AND 100),
  secret_enc bytea NOT NULL,
  confirmed boolean NOT NULL DEFAULT false,
  last_step bigint NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);

-- A challenge is bound to ONE session, user and action, is single-use and short-lived.
CREATE TABLE IF NOT EXISTS stepup_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('webauthn_register','webauthn_assert')),
  session_hash text NOT NULL CHECK (char_length(session_hash) BETWEEN 16 AND 200),
  user_id text NOT NULL,
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 60),
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stepup_challenges_lookup_idx ON stepup_challenges (session_hash, user_id, action, kind) WHERE used_at IS NULL;

-- A grant is the server's record that THIS session just proved a second factor for THIS action. Single-use by default.
CREATE TABLE IF NOT EXISTS stepup_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_hash text NOT NULL CHECK (char_length(session_hash) BETWEEN 16 AND 200),
  user_id text NOT NULL,
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 60),
  method text NOT NULL CHECK (method IN ('webauthn','totp')),
  verified_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > verified_at)
);
CREATE INDEX IF NOT EXISTS stepup_grants_lookup_idx ON stepup_grants (session_hash, user_id, action) WHERE consumed_at IS NULL;

-- The FIRST factor of a user cannot be enrolled from a session alone (a stolen session would enroll its own passkey).
-- Operations issues a one-time token out of band; only its hash is stored.
CREATE TABLE IF NOT EXISTS stepup_enrollment_tokens (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL,
  created_by text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stepup_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text,
  session_hash text,
  action text,
  event text NOT NULL,
  method text,
  ok boolean NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stepup_audit_user_idx ON stepup_audit (user_id, occurred_at DESC);
CREATE TRIGGER stepup_audit_immutable_row BEFORE UPDATE OR DELETE ON stepup_audit FOR EACH ROW EXECUTE FUNCTION qorlla_forbid_mutation();
CREATE TRIGGER stepup_audit_immutable_trunc BEFORE TRUNCATE ON stepup_audit FOR EACH STATEMENT EXECUTE FUNCTION qorlla_forbid_mutation();

-- Replay protection for signed service-to-service assertions (see adminServer): a jti is accepted once.
CREATE TABLE IF NOT EXISTS service_nonces (
  jti text PRIMARY KEY CHECK (char_length(jti) BETWEEN 8 AND 100),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS service_nonces_expiry_idx ON service_nonces (expires_at);

-- Only the internal administration role touches any of this. The request-path and webhook roles get nothing.
GRANT SELECT, INSERT ON webauthn_credentials TO qorlla_sub_admin;
GRANT UPDATE (sign_count, last_used_at, revoked_at) ON webauthn_credentials TO qorlla_sub_admin;
GRANT SELECT, INSERT ON totp_factors TO qorlla_sub_admin;
GRANT UPDATE (secret_enc, confirmed, last_step, failures, locked_until, confirmed_at) ON totp_factors TO qorlla_sub_admin;
GRANT SELECT, INSERT ON stepup_challenges TO qorlla_sub_admin;
GRANT UPDATE (used_at) ON stepup_challenges TO qorlla_sub_admin;
GRANT SELECT, INSERT ON stepup_grants TO qorlla_sub_admin;
GRANT UPDATE (consumed_at) ON stepup_grants TO qorlla_sub_admin;
GRANT SELECT, INSERT ON stepup_enrollment_tokens TO qorlla_sub_admin;
GRANT UPDATE (used_at) ON stepup_enrollment_tokens TO qorlla_sub_admin;
GRANT SELECT, INSERT ON stepup_audit TO qorlla_sub_admin;
GRANT SELECT, INSERT, DELETE ON service_nonces TO qorlla_sub_admin;
