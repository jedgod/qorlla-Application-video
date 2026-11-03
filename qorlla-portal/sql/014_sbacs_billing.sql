-- Qorlla SBACS Phase 3A: billing foundation guarantees. Reverse with sql/rollback/014_sbacs_billing.down.sql.
-- Nothing here enables payments: 'billing_live' ships OFF, and quotas that Qorlla has not approved are stored but NOT enforced.
BEGIN;

-- 1. Provisional quotas. A quota is enforced only when quota_approved is true; a new row defaults to NOT approved, so illustrative numbers can never go live by accident.
--    Quotas that were already enforced before SBACS (notes, members, the AI ledger, Meet limits) are marked approved: their behaviour does not change.
ALTER TABLE portal.entitlements ADD COLUMN IF NOT EXISTS quota_approved boolean NOT NULL DEFAULT false;
UPDATE portal.entitlements SET quota_approved = true
 WHERE feature IN ('notes.max','members.max','meet.max_minutes','meet.max_participants') OR feature ~ '^ai\.[a-z_]+_per_month$';

-- 2. Version history is split (Free keeps basic history; restore / compare / retention / advanced recovery are paid).
--    docs.history.read quota = how many recent revisions are listed (Free "limited"): provisional, so not enforced until approved.
INSERT INTO portal.entitlements(plan_slug, feature, quota, description, enabled) VALUES
  ('basic','docs.history.read',10,'View version history (recent revisions)',true), ('starter','docs.history.read',50,'View version history (recent revisions)',true),
  ('pro','docs.history.read',NULL,'View version history (recent revisions)',true), ('business','docs.history.read',NULL,'View version history (recent revisions)',true), ('enterprise','docs.history.read',NULL,'View version history (recent revisions)',true),
  ('basic','docs.history.restore',NULL,'Restore previous versions',false), ('starter','docs.history.restore',20,'Restore previous versions',true),
  ('pro','docs.history.restore',NULL,'Restore previous versions',true), ('business','docs.history.restore',NULL,'Restore previous versions',true), ('enterprise','docs.history.restore',NULL,'Restore previous versions',true),
  ('basic','docs.history.compare',NULL,'Compare versions',false), ('starter','docs.history.compare',20,'Compare versions',true),
  ('pro','docs.history.compare',NULL,'Compare versions',true), ('business','docs.history.compare',NULL,'Compare versions',true), ('enterprise','docs.history.compare',NULL,'Compare versions',true),
  ('basic','docs.history.retention',NULL,'Extended version retention',false), ('starter','docs.history.retention',NULL,'Extended version retention',true),
  ('pro','docs.history.retention',NULL,'Extended version retention',true), ('business','docs.history.retention',NULL,'Extended version retention',true), ('enterprise','docs.history.retention',NULL,'Extended version retention',true),
  ('basic','docs.recovery.advanced',NULL,'Advanced audit and recovery',false), ('starter','docs.recovery.advanced',NULL,'Advanced audit and recovery',false),
  ('pro','docs.recovery.advanced',NULL,'Advanced audit and recovery',true), ('business','docs.recovery.advanced',NULL,'Advanced audit and recovery',true), ('enterprise','docs.recovery.advanced',NULL,'Advanced audit and recovery',true)
ON CONFLICT (plan_slug, feature) DO NOTHING;

-- 3. 'billing_live' flag: every checkout / plan change / resume / payment-method action needs it, and it ships OFF.
ALTER TABLE portal.platform_flags DROP CONSTRAINT IF EXISTS platform_flags_key_check;
ALTER TABLE portal.platform_flags ADD CONSTRAINT platform_flags_key_check CHECK (key IN ('checkout','plan_changes','ai','overage_billing','meet_ai','billing_live'));
INSERT INTO portal.platform_flags(key, enabled, reason) VALUES ('billing_live', false, 'Live billing is off until Qorlla authorises payments') ON CONFLICT (key) DO NOTHING;

-- 4. Every change to a subscription's plan, status, cancellation flag or period is recorded in the append-only entitlement_events log by the DATABASE,
--    so it cannot be missed by an application code path (or by a manual repair run in psql).
CREATE OR REPLACE FUNCTION portal.subscription_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR (OLD.plan_slug, OLD.status, OLD.cancel_at_period_end, OLD.current_period_end, OLD.provider_subscription_id)
       IS DISTINCT FROM (NEW.plan_slug, NEW.status, NEW.cancel_at_period_end, NEW.current_period_end, NEW.provider_subscription_id) THEN
    INSERT INTO portal.entitlement_events(workspace_id, kind, detail) VALUES (NEW.workspace_id, 'subscription.' || lower(TG_OP), jsonb_build_object(
      'from', CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_object('plan', OLD.plan_slug, 'status', OLD.status, 'cancel_at_period_end', OLD.cancel_at_period_end, 'period_end', OLD.current_period_end) END,
      'to', jsonb_build_object('plan', NEW.plan_slug, 'status', NEW.status, 'cancel_at_period_end', NEW.cancel_at_period_end, 'period_end', NEW.current_period_end),
      'provider_subscription_id', NEW.provider_subscription_id));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS subscription_audit ON portal.subscriptions;
CREATE TRIGGER subscription_audit AFTER INSERT OR UPDATE ON portal.subscriptions FOR EACH ROW EXECUTE FUNCTION portal.subscription_audit();

-- 5. Provider events are evidence: the payload and identity of a received event can never change and no event can be deleted (outcome / processed_at may be set once handled).
CREATE OR REPLACE FUNCTION portal.billing_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN RAISE EXCEPTION 'billing_events is append-only'; END IF;
  IF (OLD.provider, OLD.event_id, OLD.type, OLD.payload, OLD.provider_created_at) IS DISTINCT FROM (NEW.provider, NEW.event_id, NEW.type, NEW.payload, NEW.provider_created_at) THEN
    RAISE EXCEPTION 'billing_events is append-only';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS billing_events_guard ON portal.billing_events;
CREATE TRIGGER billing_events_guard BEFORE UPDATE OR DELETE ON portal.billing_events FOR EACH ROW EXECUTE FUNCTION portal.billing_events_guard();
DROP TRIGGER IF EXISTS billing_events_guard_truncate ON portal.billing_events;
CREATE TRIGGER billing_events_guard_truncate BEFORE TRUNCATE ON portal.billing_events FOR EACH STATEMENT EXECUTE FUNCTION portal.billing_events_guard();
COMMIT;
