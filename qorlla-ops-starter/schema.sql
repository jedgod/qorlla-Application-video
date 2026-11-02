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
