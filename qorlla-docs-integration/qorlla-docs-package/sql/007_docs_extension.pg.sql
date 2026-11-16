-- Run ONLY after confirming 006_workspace_tools.sql is the active schema.
-- Never run alongside the incompatible 001_init_workspace_schema.sql without migration reconciliation.
BEGIN;
CREATE TABLE IF NOT EXISTS portal.doc_folders (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, owner_id uuid NOT NULL,
 name varchar(200) NOT NULL, parent_id uuid REFERENCES portal.doc_folders(id),
 created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 UNIQUE(id,workspace_id)
);
CREATE TABLE IF NOT EXISTS portal.doc_metadata (
 document_id uuid PRIMARY KEY REFERENCES portal.documents(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL, folder_id uuid, starred_by jsonb NOT NULL DEFAULT '[]'::jsonb,
 template boolean NOT NULL DEFAULT false,
 FOREIGN KEY(folder_id,workspace_id) REFERENCES portal.doc_folders(id,workspace_id)
);
CREATE TABLE IF NOT EXISTS portal.doc_comments (
 id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES portal.documents(id) ON DELETE CASCADE,
 author_id uuid NOT NULL, body text NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
 created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
CREATE TABLE IF NOT EXISTS portal.doc_audit (
 id bigserial PRIMARY KEY, workspace_id uuid NOT NULL, document_id uuid,
 actor_id uuid NOT NULL, action text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS doc_audit_ws_idx ON portal.doc_audit(workspace_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS doc_comments_doc_idx ON portal.doc_comments(document_id,created_at);
CREATE INDEX IF NOT EXISTS doc_folders_ws_idx ON portal.doc_folders(workspace_id,owner_id);
COMMIT;
