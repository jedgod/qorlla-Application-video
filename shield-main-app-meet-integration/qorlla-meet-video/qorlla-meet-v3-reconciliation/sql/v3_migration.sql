BEGIN;
CREATE TABLE IF NOT EXISTS external_meeting_links (
 source_system varchar(40) NOT NULL,
 source_id varchar(120) NOT NULL,
 meeting_id uuid NOT NULL UNIQUE REFERENCES meetings(id) ON DELETE CASCADE,
 scheduled_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(source_system,source_id)
);
CREATE TABLE IF NOT EXISTS meeting_code_aliases (
 alias_code varchar(12) PRIMARY KEY CHECK(alias_code ~ '^\d{10,12}$'),
 meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meeting_alias_meeting ON meeting_code_aliases(meeting_id);
COMMIT;
