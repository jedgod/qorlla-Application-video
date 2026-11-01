-- Qorlla Workplace - Qorlla AI Gateway. Reverse with sql/rollback/008_ai_gateway.down.sql.
-- Content leaves the platform for an external AI provider only for a workspace that authorised it (default: NOT authorised).
-- The audit trail records who/what/which provider/how much, with a short hash; it never stores a prompt or an answer, and it cannot be edited or deleted.
BEGIN;

CREATE TABLE IF NOT EXISTS portal.workspace_ai_settings (
  workspace_id uuid PRIMARY KEY REFERENCES portal.workspaces(id),
  external_processing boolean NOT NULL DEFAULT false,
  updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portal.ai_gateway_audit (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  feature text NOT NULL, actor_id text, workspace_id text, org_id text,
  provider text, tier text CHECK (tier IS NULL OR tier IN ('local','free','paid')), model text,
  outcome text NOT NULL, code text, ms integer NOT NULL DEFAULT 0,
  input_chars integer NOT NULL DEFAULT 0, output_chars integer NOT NULL DEFAULT 0, input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0,
  prompt_hash text
);
CREATE INDEX IF NOT EXISTS ai_gateway_audit_ws ON portal.ai_gateway_audit(workspace_id, at DESC);

CREATE OR REPLACE FUNCTION portal.ai_gateway_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'portal.ai_gateway_audit is append-only'; END $$;
DROP TRIGGER IF EXISTS ai_gateway_audit_no_change ON portal.ai_gateway_audit;
CREATE TRIGGER ai_gateway_audit_no_change BEFORE UPDATE OR DELETE ON portal.ai_gateway_audit FOR EACH ROW EXECUTE FUNCTION portal.ai_gateway_audit_immutable();

COMMIT;
