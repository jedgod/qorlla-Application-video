-- Qorlla Portal Chat: workspace chat (channels, groups, direct messages) in PostgreSQL, schema `portal`.
-- ADDITIVE ONLY. Re-runnable. Reverse with sql/rollback/017_portal_chat.down.sql. It never touches an existing table: the main-app JSON chat (/api/workplace/chat), Meet's
-- in-meeting chat and every portal table keep working unchanged.
-- Needs 001 (workspaces, members) and 002 (entitlements). The workspace is the tenant: every row carries workspace_id and every server query filters by it.
--
-- Visibility model (enforced by the server, see server/chat.mjs):
--   channel, is_private=false : any workspace member may read and post (they "join" lazily when they first read; membership rows only track unread state)
--   channel, is_private=true  : explicit members only
--   group / direct            : explicit members only (direct = exactly two people, unique per pair via direct_key)
-- A person who is no longer a workspace member (portal.members row gone) loses access to everything here at once: the server resolves the workspace from portal.members on every request.
--
-- Sequence numbers: chat_conversations.last_seq is incremented under the conversation row lock for EVERY change (message, edit, delete, pin, unpin). chat_messages.seq is the seq of the
-- message's creation; chat_events keeps one row per change (no message text) so a reconnecting client can catch up with ?after=<seq> or Last-Event-ID.
-- The portal application role (003_roles.sh) gets SELECT/INSERT/UPDATE on these tables by default privileges. DELETE is granted below on exactly three of them
-- (bookmarks, pins, members: removing a bookmark, unpinning, leaving); a deleted MESSAGE is a soft delete that blanks the text and every stored version of it.
BEGIN;

CREATE TABLE IF NOT EXISTS portal.chat_conversations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  kind         text NOT NULL CHECK (kind IN ('channel','group','direct')),
  name         text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 80),
  topic        text CHECK (topic IS NULL OR char_length(topic) <= 250),
  is_private   boolean NOT NULL DEFAULT false,
  post_policy  text NOT NULL DEFAULT 'members' CHECK (post_policy IN ('members','admins')),
  direct_key   text,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  last_seq     bigint NOT NULL DEFAULT 0,
  CONSTRAINT chat_conv_direct_shape CHECK ((kind = 'direct' AND direct_key IS NOT NULL AND is_private) OR (kind <> 'direct' AND direct_key IS NULL)),
  CONSTRAINT chat_conv_only_channels_public CHECK (kind = 'channel' OR is_private)
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_conv_direct_uq ON portal.chat_conversations (workspace_id, direct_key) WHERE direct_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chat_conv_channel_name_uq ON portal.chat_conversations (workspace_id, lower(name)) WHERE kind = 'channel' AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS chat_conv_workspace ON portal.chat_conversations (workspace_id, created_at);

CREATE TABLE IF NOT EXISTS portal.chat_members (
  conversation_id uuid NOT NULL REFERENCES portal.chat_conversations(id),
  workspace_id    uuid NOT NULL REFERENCES portal.workspaces(id),
  user_id         uuid NOT NULL,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  last_read_seq   bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS chat_members_user ON portal.chat_members (workspace_id, user_id);

CREATE TABLE IF NOT EXISTS portal.chat_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES portal.chat_conversations(id),
  workspace_id    uuid NOT NULL REFERENCES portal.workspaces(id),
  seq             bigint NOT NULL,
  author_id       uuid NOT NULL,
  kind            text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','ai','system','gif')),   -- gif: body = a GIPHY https URL, only when the server has GIFs enabled
  body            text NOT NULL CHECK (char_length(body) <= 4000),          -- PLAIN text: search, export, AI context
  body_rich       text CHECK (body_rich IS NULL OR char_length(body_rich) <= 8000),   -- canonical sanitized markup (server/chat/markup.mjs); NULL for plain messages
  reply_to        uuid REFERENCES portal.chat_messages(id),
  client_key      text,
  edit_count      integer NOT NULL DEFAULT 0,
  edited_at       timestamptz,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_idem ON portal.chat_messages (conversation_id, author_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS chat_messages_conv_seq ON portal.chat_messages (conversation_id, seq DESC);

CREATE TABLE IF NOT EXISTS portal.chat_message_versions (
  message_id uuid NOT NULL REFERENCES portal.chat_messages(id),
  version    integer NOT NULL,
  body       text NOT NULL,
  body_rich  text,
  edited_by  uuid NOT NULL,
  edited_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, version)
);

-- one row per change, no message text: the replay log for ?after=<seq> and SSE Last-Event-ID
CREATE TABLE IF NOT EXISTS portal.chat_events (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES portal.chat_conversations(id),
  workspace_id    uuid NOT NULL REFERENCES portal.workspaces(id),
  seq             bigint NOT NULL,
  type            text NOT NULL CHECK (type IN ('message','edit','delete','pin','unpin')),
  message_id      uuid REFERENCES portal.chat_messages(id),
  actor_id        uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS chat_events_ws ON portal.chat_events (workspace_id, id);

CREATE TABLE IF NOT EXISTS portal.chat_pins (
  message_id      uuid PRIMARY KEY REFERENCES portal.chat_messages(id),
  conversation_id uuid NOT NULL REFERENCES portal.chat_conversations(id),
  workspace_id    uuid NOT NULL REFERENCES portal.workspaces(id),
  pinned_by       uuid NOT NULL,
  pinned_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_pins_conv ON portal.chat_pins (conversation_id);

CREATE TABLE IF NOT EXISTS portal.chat_bookmarks (
  user_id      uuid NOT NULL,
  message_id   uuid NOT NULL REFERENCES portal.chat_messages(id),
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, message_id)
);

CREATE TABLE IF NOT EXISTS portal.chat_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES portal.workspaces(id),
  conversation_id uuid NOT NULL REFERENCES portal.chat_conversations(id),
  message_id      uuid NOT NULL REFERENCES portal.chat_messages(id),
  title           text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 250),
  assignee_id     uuid,
  due_date        date,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  done_at         timestamptz
);
CREATE INDEX IF NOT EXISTS chat_tasks_ws ON portal.chat_tasks (workspace_id, status, created_at);

