-- Reverses sql/014_sbacs_billing.sql. Keeps every billing event and entitlement event row; only the guards, the audit trigger, the history split and the flag are removed.
BEGIN;
DROP TRIGGER IF EXISTS billing_events_guard_truncate ON portal.billing_events;
DROP TRIGGER IF EXISTS billing_events_guard ON portal.billing_events;
DROP FUNCTION IF EXISTS portal.billing_events_guard();
DROP TRIGGER IF EXISTS subscription_audit ON portal.subscriptions;
DROP FUNCTION IF EXISTS portal.subscription_audit();
DELETE FROM portal.platform_flags WHERE key = 'billing_live';
ALTER TABLE portal.platform_flags DROP CONSTRAINT IF EXISTS platform_flags_key_check;
ALTER TABLE portal.platform_flags ADD CONSTRAINT platform_flags_key_check CHECK (key IN ('checkout','plan_changes','ai','overage_billing','meet_ai'));
DELETE FROM portal.entitlements WHERE feature IN ('docs.history.read','docs.history.restore','docs.history.compare','docs.history.retention','docs.recovery.advanced');
ALTER TABLE portal.entitlements DROP COLUMN IF EXISTS quota_approved;
COMMIT;
