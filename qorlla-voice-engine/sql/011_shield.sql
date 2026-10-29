-- Qorlla Security Shield v2.2 (integrated into the voice engine): principals, organizations, PSTN authorizations, guest admission, media credentials, workload-credential replay, append-only security events. Idempotent. Run with the migration role.
CREATE TABLE IF NOT EXISTS shield_principals (
  account_id text PRIMARY KEY,
  org_id text,
  verified boolean NOT NULL DEFAULT false,
  suspended boolean NOT NULL DEFAULT false,
  tokens_valid_after timestamptz NOT NULL DEFAULT 'epoch',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shield_orgs (
  org_id text PRIMARY KEY,
  suspended boolean NOT NULL DEFAULT false,
  pstn_enabled boolean NOT NULL DEFAULT false,
  allowed_countries text[] NOT NULL DEFAULT '{}',
  max_active_calls integer NOT NULL DEFAULT 2 CHECK (max_active_calls BETWEEN 0 AND 1000),
  max_calls_hour integer NOT NULL DEFAULT 30 CHECK (max_calls_hour BETWEEN 0 AND 100000),
  spend_limit_cents bigint NOT NULL DEFAULT 0 CHECK (spend_limit_cents >= 0),
  spent_cents bigint NOT NULL DEFAULT 0 CHECK (spent_cents >= 0)
);
-- A caller ID may be presented only if it is verified AND owned by that account.
CREATE TABLE IF NOT EXISTS shield_caller_ids (
  e164 text PRIMARY KEY,
  account_id text NOT NULL,
  verified_at timestamptz
);
CREATE TABLE IF NOT EXISTS shield_workload_jti (
  jti_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS shield_workload_jti_expiry ON shield_workload_jti (expires_at);
CREATE TABLE IF NOT EXISTS shield_counters (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  n integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
CREATE TABLE IF NOT EXISTS shield_authorizations (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  account_id text NOT NULL,
  org_id text,
  action text NOT NULL,
  resource text NOT NULL,
  reserved_cents bigint NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'authorized' CHECK (state IN ('authorized','active','ended','revoked')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  ended_at timestamptz,
  actual_cents bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shield_auth_account ON shield_authorizations (account_id, created_at DESC);
CREATE TABLE IF NOT EXISTS shield_meetings (
  meeting_id text PRIMARY KEY,
  org_id text NOT NULL,
  host_account_id text NOT NULL,
  passcode_salt bytea NOT NULL,
  passcode_hash bytea NOT NULL,
  guest_enabled boolean NOT NULL DEFAULT false,
  requires_approval boolean NOT NULL DEFAULT true,
  max_guests integer NOT NULL DEFAULT 50 CHECK (max_guests BETWEEN 0 AND 1000),
  ends_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS shield_guest_admissions (
  id uuid PRIMARY KEY,
  meeting_id text NOT NULL REFERENCES shield_meetings(meeting_id),
  display_name text NOT NULL,
  state text NOT NULL CHECK (state IN ('WAITING','ADMITTED','DENIED','REVOKED')),
  claim_hash text NOT NULL,
  claimed_at timestamptz,
  decided_by text,
  decided_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shield_guest_adm_meeting ON shield_guest_admissions (meeting_id, state);
CREATE TABLE IF NOT EXISTS shield_media_tokens (
  token_hash text PRIMARY KEY,
  admission_id uuid NOT NULL REFERENCES shield_guest_admissions(id),
  meeting_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS shield_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text,
  action text NOT NULL,
  decision text NOT NULL,
  reason text NOT NULL,
  request_id text
);
CREATE INDEX IF NOT EXISTS shield_events_actor ON shield_events (actor, at DESC);
CREATE OR REPLACE FUNCTION shield_deny_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'shield_events is append-only'; END $$;
DROP TRIGGER IF EXISTS shield_events_append_only ON shield_events;
CREATE TRIGGER shield_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON shield_events FOR EACH STATEMENT EXECUTE FUNCTION shield_deny_event_mutation();
