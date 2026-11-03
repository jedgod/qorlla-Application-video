-- Reverses sql/013_sbacs_enforcement.sql. Keeps every usage, reservation and event row. The 'expired' reservation status stays allowed so history is not rewritten.
BEGIN;
ALTER TABLE portal.entitlement_overrides DROP CONSTRAINT IF EXISTS overrides_not_hard_denied;
ALTER TABLE portal.entitlements DROP CONSTRAINT IF EXISTS entitlements_not_hard_denied;
DELETE FROM portal.entitlements WHERE feature IN ('sheets.create','slides.create','ai.sheets.analyze','ai.slides.generate','ai.assistant.message','ai.meeting.report','storage.mb');
UPDATE portal.entitlements SET description = 'Qorlla AI drafting in Docs',
  quota = CASE plan_slug WHEN 'basic' THEN 20 WHEN 'starter' THEN 200 WHEN 'pro' THEN 1000 WHEN 'business' THEN 5000 ELSE NULL END WHERE feature = 'ai.docs.draft';
COMMIT;
