ALTER TABLE meetings ADD COLUMN IF NOT EXISTS meeting_code varchar(12);
CREATE UNIQUE INDEX IF NOT EXISTS meetings_meeting_code_unique ON meetings(meeting_code);
