-- Run in MAIN application's PostgreSQL database, not Meet database.
CREATE TABLE IF NOT EXISTS qorlla_meet_sync_jobs (
 id BIGSERIAL PRIMARY KEY,
 source_id TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('upsert','cancel')),
 payload JSONB NOT NULL DEFAULT '{}'::jsonb,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','done','dead')),
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 lease_until TIMESTAMPTZ,
 last_error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(source_id,operation)
);
CREATE INDEX IF NOT EXISTS qorlla_meet_sync_due_idx ON qorlla_meet_sync_jobs(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS qorlla_meet_mappings (
 source_id TEXT PRIMARY KEY,
 meet_uuid UUID NOT NULL,
 meet_code TEXT NOT NULL,
 legacy_code TEXT,
 synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Host credentials must be stored only in an existing approved encrypted secrets vault.
-- Never persist hostSecret in the queue payload, logs or this mapping table.
