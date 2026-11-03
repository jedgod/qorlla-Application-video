-- Reverses sql/012_sbacs.sql WITHOUT discarding subscription history or usage records.
--  * refuses to run while any subscription is on the Starter plan or 'suspended', or any workspace is suspended: rewriting those rows would erase history
--    or silently lift a suspension. Resolve them first.
--  * the usage, reservation, override and event tables are RENAMED to *_archived_<yyyymmdd> (the event table stays append-only), never dropped.
-- Run 013's rollback first if 013 was applied (this script also removes 013's constraints, which depend on the columns dropped here).
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM portal.subscriptions WHERE plan_slug = 'starter' OR status = 'suspended') THEN
    RAISE EXCEPTION 'Rollback refused: subscriptions on the Starter plan or in the suspended state exist; moving them would rewrite billing history. Resolve them first.';
  END IF;
  IF EXISTS (SELECT 1 FROM portal.workspaces WHERE suspended_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Rollback refused: suspended workspaces exist; dropping the suspension columns would silently lift the suspension. Lift or record them first.';
  END IF;
END $$;
ALTER TABLE portal.entitlements DROP CONSTRAINT IF EXISTS entitlements_not_hard_denied;
DROP TRIGGER IF EXISTS subscription_audit ON portal.subscriptions;      -- 014's trigger writes to the event table renamed below
DROP FUNCTION IF EXISTS portal.subscription_audit();
CREATE OR REPLACE VIEW portal.workspace_effective_plan AS
SELECT w.id AS workspace_id,
       CASE
         WHEN s.plan_slug IS NOT NULL AND s.plan_slug <> 'basic' AND (
              (s.status IN ('active','trialing') AND (s.current_period_end IS NULL OR s.current_period_end > now() - interval '2 days'))
           OR (s.status = 'past_due' AND s.current_period_end IS NOT NULL AND s.current_period_end > now() - interval '7 days'))
         THEN s.plan_slug ELSE 'basic'
       END AS plan_slug
FROM portal.workspaces w LEFT JOIN portal.subscriptions s ON s.workspace_id = w.id;
DO $$ DECLARE sfx text := to_char(now(), 'YYYYMMDD'); t text; BEGIN
  FOREACH t IN ARRAY ARRAY['usage_reservations','subscription_usage','entitlement_overrides','entitlement_events'] LOOP
    IF to_regclass('portal.' || t) IS NOT NULL THEN EXECUTE format('ALTER TABLE portal.%I RENAME TO %I', t, t || '_archived_' || sfx); END IF;
  END LOOP;
END $$;
DELETE FROM portal.entitlements WHERE NOT enabled;       -- a row means "granted" once the enabled column is gone, so "not granted" rows must go with it
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
