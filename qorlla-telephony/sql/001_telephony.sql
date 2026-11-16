BEGIN;
CREATE TABLE IF NOT EXISTS telephony_calls (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, actor_id uuid NOT NULL,
 destination text NOT NULL, kind text NOT NULL CHECK(kind IN ('internal','external')),
 state text NOT NULL CHECK(state IN ('authorized','ringing','answered','media_verifying','connected','ended','failed')),
 carrier_id text, gateway_call_id text, created_at timestamptz NOT NULL DEFAULT now(),
 connected_at timestamptz, ended_at timestamptz, version bigint NOT NULL DEFAULT 0,
 CHECK (kind <> 'external' OR carrier_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS telephony_calls_tenant_state_idx ON telephony_calls(tenant_id,state);
CREATE TABLE IF NOT EXISTS telephony_idempotency (
 tenant_id uuid NOT NULL, actor_id uuid NOT NULL, key text NOT NULL,
 request_hash text NOT NULL, call_id uuid NOT NULL REFERENCES telephony_calls(id),
 PRIMARY KEY(tenant_id,actor_id,key)
);
CREATE TABLE IF NOT EXISTS telephony_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, call_id uuid NOT NULL REFERENCES telephony_calls(id),
 event_type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
 occurred_at timestamptz NOT NULL DEFAULT now(), event_key text NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS telephony_outbox (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, call_id uuid NOT NULL REFERENCES telephony_calls(id),
 topic text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 delivered_at timestamptz, attempts int NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS telephony_usage (
 call_id uuid PRIMARY KEY REFERENCES telephony_calls(id), tenant_id uuid NOT NULL,
 billable_seconds bigint NOT NULL CHECK(billable_seconds >= 0),
 amount_minor bigint NOT NULL CHECK(amount_minor >= 0), currency char(3) NOT NULL,
 rated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS telephony_ledger (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL,
 call_id uuid NOT NULL REFERENCES telephony_calls(id), entry_type text NOT NULL,
 amount_minor bigint NOT NULL, currency char(3) NOT NULL,
 event_key text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
