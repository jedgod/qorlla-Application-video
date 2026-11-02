-- Qorlla Voice Engine v1.0: identities, calls, events, idempotency, blocks. Idempotent. Run with the migration role, not the runtime role.
CREATE TABLE IF NOT EXISTS voice_identities (
  account_id text PRIMARY KEY,
  extension text UNIQUE NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (extension ~ '^[0-9]{3,8}$')
);
CREATE TABLE IF NOT EXISTS voice_calls (
  id uuid PRIMARY KEY,
  caller_id text NOT NULL REFERENCES voice_identities(account_id),
  callee_id text NOT NULL REFERENCES voice_identities(account_id),
  status text NOT NULL CHECK (status IN ('ringing','active','rejected','missed','ended','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  ended_at timestamptz,
  end_reason text,
  version bigint NOT NULL DEFAULT 0,
  CHECK (caller_id <> callee_id)
);
CREATE INDEX IF NOT EXISTS voice_calls_caller_idx ON voice_calls (caller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS voice_calls_callee_idx ON voice_calls (callee_id, created_at DESC);
-- one live call per account in each role; the service also checks both roles together under advisory locks
CREATE UNIQUE INDEX IF NOT EXISTS voice_one_live_caller ON voice_calls (caller_id) WHERE status IN ('ringing','active');
CREATE UNIQUE INDEX IF NOT EXISTS voice_one_live_callee ON voice_calls (callee_id) WHERE status IN ('ringing','active');
CREATE TABLE IF NOT EXISTS voice_call_events (
  id bigserial PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES voice_calls(id),
  actor_id text NOT NULL,
  kind text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_call_events_call_idx ON voice_call_events (call_id, at);
CREATE TABLE IF NOT EXISTS voice_idempotency (
  account_id text NOT NULL,
  request_key text NOT NULL,
  call_id uuid NOT NULL REFERENCES voice_calls(id),
  extension text,
  PRIMARY KEY (account_id, request_key)
);
CREATE TABLE IF NOT EXISTS voice_blocks (
  owner_id text NOT NULL REFERENCES voice_identities(account_id),
  blocked_id text NOT NULL REFERENCES voice_identities(account_id),
  PRIMARY KEY (owner_id, blocked_id)
);
