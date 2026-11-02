-- Reverses sql/012_sbacs.sql. Drops overrides, the entitlement event log and metered usage (take a backup first). Subscriptions, invoices and plans other than 'starter' are kept.
BEGIN;
UPDATE portal.subscriptions SET status = 'expired' WHERE status = 'suspended';
UPDATE portal.subscriptions SET plan_slug = 'basic' WHERE plan_slug = 'starter';
CREATE OR REPLACE VIEW portal.workspace_effective_plan AS
SELECT w.id AS workspace_id,
       CASE
         WHEN s.plan_slug IS NOT NULL AND s.plan_slug <> 'basic' AND (
              (s.status IN ('active','trialing') AND (s.current_period_end IS NULL OR s.current_period_end > now() - interval '2 days'))
           OR (s.status = 'past_due' AND s.current_period_end IS NOT NULL AND s.current_period_end > now() - interval '7 days'))
         THEN s.plan_slug ELSE 'basic'
       END AS plan_slug
FROM portal.workspaces w LEFT JOIN portal.subscriptions s ON s.workspace_id = w.id;
DROP TABLE IF EXISTS portal.usage_reservations;
DROP TABLE IF EXISTS portal.subscription_usage;
DROP TRIGGER IF EXISTS entitlement_events_guard_truncate ON portal.entitlement_events;
DROP TRIGGER IF EXISTS entitlement_events_guard ON portal.entitlement_events;
DROP TABLE IF EXISTS portal.entitlement_events;
DROP FUNCTION IF EXISTS portal.entitlement_events_append_only();
DROP TABLE IF EXISTS portal.entitlement_overrides;
DELETE FROM portal.entitlements WHERE feature IN ('meet.guest_join','meet.create','meet.recording','docs.create','docs.advanced','clips.create','ai.docs.draft','ai.private','analytics.advanced','org.admin','org.sso','voice.internal','phone.pstn') OR plan_slug = 'starter';
DELETE FROM portal.plans WHERE slug = 'starter';
ALTER TABLE portal.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE portal.subscriptions ADD CONSTRAINT subscriptions_status_check CHECK (status IN ('active','trialing','past_due','canceled','expired','incomplete'));
ALTER TABLE portal.workspaces DROP COLUMN IF EXISTS suspended_reason;
ALTER TABLE portal.workspaces DROP COLUMN IF EXISTS suspended_at;
ALTER TABLE portal.entitlements DROP COLUMN IF EXISTS enabled;
ALTER TABLE portal.plans DROP COLUMN IF EXISTS listed;
UPDATE portal.plans SET sort_order = CASE slug WHEN 'basic' THEN 1 WHEN 'pro' THEN 2 WHEN 'business' THEN 3 WHEN 'enterprise' THEN 4 ELSE 9 END;
COMMIT;
