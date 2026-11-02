BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS ops_tickets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL, customer_id uuid NOT NULL,
 category text NOT NULL CHECK(category IN ('meeting','audio','video','chat','billing','number','external_call','account','abuse','other')),
 subject varchar(200) NOT NULL, description text NOT NULL,
 priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','critical')),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','assigned','in_progress','waiting_customer','escalated','resolved','closed')),
 assignee_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS ops_tickets_tenant_queue_idx ON ops_tickets(tenant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS ops_tickets_assignee_idx ON ops_tickets(tenant_id,assignee_id);
CREATE TABLE IF NOT EXISTS ops_ticket_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id text NOT NULL,
 ticket_id uuid NOT NULL REFERENCES ops_tickets(id), actor_id text NOT NULL,
 event_type text NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ops_external_call_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL,
 customer_id uuid NOT NULL, plan_code varchar(40) NOT NULL, requested_by text NOT NULL,
 status text NOT NULL DEFAULT 'pending_verification' CHECK(status IN ('pending_verification','rejected','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now());
-- The application role MUST NOT own these tables; use a separate migration role.
-- Enforce append-only ticket events even if an accidental UPDATE/DELETE grant is introduced.
CREATE OR REPLACE FUNCTION ops_reject_ticket_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ticket events are append-only'; END $$;
DROP TRIGGER IF EXISTS ops_ticket_events_append_only ON ops_ticket_events;
CREATE TRIGGER ops_ticket_events_append_only BEFORE UPDATE OR DELETE ON ops_ticket_events
FOR EACH ROW EXECUTE FUNCTION ops_reject_ticket_event_mutation();
COMMIT;
