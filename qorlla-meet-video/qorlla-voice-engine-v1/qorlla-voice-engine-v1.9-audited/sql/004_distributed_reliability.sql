-- Apply with migration role after reviewing schema and backup.
CREATE TABLE IF NOT EXISTS voice_reliable_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 account_id text NOT NULL REFERENCES voice_identities(account_id),
 call_id uuid REFERENCES voice_calls(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('incoming','state','device_revoked','device_claimed')),
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS voice_reliable_events_account_cursor ON voice_reliable_events(account_id,id);
CREATE TABLE IF NOT EXISTS voice_outbox (
 event_id bigint PRIMARY KEY REFERENCES voice_reliable_events(id) ON DELETE CASCADE,
 attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(),
 locked_until timestamptz,
 locked_by uuid,
 delivered_at timestamptz,
 last_error text
);
CREATE INDEX IF NOT EXISTS voice_outbox_ready ON voice_outbox(available_at,event_id) WHERE delivered_at IS NULL;
ALTER TABLE voice_media_leases ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS voice_resume_cursors (
 account_id text NOT NULL REFERENCES voice_identities(account_id),
 device_id uuid NOT NULL,
 last_ack bigint NOT NULL DEFAULT 0 CHECK(last_ack >= 0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id,device_id)
);
-- Separate database roles should grant only required SELECT/INSERT/UPDATE privileges.
