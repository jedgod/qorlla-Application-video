-- Reverses sql/007_billing_launch.sql. DESTROYS plan-change history, refund requests, usage prices/overage records, flags, platform audit and sales notes.
-- Refunds themselves (portal.refunds, from provider webhooks) and invoices are kept. Back up first.
BEGIN;
DROP TABLE IF EXISTS portal.sales_inquiry_notes;
UPDATE portal.sales_inquiries SET status='closed' WHERE status IN ('qualified','won','lost');
ALTER TABLE portal.sales_inquiries DROP CONSTRAINT IF EXISTS sales_inquiries_status_check;
ALTER TABLE portal.sales_inquiries ADD CONSTRAINT sales_inquiries_status_check CHECK (status IN ('new','contacted','closed'));
ALTER TABLE portal.sales_inquiries DROP COLUMN IF EXISTS updated_by;
ALTER TABLE portal.sales_inquiries DROP COLUMN IF EXISTS updated_at;
ALTER TABLE portal.sales_inquiries DROP COLUMN IF EXISTS assignee_id;
DROP TABLE IF EXISTS portal.platform_audit;
DROP TABLE IF EXISTS portal.platform_flags;
DROP TABLE IF EXISTS portal.usage_invoice_items;
DROP TABLE IF EXISTS portal.usage_overage_events;
DROP TABLE IF EXISTS portal.workspace_billing_settings;
DROP TABLE IF EXISTS portal.usage_prices;
DROP TABLE IF EXISTS portal.refund_requests;
DROP TABLE IF EXISTS portal.plan_changes;
ALTER TABLE portal.invoices DROP COLUMN IF EXISTS provider_charge_id;
ALTER TABLE portal.invoices DROP COLUMN IF EXISTS provider_payment_intent;
COMMIT;
