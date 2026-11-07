-- Explicit accounting ownership; this table does not grant telephone access.
BEGIN;
CREATE TABLE portal.a412_workspace_meetings (
  meeting_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  status text NOT NULL CHECK (status IN ('active', 'suspended', 'revoked')),
  provisioned_by text NOT NULL CHECK (length(provisioned_by) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, workspace_id)
);
CREATE TABLE portal.a412_binding_requests (
  principal text NOT NULL CHECK (length(principal) BETWEEN 1 AND 200),
  request_id uuid NOT NULL,
  payload_sha256 char(64) NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal, request_id)
);
CREATE TABLE portal.a412_binding_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meeting_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  principal text NOT NULL,
  request_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('bind', 'suspend', 'resume', 'revoke')),
  changed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (meeting_id, workspace_id) REFERENCES portal.a412_workspace_meetings(meeting_id, workspace_id),
  UNIQUE (principal, request_id)
);
CREATE FUNCTION portal.a412_binding_ownership_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.meeting_id IS DISTINCT FROM OLD.meeting_id OR
     NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
     NEW.provisioned_by IS DISTINCT FROM OLD.provisioned_by OR
     NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'workspace meeting ownership is immutable';
  END IF;
  IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN
    RAISE EXCEPTION 'revoked workspace meeting binding cannot be restored';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a412_binding_ownership_guard BEFORE UPDATE OR DELETE ON portal.a412_workspace_meetings
  FOR EACH ROW EXECUTE FUNCTION portal.a412_binding_ownership_guard();
CREATE FUNCTION portal.a412_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'binding request and audit records are immutable'; END $$;
CREATE TRIGGER a412_binding_request_immutable BEFORE UPDATE OR DELETE ON portal.a412_binding_requests
  FOR EACH ROW EXECUTE FUNCTION portal.a412_binding_immutable();
CREATE TRIGGER a412_binding_audit_immutable BEFORE UPDATE OR DELETE ON portal.a412_binding_audit
  FOR EACH ROW EXECUTE FUNCTION portal.a412_binding_immutable();
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qorlla_portal_app') THEN
    REVOKE INSERT, UPDATE, DELETE ON portal.a412_workspace_meetings, portal.a412_binding_requests,
      portal.a412_binding_audit FROM qorlla_portal_app;
  END IF;
END $$;
COMMIT;
