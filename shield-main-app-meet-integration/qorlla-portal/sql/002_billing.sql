-- Qorlla Workplace v4.1 - billing, entitlements and sales inquiries.
-- Safe to re-run. Reverse with sql/rollback/002_billing.down.sql (take a backup first: it drops billing data).
BEGIN;

-- roles: add 'billing' (can manage payment but not members) -----------------------------------------------------------
ALTER TABLE portal.members DROP CONSTRAINT IF EXISTS members_role_check;
ALTER TABLE portal.members ADD CONSTRAINT members_role_check CHECK (role IN ('owner','admin','billing','member'));

-- one authoritative plan catalogue --------------------------------------------------------------------------------------
ALTER TABLE portal.plans ADD COLUMN IF NOT EXISTS contact_sales boolean NOT NULL DEFAULT false;
ALTER TABLE portal.plans ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
UPDATE portal.plans SET contact_sales = true WHERE slug = 'enterprise';
UPDATE portal.plans SET sort_order = CASE slug WHEN 'basic' THEN 1 WHEN 'pro' THEN 2 WHEN 'business' THEN 3 WHEN 'enterprise' THEN 4 ELSE 9 END;

-- Price of ONE seat for ONE billing period, in minor units. Annual is a first-class value (not derived from monthly).
CREATE TABLE IF NOT EXISTS portal.plan_prices (
  plan_slug text NOT NULL REFERENCES portal.plans(slug),
  billing_interval text NOT NULL CHECK (billing_interval IN ('month','year')),
  currency text NOT NULL DEFAULT 'usd' CHECK (currency ~ '^[a-z]{3}$'),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_slug, billing_interval, currency)
);
-- Initial catalogue = the prices shown on the existing pricing page ($16.99 / $14.99 per month billed annually, $21.99 / $18.33).
-- CONFIRM THESE BEFORE ENABLING PAYMENTS; edit this table (or ship a new migration) to change what customers are charged.
INSERT INTO portal.plan_prices(plan_slug, billing_interval, amount_cents) VALUES
  ('pro','month',1699), ('pro','year',17988),
  ('business','month',2199), ('business','year',21996)
ON CONFLICT DO NOTHING;
UPDATE portal.plans SET monthly_cents = (SELECT amount_cents FROM portal.plan_prices WHERE plan_slug = plans.slug AND billing_interval = 'month' AND currency = 'usd')
  WHERE slug IN ('pro','business');   -- keep the legacy column consistent for older readers

-- entitlements enforced by the backend (NULL quota = unlimited) -------------------------------------------------------------
ALTER TABLE portal.entitlements ADD COLUMN IF NOT EXISTS description text;
INSERT INTO portal.entitlements(plan_slug, feature, quota, description) VALUES
  ('basic','notes.max',20,'Notes per workspace'),               ('pro','notes.max',1000,'Notes per workspace'),
  ('business','notes.max',10000,'Notes per workspace'),         ('enterprise','notes.max',NULL,'Notes per workspace'),
  ('basic','members.max',3,'Workspace members'),                ('pro','members.max',25,'Workspace members'),
  ('business','members.max',250,'Workspace members'),           ('enterprise','members.max',NULL,'Workspace members'),
  ('basic','ai.queries_per_month',20,'AI queries per month'),   ('pro','ai.queries_per_month',NULL,'AI queries per month'),
  ('business','ai.queries_per_month',NULL,'AI queries per month'), ('enterprise','ai.queries_per_month',NULL,'AI queries per month'),
  ('basic','meet.max_minutes',40,'Minutes per meeting'),        ('pro','meet.max_minutes',1800,'Minutes per meeting'),
  ('business','meet.max_minutes',1800,'Minutes per meeting'),   ('enterprise','meet.max_minutes',1800,'Minutes per meeting'),
  ('basic','meet.max_participants',100,'Participants per meeting'), ('pro','meet.max_participants',100,'Participants per meeting'),
  ('business','meet.max_participants',300,'Participants per meeting'), ('enterprise','meet.max_participants',1000,'Participants per meeting')
ON CONFLICT (plan_slug, feature) DO NOTHING;

