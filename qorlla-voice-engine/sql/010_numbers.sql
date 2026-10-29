-- Qorlla Voice v1.12: telephone numbers assigned to accounts (adapted from the "voice number pack"). Additive and idempotent. Run with the migration role.
-- A number is an optional ATTRIBUTE of an existing voice identity; it is never a routing key (see docs/VOICE_IDENTITY_AND_DISCOVERY.md). The feature is off unless VOICE_NUMBERS_ENABLED=true and no provider is
-- connected: nothing here places or receives a telephone call. Tables are prefixed voice_num_ so they cannot be confused with the engine's call tables.
CREATE TABLE IF NOT EXISTS voice_num_country_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id text NOT NULL REFERENCES voice_identities(account_id),
  country_code char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  kind text NOT NULL CHECK (kind IN ('ip_suggestion','verified_residency','verified_business')),   -- an IP suggestion is recorded but can never qualify
  verified_by text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_num_evidence_lookup ON voice_num_country_evidence (account_id, country_code, kind, created_at DESC);
CREATE TABLE IF NOT EXISTS voice_num_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_number_id text NOT NULL,
  e164 text NOT NULL UNIQUE CHECK (e164 ~ '^\+[1-9][0-9]{1,14}$'),
  country_code char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','reserved','assigned','quarantined','retired')),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (provider, provider_number_id)
);
CREATE INDEX IF NOT EXISTS voice_num_inventory_free ON voice_num_inventory (country_code, id) WHERE status = 'available';
CREATE TABLE IF NOT EXISTS voice_num_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id text NOT NULL REFERENCES voice_identities(account_id),
  inventory_id uuid NOT NULL REFERENCES voice_num_inventory(id),
  status text NOT NULL CHECK (status IN ('pending','active','suspended','release_pending','released','failed')),
  provider_operation_id text,
  request_key text NOT NULL,
  request_hash text NOT NULL,                                  -- the same key with a different request is refused, not silently answered with the first
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS voice_num_one_current_per_account ON voice_num_assignments (account_id) WHERE status IN ('pending','active','suspended','release_pending');
CREATE UNIQUE INDEX IF NOT EXISTS voice_num_one_current_per_number ON voice_num_assignments (inventory_id) WHERE status IN ('pending','active','suspended','release_pending');
CREATE TABLE IF NOT EXISTS voice_num_provider_events (
  provider text NOT NULL,
  event_id text NOT NULL,
  payload_hash text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
CREATE TABLE IF NOT EXISTS voice_num_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor text NOT NULL,
  subject_account_id text,
  action text NOT NULL,
  resource_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Append-only: no update, delete or truncate, whoever asks (the database owner can still drop the trigger: this is a guard, not tamper-proofing).
CREATE OR REPLACE FUNCTION voice_num_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'voice number audit events are append-only'; END $$;
DROP TRIGGER IF EXISTS voice_num_audit_no_mutation ON voice_num_audit;
CREATE TRIGGER voice_num_audit_no_mutation BEFORE UPDATE OR DELETE ON voice_num_audit FOR EACH ROW EXECUTE FUNCTION voice_num_audit_immutable();
DROP TRIGGER IF EXISTS voice_num_audit_no_truncate ON voice_num_audit;
CREATE TRIGGER voice_num_audit_no_truncate BEFORE TRUNCATE ON voice_num_audit FOR EACH STATEMENT EXECUTE FUNCTION voice_num_audit_immutable();
CREATE TABLE IF NOT EXISTS voice_num_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assignment_id uuid NOT NULL REFERENCES voice_num_assignments(id),
  action text NOT NULL CHECK (action IN ('provision','release')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','done','dead')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, action)
);
CREATE INDEX IF NOT EXISTS voice_num_outbox_due ON voice_num_outbox (next_attempt_at) WHERE status IN ('queued','processing');
