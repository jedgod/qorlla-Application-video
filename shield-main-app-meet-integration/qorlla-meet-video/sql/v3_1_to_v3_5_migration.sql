-- Apply after v3_migration.sql. Existing data is preserved.
BEGIN;
ALTER TABLE external_meeting_links ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_external_links_scheduled_at ON external_meeting_links(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_meetings_code_lookup ON meetings(meeting_code);
COMMIT;
