BEGIN;
CREATE TABLE IF NOT EXISTS telephony_gateway_events (
 event_id text PRIMARY KEY, call_id uuid NOT NULL REFERENCES telephony_calls(id),
 gateway_id text NOT NULL, sequence_no bigint NOT NULL CHECK(sequence_no>=0),
 event_type text NOT NULL, payload jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(gateway_id,call_id,sequence_no)
);
CREATE TABLE IF NOT EXISTS telephony_meet_admissions (
 call_id uuid PRIMARY KEY REFERENCES telephony_calls(id), meeting_id text NOT NULL,
 approval_state text NOT NULL CHECK(approval_state IN ('pending','approved','denied','removed')),
 approved_by text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS telephony_outbox_delivery (
 outbox_id bigint PRIMARY KEY REFERENCES telephony_outbox(id), lease_owner text,
 lease_until timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 last_error text, dead_lettered_at timestamptz
);
CREATE INDEX IF NOT EXISTS telephony_outbox_pending_idx ON telephony_outbox(delivered_at,id);
CREATE TABLE IF NOT EXISTS telephony_carrier_cdr (
 carrier_id text NOT NULL, external_cdr_id text NOT NULL, call_id uuid NOT NULL REFERENCES telephony_calls(id),
 seconds bigint NOT NULL CHECK(seconds>=0), amount_minor bigint NOT NULL CHECK(amount_minor>=0),
 currency char(3) NOT NULL, raw_hash char(64) NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(carrier_id,external_cdr_id)
);
CREATE TABLE IF NOT EXISTS telephony_reconciliation (
 call_id uuid PRIMARY KEY REFERENCES telephony_calls(id), status text NOT NULL
 CHECK(status IN ('matched','disputed','pending')), difference_minor bigint NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS telephony_gateway_heartbeat (
 gateway_id text PRIMARY KEY, last_seen timestamptz NOT NULL DEFAULT now(),
 version text NOT NULL, capacity int NOT NULL CHECK(capacity>=0)
);
COMMIT;
