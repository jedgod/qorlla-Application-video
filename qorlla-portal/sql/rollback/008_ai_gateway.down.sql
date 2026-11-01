-- Reverses sql/008_ai_gateway.sql. DESTROYS the per-workspace AI authorisations and the AI gateway audit trail. Back up first.
BEGIN;
DROP TABLE IF EXISTS portal.ai_gateway_audit;
DROP FUNCTION IF EXISTS portal.ai_gateway_audit_immutable();
DROP TABLE IF EXISTS portal.workspace_ai_settings;
COMMIT;
