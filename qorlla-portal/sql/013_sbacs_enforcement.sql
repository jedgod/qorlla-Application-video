-- Qorlla SBACS Phase 2: database-level guarantees and the feature keys the enforcement points use. Reverse with sql/rollback/013_sbacs_enforcement.down.sql.
-- Quotas remain ILLUSTRATIVE and unapproved. Nothing here sets a price or enables payments.
BEGIN;

-- 1. capabilities that payment, plans and overrides must never unlock are refused by the DATABASE too (NOT VALID: new and changed rows are checked)
ALTER TABLE portal.entitlement_overrides DROP CONSTRAINT IF EXISTS overrides_not_hard_denied;
ALTER TABLE portal.entitlement_overrides ADD CONSTRAINT overrides_not_hard_denied CHECK (feature NOT IN ('phone.pstn','ai.private.external')) NOT VALID;
ALTER TABLE portal.entitlements DROP CONSTRAINT IF EXISTS entitlements_not_hard_denied;
ALTER TABLE portal.entitlements ADD CONSTRAINT entitlements_not_hard_denied CHECK (NOT enabled OR feature NOT IN ('phone.pstn','ai.private.external')) NOT VALID;

-- 2. a reservation whose caller never settled it is "expired" (distinct from "released"): the work may still have happened, so a late finalize is recorded
ALTER TABLE portal.usage_reservations DROP CONSTRAINT IF EXISTS usage_reservations_status_check;
ALTER TABLE portal.usage_reservations ADD CONSTRAINT usage_reservations_status_check CHECK (status IN ('reserved','finalized','released','expired'));

-- 3. feature keys used by the enforcement points. Sheets/Slides follow the shared "Docs, Sheets, Slides" row; AI keys are GATES only:
--    the allowance itself stays in the AI Gateway ledger (ai.*_per_month), so there is one counter, never two that can disagree.
INSERT INTO portal.entitlements(plan_slug, feature, quota, description, enabled)
SELECT plan_slug, 'sheets.create', quota, 'Sheets: create', enabled FROM portal.entitlements WHERE feature = 'docs.create' ON CONFLICT (plan_slug, feature) DO NOTHING;
INSERT INTO portal.entitlements(plan_slug, feature, quota, description, enabled)
SELECT plan_slug, 'slides.create', quota, 'Slides: create', enabled FROM portal.entitlements WHERE feature = 'docs.create' ON CONFLICT (plan_slug, feature) DO NOTHING;
UPDATE portal.entitlements SET quota = NULL, description = 'Qorlla AI drafting in Docs (allowance: AI Gateway ledger)' WHERE feature = 'ai.docs.draft';
INSERT INTO portal.entitlements(plan_slug, feature, quota, description, enabled)
SELECT e.plan_slug, k.feature, NULL, k.description, e.enabled FROM portal.entitlements e, (VALUES
  ('ai.sheets.analyze', 'Qorlla AI analysis in Sheets (allowance: AI Gateway ledger)'),
  ('ai.slides.generate', 'Qorlla AI slide generation (allowance: AI Gateway ledger)'),
  ('ai.assistant.message', 'QorllaMate messages (allowance: AI Gateway ledger)'),
  ('ai.meeting.report', 'Meeting reports from Meet transcripts (allowance: AI Gateway ledger)')) AS k(feature, description)
WHERE e.feature = 'ai.docs.draft' ON CONFLICT (plan_slug, feature) DO NOTHING;
-- storage in MiB (the quota column is an integer): Free 1 GiB ... Professional 100 GiB ... Enterprise unlimited
INSERT INTO portal.entitlements(plan_slug, feature, quota, description, enabled) VALUES
  ('basic','storage.mb',1024,'Cloud storage (MiB)',true), ('starter','storage.mb',10240,'Cloud storage (MiB)',true), ('pro','storage.mb',102400,'Cloud storage (MiB)',true),
  ('business','storage.mb',1048576,'Cloud storage (MiB)',true), ('enterprise','storage.mb',NULL,'Cloud storage (MiB)',true) ON CONFLICT (plan_slug, feature) DO NOTHING;

-- 4. privileges: nothing in these tables is readable or writable by PUBLIC; the application role may add events but never change or remove them
REVOKE ALL ON portal.entitlement_overrides, portal.entitlement_events, portal.subscription_usage, portal.usage_reservations FROM PUBLIC;
REVOKE ALL ON SEQUENCE portal.entitlement_events_id_seq FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qorlla_portal_app') THEN
    GRANT SELECT, INSERT ON portal.entitlement_events TO qorlla_portal_app;
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON portal.entitlement_events FROM qorlla_portal_app;
    REVOKE DELETE, TRUNCATE ON portal.subscription_usage, portal.usage_reservations FROM qorlla_portal_app;
    REVOKE TRUNCATE ON portal.entitlement_overrides FROM qorlla_portal_app;
    GRANT USAGE, SELECT ON SEQUENCE portal.entitlement_events_id_seq TO qorlla_portal_app;
  END IF;
END $$;
COMMIT;
