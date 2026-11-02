BEGIN;
CREATE TABLE IF NOT EXISTS ops_staff (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id text NOT NULL,identity_subject text NOT NULL,display_name text NOT NULL,team text NOT NULL,active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,identity_subject));
CREATE TABLE IF NOT EXISTS ops_shifts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id text NOT NULL,staff_id uuid NOT NULL REFERENCES ops_staff(id),starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,created_by text NOT NULL, CHECK(ends_at>starts_at));
CREATE TABLE IF NOT EXISTS ops_time_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id text NOT NULL,staff_id uuid NOT NULL REFERENCES ops_staff(id),started_at timestamptz NOT NULL,ended_at timestamptz,approved_by text,approved_at timestamptz,CHECK(ended_at IS NULL OR ended_at>started_at));
CREATE UNIQUE INDEX IF NOT EXISTS ops_one_open_clock ON ops_time_entries(tenant_id,staff_id) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS ops_ticket_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id text NOT NULL,ticket_id uuid NOT NULL REFERENCES ops_tickets(id),author_subject text NOT NULL,visibility text NOT NULL CHECK(visibility IN ('customer','internal')),body text NOT NULL CHECK(length(body) BETWEEN 1 AND 10000),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ops_refund_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id text NOT NULL,customer_id uuid NOT NULL,provider_payment_id text NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),currency char(3) NOT NULL,reason text NOT NULL,requested_by text NOT NULL,approved_by text,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','submitted','succeeded','failed')),idempotency_key text NOT NULL,provider_refund_id text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,idempotency_key));
CREATE TABLE IF NOT EXISTS ops_outbox (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,tenant_id text NOT NULL,topic text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),published_at timestamptz);
CREATE TABLE IF NOT EXISTS ops_audit_log (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,tenant_id text NOT NULL,actor_subject text NOT NULL,action text NOT NULL,resource_type text NOT NULL,resource_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE FUNCTION ops_block_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'append-only audit'; END $$;
DROP TRIGGER IF EXISTS ops_audit_append_only ON ops_audit_log;
CREATE TRIGGER ops_audit_append_only BEFORE UPDATE OR DELETE ON ops_audit_log FOR EACH ROW EXECUTE FUNCTION ops_block_audit_mutation();
CREATE INDEX IF NOT EXISTS ops_staff_lookup ON ops_staff(tenant_id,identity_subject);
CREATE INDEX IF NOT EXISTS ops_shifts_lookup ON ops_shifts(tenant_id,staff_id,starts_at);
CREATE INDEX IF NOT EXISTS ops_messages_lookup ON ops_ticket_messages(tenant_id,ticket_id,created_at);
CREATE INDEX IF NOT EXISTS ops_refunds_lookup ON ops_refund_requests(tenant_id,status,created_at);
-- Database role grants and RLS must be tailored to the deployed identity/connection model.
COMMIT;
