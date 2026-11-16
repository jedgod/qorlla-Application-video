BEGIN;
CREATE TABLE IF NOT EXISTS telephony_gateway_bindings (
 call_id uuid PRIMARY KEY REFERENCES telephony_calls(id),
 gateway_id text NOT NULL,
 gateway_session_id text NOT NULL,
 meeting_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 UNIQUE(gateway_id,gateway_session_id)
);
CREATE TABLE IF NOT EXISTS telephony_auth_nonces (
 principal_id text NOT NULL,
 nonce text NOT NULL,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(principal_id,nonce)
);
CREATE INDEX IF NOT EXISTS telephony_auth_nonces_expiry_idx ON telephony_auth_nonces(expires_at);
CREATE TABLE IF NOT EXISTS telephony_release_gates (
 gate text PRIMARY KEY CHECK (gate IN ('internal','external')),
 enabled boolean NOT NULL DEFAULT false,
 certified_at timestamptz,
 certified_by text,
 evidence_digest char(64),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (NOT enabled OR (certified_at IS NOT NULL AND certified_by IS NOT NULL AND evidence_digest IS NOT NULL))
);
INSERT INTO telephony_release_gates(gate,enabled) VALUES('internal',false),('external',false) ON CONFLICT(gate) DO NOTHING;
CREATE TABLE IF NOT EXISTS telephony_meet_commands (
 command_id uuid PRIMARY KEY,
 call_id uuid NOT NULL REFERENCES telephony_calls(id),
 meeting_id text NOT NULL,
 action text NOT NULL CHECK(action IN ('admit','deny','mute','remove','end')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied','failed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 applied_at timestamptz
);
CREATE INDEX IF NOT EXISTS telephony_meet_commands_pending_idx ON telephony_meet_commands(state,created_at);
COMMIT;
