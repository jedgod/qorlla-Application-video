CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS ops_tickets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 customer_id uuid NOT NULL,
 category text NOT NULL CHECK (category IN ('meeting','audio','video','chat','billing','number','external_call','account','abuse','other')),
 subject text NOT NULL CHECK (length(subject) BETWEEN 3 AND 200),
 description text NOT NULL,
 priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','critical')),
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','triaged','assigned','pending_customer','escalated','resolved','closed')),
 assignee_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ops_tickets_queue_idx ON ops_tickets(status,priority,created_at);
CREATE INDEX IF NOT EXISTS ops_tickets_customer_idx ON ops_tickets(customer_id,created_at DESC);
CREATE TABLE IF NOT EXISTS ops_ticket_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 ticket_id uuid NOT NULL REFERENCES ops_tickets(id),
 actor_id uuid NOT NULL,
 event_type text NOT NULL,
 details jsonb NOT NULL DEFAULT '{}'::jsonb,
 occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ops_external_call_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 customer_id uuid NOT NULL,
 plan_code text NOT NULL,
 status text NOT NULL DEFAULT 'pending_verification' CHECK(status IN ('pending_verification','rejected','verified','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now()
);
-- App role: grant only needed SELECT/INSERT/UPDATE columns; no DELETE/TRUNCATE on events.
-- Audit immutability must also be enforced against inherited and PUBLIC privileges.

-- ---- hardening (this repository's additions to the starter)
-- One pending request per customer and plan: a repeat is refused, not duplicated.
CREATE UNIQUE INDEX IF NOT EXISTS ops_ext_one_pending ON ops_external_call_requests(customer_id, plan_code) WHERE status = 'pending_verification';
-- Ticket history is append-only: no edit, delete or truncate, whoever the role.
CREATE OR REPLACE FUNCTION ops_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ops_ticket_events is append-only'; END $$;
DROP TRIGGER IF EXISTS ops_events_no_change ON ops_ticket_events;
CREATE TRIGGER ops_events_no_change BEFORE UPDATE OR DELETE ON ops_ticket_events FOR EACH ROW EXECUTE FUNCTION ops_events_immutable();
DROP TRIGGER IF EXISTS ops_events_no_truncate ON ops_ticket_events;
CREATE TRIGGER ops_events_no_truncate BEFORE TRUNCATE ON ops_ticket_events FOR EACH STATEMENT EXECUTE FUNCTION ops_events_immutable();
-- A request can become 'verified' only through the entitlement/payment authority, which sets this session flag inside its own transaction. The ops app never does, so it cannot verify a purchase.
CREATE OR REPLACE FUNCTION ops_ext_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'verified' AND current_setting('qorlla.entitlement_authority', true) IS DISTINCT FROM 'on' THEN RAISE EXCEPTION 'only the entitlement authority can verify a request'; END IF;
  IF OLD.status <> 'pending_verification' AND NEW.status <> OLD.status THEN RAISE EXCEPTION 'request is already %', OLD.status; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ops_ext_status_guard ON ops_external_call_requests;
CREATE TRIGGER ops_ext_status_guard BEFORE UPDATE ON ops_external_call_requests FOR EACH ROW EXECUTE FUNCTION ops_ext_guard();
