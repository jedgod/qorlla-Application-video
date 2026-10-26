-- Qorlla Workplace v4.4 - QorllaMate, Notes and Productivity. Reverse with sql/rollback/006_workspace_tools.down.sql (drops assistant history, notebooks and documents: back up first).
BEGIN;

-- ---- notes: private by default for new notes; notes that existed before this release keep their old workspace-wide visibility ----
ALTER TABLE portal.notes ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'workspace';
ALTER TABLE portal.notes DROP CONSTRAINT IF EXISTS notes_visibility_check;
ALTER TABLE portal.notes ADD CONSTRAINT notes_visibility_check CHECK (visibility IN ('private','workspace'));
ALTER TABLE portal.notes ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
ALTER TABLE portal.notes ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE portal.notes DROP CONSTRAINT IF EXISTS notes_source_check;
ALTER TABLE portal.notes ADD CONSTRAINT notes_source_check CHECK (source IN ('manual','assistant'));
ALTER TABLE portal.notes ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE portal.notes ADD COLUMN IF NOT EXISTS notebook_id uuid;
ALTER TABLE portal.notes ADD COLUMN IF NOT EXISTS search tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce(title,'') || ' ' || coalesce(body,''))) STORED;
CREATE INDEX IF NOT EXISTS notes_search_idx ON portal.notes USING gin(search);
CREATE INDEX IF NOT EXISTS notes_ws_idx ON portal.notes(workspace_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS portal.notebooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  owner_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, owner_id, name)
);
ALTER TABLE portal.notes DROP CONSTRAINT IF EXISTS notes_notebook_fk;
ALTER TABLE portal.notes ADD CONSTRAINT notes_notebook_fk FOREIGN KEY (notebook_id) REFERENCES portal.notebooks(id) ON DELETE SET NULL;

-- ---- documents (doc / sheet / slides) with immutable versions and explicit permissions ----
CREATE TABLE IF NOT EXISTS portal.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  owner_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('doc','sheet','slides')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  current_version integer NOT NULL DEFAULT 0,
  general_access text NOT NULL DEFAULT 'restricted' CHECK (general_access IN ('restricted','workspace_view','workspace_edit')),
  search_text text NOT NULL DEFAULT '',
  creation_key text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  search tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, title || ' ' || search_text)) STORED,
  UNIQUE (workspace_id, creation_key)
);
CREATE INDEX IF NOT EXISTS documents_ws_idx ON portal.documents(workspace_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS documents_search_idx ON portal.documents USING gin(search);
CREATE TABLE IF NOT EXISTS portal.document_versions (
  document_id uuid NOT NULL REFERENCES portal.documents(id) ON DELETE CASCADE,
  version_no integer NOT NULL CHECK (version_no >= 1),
  content jsonb NOT NULL,
  source text NOT NULL DEFAULT 'user' CHECK (source IN ('user','ai','restore')),
  note text CHECK (length(note) <= 200),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, version_no)
);
CREATE TABLE IF NOT EXISTS portal.document_permissions (
  document_id uuid NOT NULL REFERENCES portal.documents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('viewer','editor')),
  granted_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, user_id)
);

-- ---- QorllaMate: private threads; every consequential step is a task a human approves ----
CREATE TABLE IF NOT EXISTS portal.assistant_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  user_id uuid NOT NULL,
  title text NOT NULL DEFAULT 'New conversation' CHECK (length(title) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS assistant_threads_idx ON portal.assistant_threads(workspace_id, user_id, updated_at DESC) WHERE archived_at IS NULL;
CREATE TABLE IF NOT EXISTS portal.assistant_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES portal.assistant_threads(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 20000),
  model text, input_tokens integer, output_tokens integer,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (thread_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS portal.assistant_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  thread_id uuid NOT NULL REFERENCES portal.assistant_threads(id) ON DELETE CASCADE,
  message_id uuid REFERENCES portal.assistant_messages(id) ON DELETE SET NULL,
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('create_note','create_document','send_email')),
  external boolean NOT NULL DEFAULT false,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','executed','rejected','failed','blocked')),
  result jsonb, error_code text,
  proposed_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz, executed_at timestamptz
);
CREATE INDEX IF NOT EXISTS assistant_tasks_idx ON portal.assistant_tasks(workspace_id, user_id, proposed_at DESC);

-- ---- usage ledger and plan entitlements ----
ALTER TABLE portal.ai_usage_events DROP CONSTRAINT IF EXISTS ai_usage_events_feature_check;
ALTER TABLE portal.ai_usage_events ADD CONSTRAINT ai_usage_events_feature_check CHECK (feature IN ('meeting_report','llm_input_tokens','llm_output_tokens','call_summary','phone_minutes','assistant_message','doc_generation'));
INSERT INTO portal.entitlements(plan_slug, feature, quota, description) VALUES
  ('basic','ai.assistant_messages_per_month',20,'QorllaMate messages per month'), ('pro','ai.assistant_messages_per_month',500,'QorllaMate messages per month'),
  ('business','ai.assistant_messages_per_month',5000,'QorllaMate messages per month'), ('enterprise','ai.assistant_messages_per_month',NULL,'QorllaMate messages per month'),
  ('basic','ai.doc_generations_per_month',3,'AI document drafts per month'), ('pro','ai.doc_generations_per_month',200,'AI document drafts per month'),
  ('business','ai.doc_generations_per_month',2000,'AI document drafts per month'), ('enterprise','ai.doc_generations_per_month',NULL,'AI document drafts per month'),
  ('basic','documents.max',5,'Documents per workspace'), ('pro','documents.max',500,'Documents per workspace'),
  ('business','documents.max',5000,'Documents per workspace'), ('enterprise','documents.max',NULL,'Documents per workspace')
ON CONFLICT (plan_slug, feature) DO NOTHING;
COMMIT;