-- subscriptions: explicit provider state ------------------------------------------------------------------------------------
ALTER TABLE portal.subscriptions ADD COLUMN IF NOT EXISTS billing_interval text CHECK (billing_interval IN ('month','year'));
ALTER TABLE portal.subscriptions ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE portal.subscriptions ADD COLUMN IF NOT EXISTS provider_customer_id text;
ALTER TABLE portal.subscriptions ADD COLUMN IF NOT EXISTS provider_subscription_id text;
ALTER TABLE portal.subscriptions ADD COLUMN IF NOT EXISTS seats integer NOT NULL DEFAULT 1 CHECK (seats BETWEEN 1 AND 10000);
ALTER TABLE portal.subscriptions ADD COLUMN IF NOT EXISTS current_period_start timestamptz;
ALTER TABLE portal.subscriptions ADD COLUMN IF NOT EXISTS current_period_end timestamptz;
ALTER TABLE portal.subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false;
ALTER TABLE portal.subscriptions ADD COLUMN IF NOT EXISTS canceled_at timestamptz;
ALTER TABLE portal.subscriptions ADD COLUMN IF NOT EXISTS last_event_at timestamptz;      -- provider timestamp of the newest applied event
ALTER TABLE portal.subscriptions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE portal.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE portal.subscriptions ADD CONSTRAINT subscriptions_status_check CHECK (status IN ('active','trialing','past_due','canceled','expired','incomplete'));
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_sub_uq ON portal.subscriptions(provider, provider_subscription_id) WHERE provider_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS portal.billing_customers (
  workspace_id uuid PRIMARY KEY REFERENCES portal.workspaces(id),
  provider text NOT NULL, provider_customer_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (provider, provider_customer_id)
);

-- A checkout session we created on the server. Only sessions found here can ever activate a workspace.
CREATE TABLE IF NOT EXISTS portal.checkout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  plan_slug text NOT NULL REFERENCES portal.plans(slug),
  billing_interval text NOT NULL CHECK (billing_interval IN ('month','year')),
  seats integer NOT NULL CHECK (seats BETWEEN 1 AND 10000),
  currency text NOT NULL, unit_amount_cents integer NOT NULL,           -- the price the customer was shown / charged
  provider text NOT NULL, provider_session_id text NOT NULL, provider_subscription_id text,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','completed','expired')),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE (provider, provider_session_id)
);

-- Every provider event once, for idempotency and replay protection.
CREATE TABLE IF NOT EXISTS portal.billing_events (
  provider text NOT NULL, event_id text NOT NULL, type text NOT NULL,
  provider_created_at timestamptz NOT NULL,
  payload jsonb NOT NULL, outcome text NOT NULL DEFAULT 'received',
  received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE IF NOT EXISTS portal.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  provider text NOT NULL, provider_invoice_id text NOT NULL, number text,
  status text NOT NULL CHECK (status IN ('open','paid','payment_failed','void','refunded','partially_refunded')),
  currency text NOT NULL, amount_due_cents integer NOT NULL, amount_paid_cents integer NOT NULL DEFAULT 0, amount_refunded_cents integer NOT NULL DEFAULT 0,
  hosted_invoice_url text, receipt_url text, period_start timestamptz, period_end timestamptz,
  attempt_count integer NOT NULL DEFAULT 0, next_payment_attempt timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), paid_at timestamptz,
  UNIQUE (provider, provider_invoice_id)
);
CREATE INDEX IF NOT EXISTS invoices_ws_idx ON portal.invoices(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS portal.refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  provider text NOT NULL, provider_refund_id text NOT NULL, provider_invoice_id text,
  amount_cents integer NOT NULL, currency text NOT NULL, reason text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (provider, provider_refund_id)
);

-- Enterprise "Contact sales" and general sales inquiries (public form; never trusted, rate limited by the API).
CREATE TABLE IF NOT EXISTS portal.sales_inquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, email text NOT NULL, company text, message text NOT NULL, plan_interest text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','closed')),
  source_ip_hash text, created_at timestamptz NOT NULL DEFAULT now()
);

-- Plan a workspace is entitled to RIGHT NOW. Paid plans need an active/trialing subscription (2 day webhook-lag allowance
-- after the period end) or a past_due one inside the 7 day payment-retry grace; everything else is Basic.
CREATE OR REPLACE VIEW portal.workspace_effective_plan AS
SELECT w.id AS workspace_id,
       CASE
         WHEN s.plan_slug IS NOT NULL AND s.plan_slug <> 'basic' AND (
              (s.status IN ('active','trialing') AND (s.current_period_end IS NULL OR s.current_period_end > now() - interval '2 days'))
           OR (s.status = 'past_due' AND s.current_period_end IS NOT NULL AND s.current_period_end > now() - interval '7 days'))
         THEN s.plan_slug ELSE 'basic'
       END AS plan_slug
FROM portal.workspaces w LEFT JOIN portal.subscriptions s ON s.workspace_id = w.id;

COMMIT;
