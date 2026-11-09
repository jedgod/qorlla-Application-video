-- Reverses 016_docs_history_entitlement.sql. Removes only the documents.history_versions entitlement rows; no document or version is touched.
-- NOTE: the server fails closed when the row is missing (only the CURRENT version of a document can then be opened), so roll the code back first or together.
BEGIN;
DELETE FROM portal.entitlements WHERE feature='documents.history_versions';
COMMIT;