-- QorllaMate questions: the reservation is the quota unit (see consumeQuota in server/entitlements.mjs). status 'failed' (the model call did not complete) is NOT counted.
-- The question and the answer are NOT stored here: only who asked, where, when and whether it completed.
CREATE TABLE IF NOT EXISTS portal.chat_ai_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES portal.workspaces(id),
  conversation_id uuid NOT NULL REFERENCES portal.chat_conversations(id),
  actor_id        uuid NOT NULL,
  client_key      text NOT NULL,
  status          text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','ok','failed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, conversation_id, actor_id, client_key)
);
CREATE INDEX IF NOT EXISTS chat_ai_requests_ws_month ON portal.chat_ai_requests (workspace_id, created_at);

-- DELETE only where the product removes a row (the role is created by 003_roles.sh; on a database without it, e.g. a developer database, this is skipped)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qorlla_portal_app') THEN
    GRANT DELETE ON portal.chat_bookmarks, portal.chat_pins, portal.chat_members TO qorlla_portal_app;
  END IF;
END $$;

-- append-only audit (no message text, no questions)
CREATE TABLE IF NOT EXISTS portal.chat_audit (
  id              bigserial PRIMARY KEY,
  workspace_id    uuid NOT NULL,
  actor_id        uuid NOT NULL,
  action          text NOT NULL,
  conversation_id uuid,
  object_id       text,
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_audit_ws ON portal.chat_audit (workspace_id, at DESC);
CREATE OR REPLACE FUNCTION portal.chat_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'portal.chat_audit is append-only'; END $$;
DROP TRIGGER IF EXISTS chat_audit_no_change ON portal.chat_audit;
CREATE TRIGGER chat_audit_no_change BEFORE UPDATE OR DELETE ON portal.chat_audit FOR EACH ROW EXECUTE FUNCTION portal.chat_audit_immutable();

-- Plan entitlements (no row = NOT granted, quota NULL = unlimited). Seeded for the four existing plans; an operator can change or delete these rows.
--   chat                 granted = Portal Chat is available to the workspace (quota unused)
--   chat.channels.max    channels + groups (not direct messages) per workspace
--   chat.ai              QorllaMate questions per calendar month in chat (basic gets a small allowance)
INSERT INTO portal.entitlements(plan_slug, feature, quota, description) VALUES
  ('basic',      'chat',              NULL, 'Workspace chat'),
  ('pro',        'chat',              NULL, 'Workspace chat'),
  ('business',   'chat',              NULL, 'Workspace chat'),
  ('enterprise', 'chat',              NULL, 'Workspace chat'),
  ('basic',      'chat.channels.max', 5,    'Chat channels and groups per workspace'),
  ('pro',        'chat.channels.max', 100,  'Chat channels and groups per workspace'),
  ('business',   'chat.channels.max', 1000, 'Chat channels and groups per workspace'),
  ('enterprise', 'chat.channels.max', NULL, 'Chat channels and groups per workspace'),
  ('basic',      'chat.ai',           10,   'QorllaMate questions in chat per month'),
  ('pro',        'chat.ai',           500,  'QorllaMate questions in chat per month'),
  ('business',   'chat.ai',           2000, 'QorllaMate questions in chat per month'),
  ('enterprise', 'chat.ai',           NULL, 'QorllaMate questions in chat per month')
ON CONFLICT (plan_slug, feature) DO NOTHING;

COMMIT;
