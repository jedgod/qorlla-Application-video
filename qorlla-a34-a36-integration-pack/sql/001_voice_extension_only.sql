-- Reference schema. Adapt to actual principal tables; apply with migration tooling.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS voice_principals(account_id uuid PRIMARY KEY,tenant_id uuid NOT NULL,verified boolean NOT NULL DEFAULT false,suspended boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS voice_extensions(tenant_id uuid NOT NULL,extension text NOT NULL CHECK(extension ~ '^[0-9]{3,8}$'),account_id uuid NOT NULL REFERENCES voice_principals(account_id),active boolean NOT NULL DEFAULT true,PRIMARY KEY(tenant_id,extension));
CREATE UNIQUE INDEX IF NOT EXISTS voice_extension_owner ON voice_extensions(tenant_id,account_id) WHERE active;
CREATE TABLE IF NOT EXISTS voice_calls(call_id uuid PRIMARY KEY,tenant_id uuid NOT NULL,caller_id uuid NOT NULL REFERENCES voice_principals(account_id),callee_id uuid NOT NULL REFERENCES voice_principals(account_id),state text NOT NULL CHECK(state IN ('ringing','connected','revoked','completed','failed')),created_at timestamptz NOT NULL DEFAULT now(),ended_at timestamptz);
CREATE INDEX IF NOT EXISTS voice_calls_live_caller ON voice_calls(tenant_id,caller_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS voice_calls_live_callee ON voice_calls(tenant_id,callee_id) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS voice_rooms(room_id uuid PRIMARY KEY,tenant_id uuid NOT NULL,created_by uuid NOT NULL REFERENCES voice_principals(account_id),disabled boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS voice_room_members(room_id uuid NOT NULL REFERENCES voice_rooms(room_id),tenant_id uuid NOT NULL,account_id uuid NOT NULL REFERENCES voice_principals(account_id),PRIMARY KEY(room_id,account_id));
CREATE TABLE IF NOT EXISTS voice_outbox(event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_type text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),delivered_at timestamptz,locked_until timestamptz,attempts integer NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS voice_outbox_pending ON voice_outbox(created_at) WHERE delivered_at IS NULL;
-- Defense in depth: force tenant-aware DB role and RLS policy in actual repo migration.
-- Do not give application role schema ownership or destructive audit privileges.
