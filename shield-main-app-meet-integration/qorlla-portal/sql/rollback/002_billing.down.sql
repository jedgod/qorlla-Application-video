-- Reverses sql/002_billing.sql. DESTROYS billing data (invoices, refunds, checkout sessions, provider events, sales inquiries)
-- and the provider columns on subscriptions: take a database backup first. Roles 'billing' are converted to 'member'.
BEGIN;
DROP VIEW IF EXISTS portal.workspace_effective_plan;
DROP TABLE IF EXISTS portal.sales_inquiries;
DROP TABLE IF EXISTS portal.refunds;
DROP TABLE IF EXISTS portal.invoices;
DROP TABLE IF EXISTS portal.billing_events;
DROP TABLE IF EXISTS portal.checkout_sessions;
DROP TABLE IF EXISTS portal.billing_customers;
DROP INDEX IF EXISTS portal.subscriptions_provider_sub_uq;
ALTER TABLE portal.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE portal.subscriptions
  DROP COLUMN IF EXISTS billing_interval, DROP COLUMN IF EXISTS provider, DROP COLUMN IF EXISTS provider_customer_id,
  DROP COLUMN IF EXISTS provider_subscription_id, DROP COLUMN IF EXISTS seats, DROP COLUMN IF EXISTS current_period_start,
  DROP COLUMN IF EXISTS current_period_end, DROP COLUMN IF EXISTS cancel_at_period_end, DROP COLUMN IF EXISTS canceled_at,
  DROP COLUMN IF EXISTS last_event_at, DROP COLUMN IF EXISTS updated_at;
DELETE FROM portal.entitlements WHERE feature IN ('notes.max','members.max','ai.queries_per_month','meet.max_minutes','meet.max_participants');
ALTER TABLE portal.entitlements DROP COLUMN IF EXISTS description;
DROP TABLE IF EXISTS portal.plan_prices;
ALTER TABLE portal.plans DROP COLUMN IF EXISTS contact_sales, DROP COLUMN IF EXISTS sort_order;
UPDATE portal.members SET role = 'member' WHERE role = 'billing';
ALTER TABLE portal.members DROP CONSTRAINT IF EXISTS members_role_check;
ALTER TABLE portal.members ADD CONSTRAINT members_role_check CHECK (role IN ('owner','admin','member'));
COMMIT;
