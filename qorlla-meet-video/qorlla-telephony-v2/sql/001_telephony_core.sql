-- Reference migration: adapt existing Qorlla workspace/meeting IDs and FK types.
-- Do not run unchanged against production without schema and role audit.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS qphone_provisioning_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 country char(2) NOT NULL,
 idempotency_key text NOT NULL,
 state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','processing','provisioned','failed','cancelled')),
 provider_reference text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS qphone_numbers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL,
 e164 text NOT NULL UNIQUE CHECK (e164 ~ '^\+[1-9][0-9]{7,14}$'),
 provider text NOT NULL,
 provider_number_id text NOT NULL UNIQUE,
 country char(2) NOT NULL,
 state text NOT NULL CHECK (state IN ('provisioning','active','suspended','releasing','released')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS qphone_call_intents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 from_number_id uuid NOT NULL REFERENCES qphone_numbers(id),
 destination_e164 text NOT NULL CHECK (destination_e164 ~ '^\+[1-9][0-9]{7,14}$'),
 idempotency_key text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','placing','ringing','connected','completed','failed','cancelled')),
 provider_call_id text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),
 answered_at timestamptz,
 ended_at timestamptz,
 UNIQUE(workspace_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS qphone_provider_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 provider text NOT NULL,
 provider_event_id text NOT NULL,
 call_intent_id uuid REFERENCES qphone_call_intents(id),
 event_type text NOT NULL,
 event_timestamp timestamptz,
 received_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider, provider_event_id)
);
CREATE TABLE IF NOT EXISTS qphone_usage (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 call_intent_id uuid REFERENCES qphone_call_intents(id),
 provider_usage_id text NOT NULL UNIQUE,
 billed_seconds bigint NOT NULL CHECK(billed_seconds >= 0),
 cost_minor bigint NOT NULL CHECK(cost_minor >= 0),
 currency char(3) NOT NULL,
 state text NOT NULL CHECK (state IN ('estimated','provider_confirmed','reconciled','disputed')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS qphone_call_intents_workspace_created ON qphone_call_intents(workspace_id,created_at DESC);
CREATE INDEX IF NOT EXISTS qphone_provider_events_call ON qphone_provider_events(call_intent_id);
