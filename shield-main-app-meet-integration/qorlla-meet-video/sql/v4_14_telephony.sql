-- Qorlla Telephony v2 (v4.14): carrier numbers, calls, provider events, usage ledger, spending limits, release gates. Idempotent; run as the owner BEFORE sql/005_app_role.sql.
-- Adapted from the qorlla-telephony-v2 reference migration to this repository: there are no workspaces, so rows belong to a Qorlla account id (text, from the main app) and
-- administrator rights are decided by the main app server-side (PHONE_ADMIN_USERS), never by the browser.
-- Rollback: DROP TABLE qphone_audit, qphone_adjustments, qphone_usage, qphone_provider_events, qphone_call_intents, qphone_limits, qphone_gates, qphone_provider_status, qphone_provisioning_requests, qphone_numbers;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS qphone_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  e164 text NOT NULL UNIQUE CHECK (e164 ~ '^\+[1-9][0-9]{7,14}$'),
  provider text NOT NULL,
  provider_number_id text NOT NULL UNIQUE,
  country char(2) NOT NULL,
  kind text NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal','dialin')),   -- shared meeting dial-in numbers are separate from personal business numbers
  assigned_to text,                                                              -- Qorlla account id for personal numbers
  state text NOT NULL CHECK (state IN ('provisioning','active','suspended','releasing','released')),
  caller_id_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz, released_at timestamptz
);
CREATE TABLE IF NOT EXISTS qphone_provisioning_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id text NOT NULL, country char(2) NOT NULL, kind text NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal','dialin')), assign_to text,
  idempotency_key text NOT NULL,
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','processing','provisioned','failed','cancelled')),
  provider_reference text, error_code text, number_id uuid REFERENCES qphone_numbers(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS qphone_call_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id text NOT NULL, from_number_id uuid NOT NULL REFERENCES qphone_numbers(id),
  destination_e164 text NOT NULL CHECK (destination_e164 ~ '^\+[1-9][0-9]{7,14}$'), destination_country char(2),
  idempotency_key text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','placing','ringing','connected','completed','failed','cancelled')),
  provider_call_id text UNIQUE, error_code text, last_sequence int NOT NULL DEFAULT -1,
  created_at timestamptz NOT NULL DEFAULT now(), placed_at timestamptz, answered_at timestamptz, ended_at timestamptz,
  UNIQUE (actor_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS qphone_call_intents_actor ON qphone_call_intents (actor_id, created_at DESC);
CREATE TABLE IF NOT EXISTS qphone_provider_events (       -- replay protection: a provider event id is processed once; a repeat gets the stored answer
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL, provider_event_id text NOT NULL, call_intent_id uuid REFERENCES qphone_call_intents(id),
  event_type text NOT NULL, event_timestamp timestamptz, received_at timestamptz NOT NULL DEFAULT now(), result text,
  UNIQUE (provider, provider_event_id)
);
CREATE TABLE IF NOT EXISTS qphone_usage (                 -- provider cost and customer charge are kept apart; amounts are in millionths of the currency unit
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_intent_id uuid REFERENCES qphone_call_intents(id), actor_id text, provider text NOT NULL,
  provider_usage_id text NOT NULL UNIQUE, direction text NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound')), country char(2),
  billable_seconds bigint NOT NULL DEFAULT 0 CHECK (billable_seconds >= 0), local_seconds bigint,
  provider_cost_micros bigint NOT NULL DEFAULT 0 CHECK (provider_cost_micros >= 0), provider_currency char(3) NOT NULL DEFAULT 'USD',
  customer_charge_micros bigint NOT NULL DEFAULT 0 CHECK (customer_charge_micros >= 0), tax_micros bigint NOT NULL DEFAULT 0 CHECK (tax_micros >= 0),
  state text NOT NULL DEFAULT 'estimated' CHECK (state IN ('estimated','provider_confirmed','reconciled','disputed')),
  invoice_ref text, reconciled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS qphone_usage_actor ON qphone_usage (actor_id, created_at DESC);
CREATE TABLE IF NOT EXISTS qphone_adjustments (           -- refunds and corrections are new rows: the ledger is never edited
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), usage_id uuid NOT NULL REFERENCES qphone_usage(id), kind text NOT NULL CHECK (kind IN ('refund','adjustment')),
  amount_micros bigint NOT NULL, reason text NOT NULL, actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS qphone_limits ( owner_id text PRIMARY KEY, monthly_limit_micros bigint NOT NULL DEFAULT 0 CHECK (monthly_limit_micros >= 0), currency char(3) NOT NULL DEFAULT 'USD', updated_by text, updated_at timestamptz NOT NULL DEFAULT now() );
CREATE TABLE IF NOT EXISTS qphone_provider_status (       -- evidence about the carrier connection: a health check that really succeeded, and a signed webhook that was really received
  provider text PRIMARY KEY, health_ok boolean NOT NULL DEFAULT false, health_checked_at timestamptz, health_detail text, webhook_verified_at timestamptz
);
CREATE TABLE IF NOT EXISTS qphone_gates (                 -- independent release gates, recorded by an operator with an evidence file after real tests (scripts/phone-certify.mjs); never set by the API
  gate text PRIMARY KEY CHECK (gate IN ('dialin','carrier','bridge','billing')),
  certified_at timestamptz NOT NULL DEFAULT now(), evidence_ref text NOT NULL, evidence_sha256 text NOT NULL, certified_by text NOT NULL
);
CREATE TABLE IF NOT EXISTS qphone_audit ( id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), actor_id text, action text NOT NULL, subject text, detail jsonb );   -- never numbers' digits beyond last 4, PINs or secrets
