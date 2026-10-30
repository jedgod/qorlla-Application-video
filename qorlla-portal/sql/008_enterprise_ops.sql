-- Enterprise operations (Admin / Staff / customer Support): staff directory, tickets, workforce, two-person refunds, number and external-calling REQUESTS.
-- Integrates with the portal: users are MAIN user ids, refunds execute through the EXISTING billing service (portal.invoices / portal.refund_requests / portal.refunds stay the authority),
-- numbers are issued only by the Number Authority, and nothing here can activate calling (no status in this schema means "active"). Idempotent. Roll back with rollback/008_enterprise_ops.down.sql.
-- Run as the migration role; the application role gets SELECT/INSERT/UPDATE on new tables through the portal schema default privileges (no DELETE anywhere here).
CREATE TABLE IF NOT EXISTS portal.ops_staff (
  user_id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  team text NOT NULL CHECK (length(team) BETWEEN 2 AND 80),
  role text NOT NULL CHECK (role IN ('super_admin','ops_admin','supervisor','support_agent','billing_agent','technical_agent')),
  employment_status text NOT NULL DEFAULT 'active' CHECK (employment_status IN ('active','suspended','terminated')),
  permissions text[] NOT NULL DEFAULT '{}',
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portal.ops_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,                                   -- the MAIN user who owns the case; customers see only their own
  workspace_id uuid,
  category text NOT NULL CHECK (category IN ('meeting','audio','video','chat','billing','number','external_call','account','abuse','other')),
  subject text NOT NULL CHECK (length(subject) BETWEEN 3 AND 200),
  description text NOT NULL CHECK (length(description) BETWEEN 3 AND 10000),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','triaged','assigned','in_progress','waiting_customer','escalated','resolved','closed')),
  restricted boolean NOT NULL DEFAULT false,                   -- restricted cases (abuse) are visible only to their assignee and to leads
  assignee_id uuid REFERENCES portal.ops_staff(user_id),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ops_tickets_queue ON portal.ops_tickets (status, priority, created_at);
CREATE INDEX IF NOT EXISTS ops_tickets_customer ON portal.ops_tickets (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ops_tickets_assignee ON portal.ops_tickets (assignee_id, status);

CREATE TABLE IF NOT EXISTS portal.ops_ticket_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES portal.ops_tickets(id),
  actor_id uuid NOT NULL, event_type text NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS portal.ops_ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES portal.ops_tickets(id),
  author_id uuid NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('customer','staff')),
  visibility text NOT NULL CHECK (visibility IN ('customer','internal')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (author_kind = 'staff' OR visibility = 'customer')      -- a customer can never write an internal note
);
CREATE INDEX IF NOT EXISTS ops_messages_ticket ON portal.ops_ticket_messages (ticket_id, created_at);

CREATE TABLE IF NOT EXISTS portal.ops_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), staff_id uuid NOT NULL REFERENCES portal.ops_staff(user_id),
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, created_by uuid NOT NULL, CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS ops_shifts_staff ON portal.ops_shifts (staff_id, starts_at);
CREATE TABLE IF NOT EXISTS portal.ops_time_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), staff_id uuid NOT NULL REFERENCES portal.ops_staff(user_id),
  started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz, approved_by uuid, approved_at timestamptz,
  CHECK (ended_at IS NULL OR ended_at > started_at),
  CHECK (approved_by IS NULL OR approved_by <> staff_id),       -- nobody approves their own hours
  CHECK (approved_by IS NULL OR ended_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS ops_one_open_clock ON portal.ops_time_entries (staff_id) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS portal.ops_leave_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), staff_id uuid NOT NULL REFERENCES portal.ops_staff(user_id),
  kind text NOT NULL CHECK (kind IN ('vacation','sick','unpaid','other')), starts_on date NOT NULL, ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by uuid, decided_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on), CHECK (decided_by IS NULL OR decided_by <> staff_id)
);

