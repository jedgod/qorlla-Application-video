-- Passcodes are bcrypt-hashed by MAIN before storage; the plaintext is never persisted or queued.
ALTER TABLE qorlla_schedules ADD COLUMN IF NOT EXISTS passcode_hash text;
