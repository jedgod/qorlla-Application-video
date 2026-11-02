BEGIN;
CREATE TABLE IF NOT EXISTS shield_number_projection (
 provider_sid text PRIMARY KEY, e164 text NOT NULL, account_id text,
 state text NOT NULL CHECK(state IN ('assigned','active','suspended','released')),
 authority_version bigint NOT NULL CHECK(authority_version>0), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS shield_one_live_number ON shield_number_projection(e164) WHERE state IN ('assigned','active','suspended');
CREATE TABLE IF NOT EXISTS shield_provider_events (
 event_id text PRIMARY KEY, payload jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shield_guest_admissions (
 id uuid PRIMARY KEY, meeting_id text NOT NULL, display_name text NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','approved','denied','expired','revoked')),
 approved_by text, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shield_guest_pending_idx ON shield_guest_admissions(meeting_id,expires_at) WHERE status='pending';
CREATE TABLE IF NOT EXISTS shield_pstn_reservations (
 idempotency_key text PRIMARY KEY, account_id text NOT NULL, destination text NOT NULL,
 status text NOT NULL CHECK(status IN ('reserved','dialed','uncertain','settled','cancelled')),
 estimated_cost_minor bigint NOT NULL CHECK(estimated_cost_minor>=0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shield_security_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, event_type text NOT NULL,
 principal_id text, payload jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION shield_deny_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'security audit is append-only'; END $$;
DROP TRIGGER IF EXISTS shield_audit_no_update ON shield_security_audit;
CREATE TRIGGER shield_audit_no_update BEFORE UPDATE OR DELETE ON shield_security_audit FOR EACH ROW EXECUTE FUNCTION shield_deny_audit_mutation();
COMMIT;
-- OPERATIONS: revoke UPDATE, DELETE, TRUNCATE from app roles, inherited roles, PUBLIC and default privileges;
-- grant INSERT via dedicated service role; use separate migration owner. Test effective privileges.