-- Refunds: the REQUEST and the second person's approval live here; the money moves only through portal's billing service, which records portal.refund_requests / portal.refunds.
CREATE TABLE IF NOT EXISTS portal.ops_refund_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES portal.invoices(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  requested_by uuid NOT NULL, approved_by uuid, decided_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','executing','succeeded','failed')),
  idempotency_key text NOT NULL UNIQUE,
  provider_refund_id text, error_code text, executed_at timestamptz,
  reconcile_state text CHECK (reconcile_state IN ('matched','mismatch','needs_review')), reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR approved_by <> requested_by)    -- two people, enforced by the database too
);
CREATE INDEX IF NOT EXISTS ops_refunds_status ON portal.ops_refund_requests (status, created_at);
CREATE INDEX IF NOT EXISTS ops_refunds_invoice ON portal.ops_refund_requests (invoice_id);

CREATE TABLE IF NOT EXISTS portal.ops_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, topic text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
);
CREATE TABLE IF NOT EXISTS portal.ops_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id uuid NOT NULL, action text NOT NULL,
  resource_type text NOT NULL, resource_id text NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);

-- REQUESTS only. Neither table has a status that means "issued" or "active": numbers come from the Number Authority, calling from the Shield + payment entitlement + certified carrier.
CREATE TABLE IF NOT EXISTS portal.ops_number_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL, country char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  range_prefix text NOT NULL CHECK (range_prefix ~ '^[0-9]{4,8}$'), requested_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending_authority' CHECK (status IN ('pending_authority','rejected','cancelled')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS portal.ops_external_call_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL, plan_code text NOT NULL CHECK (plan_code ~ '^[A-Z0-9_-]{2,40}$'),
  invoice_id uuid REFERENCES portal.invoices(id), requested_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending_verification' CHECK (status IN ('pending_verification','rejected','cancelled')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ops_ext_one_pending ON portal.ops_external_call_requests (customer_id, plan_code) WHERE status = 'pending_verification';

-- Append-only history and audit (no edit, delete or truncate, whatever the role) and final refund states.
CREATE OR REPLACE FUNCTION portal.ops_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
DROP TRIGGER IF EXISTS ops_ticket_events_append_only ON portal.ops_ticket_events;
CREATE TRIGGER ops_ticket_events_append_only BEFORE UPDATE OR DELETE ON portal.ops_ticket_events FOR EACH ROW EXECUTE FUNCTION portal.ops_append_only();
DROP TRIGGER IF EXISTS ops_ticket_events_no_truncate ON portal.ops_ticket_events;
CREATE TRIGGER ops_ticket_events_no_truncate BEFORE TRUNCATE ON portal.ops_ticket_events FOR EACH STATEMENT EXECUTE FUNCTION portal.ops_append_only();
DROP TRIGGER IF EXISTS ops_audit_append_only ON portal.ops_audit_log;
CREATE TRIGGER ops_audit_append_only BEFORE UPDATE OR DELETE ON portal.ops_audit_log FOR EACH ROW EXECUTE FUNCTION portal.ops_append_only();
DROP TRIGGER IF EXISTS ops_audit_no_truncate ON portal.ops_audit_log;
CREATE TRIGGER ops_audit_no_truncate BEFORE TRUNCATE ON portal.ops_audit_log FOR EACH STATEMENT EXECUTE FUNCTION portal.ops_append_only();
CREATE OR REPLACE FUNCTION portal.ops_refund_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('rejected','succeeded','failed') AND NEW.status <> OLD.status THEN RAISE EXCEPTION 'refund request is already %', OLD.status; END IF;
  IF OLD.status = 'pending' AND NEW.status NOT IN ('pending','approved','rejected') THEN RAISE EXCEPTION 'a refund must be approved before it executes'; END IF;
  IF OLD.status = 'approved' AND NEW.status NOT IN ('approved','executing') THEN RAISE EXCEPTION 'an approved refund can only start executing'; END IF;
  IF OLD.status = 'executing' AND NEW.status NOT IN ('executing','approved','succeeded','failed') THEN RAISE EXCEPTION 'invalid refund transition from executing'; END IF;
  IF NEW.status = 'approved' AND NEW.approved_by IS NULL THEN RAISE EXCEPTION 'approval needs an approver'; END IF;
  IF NEW.amount_cents <> OLD.amount_cents OR NEW.invoice_id <> OLD.invoice_id OR NEW.requested_by <> OLD.requested_by THEN RAISE EXCEPTION 'a refund request cannot be altered'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ops_refund_guard ON portal.ops_refund_requests;
CREATE TRIGGER ops_refund_guard BEFORE UPDATE ON portal.ops_refund_requests FOR EACH ROW EXECUTE FUNCTION portal.ops_refund_guard();
