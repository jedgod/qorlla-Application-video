-- Qorlla Docs extension: folders, personal stars, templates and comments for the existing portal.documents.
-- ADDITIVE ONLY. Re-runnable. Reverse with sql/rollback/015_docs_extension.down.sql (drops folders, stars, templates and comments: back up first).
-- Needs 006_workspace_tools.sql (portal.documents). It never alters portal.documents, so every existing document, version and permission is untouched.
-- Adapted from the qorlla-docs-integration handoff: that package assumed a "portal.workspace_members" table, its own audit table and a block-based content
-- format; this schema uses the live portal.members, the live portal.audit_events and leaves the markdown content format alone.
-- The portal's database role cannot DELETE (003_roles.sh), so nothing here is ever hard-deleted by the application: folders and comments are
-- soft-deleted/resolved and stars are a flag.
BEGIN;
CREATE TABLE IF NOT EXISTS portal.doc_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  owner_id uuid NOT NULL,                                   -- folders are private to their owner: sharing a document never shares its folder
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (id, workspace_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS doc_folders_name_uq ON portal.doc_folders(workspace_id, owner_id, lower(btrim(name))) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS portal.doc_metadata (
  document_id uuid PRIMARY KEY REFERENCES portal.documents(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  folder_id uuid,
  template boolean NOT NULL DEFAULT false,
  FOREIGN KEY (folder_id, workspace_id) REFERENCES portal.doc_folders(id, workspace_id)
);
CREATE INDEX IF NOT EXISTS doc_metadata_folder_idx ON portal.doc_metadata(folder_id) WHERE folder_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS portal.doc_stars (               -- a star is personal: it is only ever read back for the person who set it
  document_id uuid NOT NULL REFERENCES portal.documents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  starred boolean NOT NULL DEFAULT true,
  PRIMARY KEY (document_id, user_id)
);

CREATE TABLE IF NOT EXISTS portal.doc_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES portal.documents(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  author_id uuid NOT NULL,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz, resolved_by uuid
);
CREATE INDEX IF NOT EXISTS doc_comments_doc_idx ON portal.doc_comments(document_id, created_at);

-- Comments are a plan feature enforced by the server (portal.entitlements: a plan with no row is not granted). Seeded for EVERY plan, so nothing changes today;
-- a tier rule that is formally approved later is a data change (delete the row for that plan), not a code change.
INSERT INTO portal.entitlements(plan_slug, feature, quota, description) VALUES
  ('basic','documents.comments',NULL,'Document comments'), ('pro','documents.comments',NULL,'Document comments'),
  ('business','documents.comments',NULL,'Document comments'), ('enterprise','documents.comments',NULL,'Document comments')
ON CONFLICT (plan_slug, feature) DO NOTHING;
COMMIT;
