-- Apply after 001_portal.sql. Additive; no changes to Meet recovery tables.
CREATE TABLE IF NOT EXISTS portal.meeting_ai_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
 external_meeting_id text NOT NULL, requested_by uuid NOT NULL, job_type text NOT NULL CHECK(job_type IN ('transcript','summary','translation')),
 consent_reference text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
 idempotency_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,idempotency_key));
CREATE TABLE IF NOT EXISTS portal.meeting_action_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
 report_id uuid NOT NULL REFERENCES portal.meeting_reports(id), title text NOT NULL, owner_id uuid,
 due_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS portal.meeting_transcripts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
 external_meeting_id text NOT NULL, transcript_text text NOT NULL, source_job_id uuid REFERENCES portal.meeting_ai_jobs(id),
 created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS portal.receptionist_profiles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
 name text NOT NULL, greeting text NOT NULL, timezone text NOT NULL DEFAULT 'UTC',
 enabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS portal.call_routes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
 profile_id uuid NOT NULL REFERENCES portal.receptionist_profiles(id), label text NOT NULL,
 destination text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS portal.call_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
 provider_ref text UNIQUE, direction text NOT NULL CHECK(direction IN ('inbound','outbound')),
 state text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS portal.appointments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
 title text NOT NULL, start_at timestamptz NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS portal.assistant_threads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
 created_by uuid NOT NULL, title text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS portal.assistant_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
 thread_id uuid NOT NULL REFERENCES portal.assistant_threads(id), role text NOT NULL CHECK(role IN ('user','assistant')),
 content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS portal.assistant_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
 created_by uuid NOT NULL, title text NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
 created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS portal.documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
 created_by uuid NOT NULL, title text NOT NULL, kind text NOT NULL CHECK(kind IN ('doc','sheet','slide')),
 created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS portal.document_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
 document_id uuid NOT NULL REFERENCES portal.documents(id), revision integer NOT NULL, content jsonb NOT NULL,
 author_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(document_id,revision));
CREATE TABLE IF NOT EXISTS portal.billing_customers (
 workspace_id uuid PRIMARY KEY REFERENCES portal.workspaces(id), provider text NOT NULL,
 provider_customer_id text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS portal.billing_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL, provider_event_id text NOT NULL,
 event_type text NOT NULL, payload jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider,provider_event_id));
CREATE TABLE IF NOT EXISTS portal.billing_invoices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
 provider_invoice_id text UNIQUE, currency text NOT NULL DEFAULT 'USD', total_cents integer NOT NULL CHECK(total_cents>=0),
 status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS portal.plan_prices (
 plan_slug text NOT NULL REFERENCES portal.plans(slug), interval text NOT NULL CHECK(interval IN ('month','year')),
 amount_cents integer NOT NULL CHECK(amount_cents>=0), currency text NOT NULL DEFAULT 'USD',
 active boolean NOT NULL DEFAULT true, PRIMARY KEY(plan_slug,interval,currency));
INSERT INTO portal.plan_prices(plan_slug,interval,amount_cents)
 SELECT slug,'month',monthly_cents FROM portal.plans WHERE monthly_cents IS NOT NULL ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS idx_ai_jobs_workspace ON portal.meeting_ai_jobs(workspace_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_workspace ON portal.documents(workspace_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON portal.assistant_tasks(workspace_id,created_at DESC);
