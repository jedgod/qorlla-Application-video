-- Qorlla Workplace v4.5 - Billing and Enterprise launch controls. Reverse with sql/rollback/007_billing_launch.down.sql.
-- Nothing here charges anybody: plan changes, refunds and usage billing all go through the payment provider adapter, which stays unavailable
-- until billing is configured, tested and explicitly authorised; usage prices ship EMPTY and inactive.
BEGIN;

-- refunds are issued against a payment, so keep the provider's payment identifiers
ALTER TABLE portal.invoices ADD COLUMN IF NOT EXISTS provider_payment_intent text;
ALTER TABLE portal.invoices ADD COLUMN IF NOT EXISTS provider_charge_id text;

-- ---- plan changes (upgrade now with proration / downgrade at period end). Local state only changes after the PROVIDER confirms it. ----
CREATE TABLE IF NOT EXISTS portal.plan_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  provider_subscription_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('upgrade','downgrade','seats','interval')),
  from_plan text NOT NULL, from_interval text NOT NULL, from_seats integer NOT NULL,
  to_plan text NOT NULL REFERENCES portal.plans(slug), to_interval text NOT NULL CHECK (to_interval IN ('month','year')), to_seats integer NOT NULL CHECK (to_seats BETWEEN 1 AND 10000),
  unit_amount_cents integer NOT NULL, currency text NOT NULL,                     -- the price snapshot the customer was shown
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','scheduled','applied','failed','cancelled')),
  effective_at timestamptz NOT NULL,
  requested_by uuid NOT NULL, idempotency_key text,
  error_code text, created_at timestamptz NOT NULL DEFAULT now(), applied_at timestamptz,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS plan_changes_one_open ON portal.plan_changes(workspace_id) WHERE status IN ('requested','scheduled');

-- ---- refunds started by platform admins ----
CREATE TABLE IF NOT EXISTS portal.refund_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  provider_invoice_id text NOT NULL, amount_cents integer NOT NULL CHECK (amount_cents > 0), reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','succeeded','failed')),
  provider_refund_id text, error_code text,
  requested_by uuid NOT NULL, idempotency_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key)
);

-- ---- usage-based AI billing: opt-in overage, admin-set unit prices (none by default), price snapshot per event ----
CREATE TABLE IF NOT EXISTS portal.usage_prices (
  usage_feature text PRIMARY KEY CHECK (usage_feature IN ('meeting_report','assistant_message','doc_generation')),
  unit_amount_cents integer NOT NULL CHECK (unit_amount_cents > 0), currency text NOT NULL DEFAULT 'usd',
  active boolean NOT NULL DEFAULT false, updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS portal.workspace_billing_settings (
  workspace_id uuid PRIMARY KEY REFERENCES portal.workspaces(id),
  overage_enabled boolean NOT NULL DEFAULT false, overage_accepted_by uuid, overage_accepted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS portal.usage_overage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  usage_feature text NOT NULL, units integer NOT NULL CHECK (units > 0),
  unit_amount_cents integer NOT NULL, currency text NOT NULL, period_month date NOT NULL,
  idempotency_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS usage_overage_period_idx ON portal.usage_overage_events(period_month, workspace_id);
CREATE TABLE IF NOT EXISTS portal.usage_invoice_items (
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id), usage_feature text NOT NULL, period_month date NOT NULL,
  units integer NOT NULL, amount_cents integer NOT NULL, currency text NOT NULL, provider_invoice_item_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, usage_feature, period_month)
);

-- ---- kill switches (platform admins) ----
CREATE TABLE IF NOT EXISTS portal.platform_flags (
  key text PRIMARY KEY CHECK (key IN ('checkout','plan_changes','ai','overage_billing')),
  enabled boolean NOT NULL DEFAULT true, reason text, updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO portal.platform_flags(key) VALUES ('checkout'),('plan_changes'),('ai'),('overage_billing') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS portal.platform_audit (
  id bigserial PRIMARY KEY, actor_id uuid NOT NULL, action text NOT NULL, object_id text, detail jsonb, created_at timestamptz NOT NULL DEFAULT now()
);

-- ---- Enterprise "Contact sales" workflow ----
ALTER TABLE portal.sales_inquiries DROP CONSTRAINT IF EXISTS sales_inquiries_status_check;
ALTER TABLE portal.sales_inquiries ADD CONSTRAINT sales_inquiries_status_check CHECK (status IN ('new','contacted','qualified','won','lost','closed'));
ALTER TABLE portal.sales_inquiries ADD COLUMN IF NOT EXISTS assignee_id uuid;
ALTER TABLE portal.sales_inquiries ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE portal.sales_inquiries ADD COLUMN IF NOT EXISTS updated_by uuid;
CREATE TABLE IF NOT EXISTS portal.sales_inquiry_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), inquiry_id uuid NOT NULL REFERENCES portal.sales_inquiries(id) ON DELETE CASCADE,
  author_id uuid NOT NULL, note text NOT NULL CHECK (length(note) BETWEEN 1 AND 2000), created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
