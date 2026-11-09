-- Qorlla Docs: version-history access window, as a plan entitlement (documents.history_versions).
-- ADDITIVE ONLY. Re-runnable. Reverse with sql/rollback/016_docs_history_entitlement.down.sql (removes only these four entitlement rows).
-- Needs 001/002 (portal.entitlements). It never touches portal.documents or portal.document_versions: every stored version stays stored.
--
-- Meaning of the quota (enforced by the server, see historyWindow() in server/docs-extension.mjs):
--   quota N     = the N most recent versions of a document, counted back from its LATEST version and including it.
--                 A document with 30 versions on a plan with N=10 may open and restore versions 21-30.
--   quota NULL  = unlimited (the same convention as every other entitlement).
--   no row      = NOT granted: the server then allows only the current version (fail closed, never "unlimited").
-- Older versions are kept and listed as locked; the window is recomputed on every request from the workspace's CURRENT plan,
-- so an upgrade unlocks them at once and a downgrade locks them again without deleting anything.
BEGIN;
INSERT INTO portal.entitlements(plan_slug, feature, quota, description) VALUES
  ('basic',      'documents.history_versions', 10,   'Document version history: most recent versions you can open or restore'),
  ('pro',        'documents.history_versions', 100,  'Document version history: most recent versions you can open or restore'),
  ('business',   'documents.history_versions', 500,  'Document version history: most recent versions you can open or restore'),
  ('enterprise', 'documents.history_versions', NULL, 'Document version history: most recent versions you can open or restore')
ON CONFLICT (plan_slug, feature) DO NOTHING;
COMMIT;
