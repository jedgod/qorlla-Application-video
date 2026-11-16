-- A4.9: isolated from legacy portal.call_sessions and telephony_events.
-- Prerequisite: portal.workspaces from 001_portal.sql; no release enabled.
BEGIN;
CREATE TABLE IF NOT EXISTS portal.a49_gates (
  kind text PRIMARY KEY CHECK (kind IN ('internal','external')),
  enabled boolean NOT NULL DEFAULT false,
  certified_at timestamptz,
  evidence_sha256 char(64),
  approved_by uuid,
  CHECK (NOT enabled OR (certified_at IS NOT NULL AND evidence_sha256 IS NOT NULL AND approved_by IS NOT NULL))
);
INSERT INTO portal.a49_gates(kind) VALUES ('internal'),('external') ON CONFLICT (kind) DO NOTHING;
CREATE TABLE portal.a49_gateway_principals (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 100),
  secret_cipher_reference text NOT NULL, -- reference to secrets manager, NEVER actual secret
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE portal.a49_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  request_id uuid NOT NULL UNIQUE,
  requested_by uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('internal','external')),
  destination text NOT NULL,
  meeting_id uuid,
  gateway_id text REFERENCES portal.a49_gateway_principals(id),
  gateway_session_id text,
  state text NOT NULL DEFAULT 'authorized' CHECK (state IN ('authorized','ringing','answered','media_verifying','connected','ended','failed')),
  sequence_no bigint NOT NULL DEFAULT -1,
  admitted boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  connected_at timestamptz,
  ended_at timestamptz,
  UNIQUE (gateway_id, gateway_session_id),
  CHECK ((gateway_id IS NULL AND gateway_session_id IS NULL) OR (gateway_id IS NOT NULL AND gateway_session_id IS NOT NULL))
);
CREATE INDEX a49_calls_workspace_idx ON portal.a49_calls(workspace_id, created_at DESC);
CREATE TABLE portal.a49_gateway_nonces (
  gateway_id text NOT NULL REFERENCES portal.a49_gateway_principals(id),
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (gateway_id, nonce)
);
CREATE INDEX a49_nonces_expiry ON portal.a49_gateway_nonces(expires_at);
CREATE TABLE portal.a49_events (
  event_id uuid PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES portal.a49_calls(id),
  gateway_id text NOT NULL,
  sequence_no bigint NOT NULL CHECK (sequence_no >= 0),
  event_type text NOT NULL,
  payload_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, sequence_no)
);
CREATE TABLE portal.a49_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  call_id uuid NOT NULL REFERENCES portal.a49_calls(id),
  topic text NOT NULL,
  payload jsonb NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner uuid,
  lease_token uuid,
  lease_until timestamptz,
  delivered_at timestamptz,
  dead_lettered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX a49_outbox_pending ON portal.a49_outbox(next_attempt_at,id)
  WHERE delivered_at IS NULL AND dead_lettered_at IS NULL;
CREATE TABLE portal.a49_meet_commands (
  command_id uuid PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES portal.a49_calls(id),
  meeting_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('admit','deny','mute','remove','end')),
  actor_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(call_id,action)
);
CREATE TABLE portal.a49_carrier_cdr (
  carrier_id text NOT NULL,
  cdr_id text NOT NULL,
  call_id uuid NOT NULL REFERENCES portal.a49_calls(id),
  duration_seconds bigint NOT NULL CHECK(duration_seconds >= 0),
  currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK(amount_minor >= 0),
  payload_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(carrier_id,cdr_id)
);
CREATE TABLE portal.a49_ratings (
  call_id uuid PRIMARY KEY REFERENCES portal.a49_calls(id),
  currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK(amount_minor >= 0),
  rated_seconds bigint NOT NULL CHECK(rated_seconds >= 0),
  tariff_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE VIEW portal.a49_reconciliation AS
 SELECT c.carrier_id,c.cdr_id,c.call_id,c.amount_minor AS carrier_minor,r.amount_minor AS rated_minor,
 CASE WHEN r.call_id IS NULL THEN 'pending'
      WHEN c.currency<>r.currency OR c.amount_minor<>r.amount_minor THEN 'disputed'
      ELSE 'matched' END AS result
 FROM portal.a49_carrier_cdr c LEFT JOIN portal.a49_ratings r ON r.call_id=c.call_id;
COMMIT;
