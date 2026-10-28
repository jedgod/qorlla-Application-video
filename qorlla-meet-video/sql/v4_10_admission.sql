-- Qorlla Meet v4.0.2b: admission control - waiting room, join-before-host, lock when the host joins. Idempotent. Defaults keep today's behaviour (everyone admitted).
-- Rollback: ALTER TABLE participants DROP COLUMN admission, DROP COLUMN wait_reason; ALTER TABLE meetings DROP COLUMN waiting_room, DROP COLUMN join_before_host, DROP COLUMN lock_on_host_join;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS waiting_room boolean NOT NULL DEFAULT false;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS join_before_host boolean NOT NULL DEFAULT true;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS lock_on_host_join boolean NOT NULL DEFAULT false;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS admission text NOT NULL DEFAULT 'admitted';
ALTER TABLE participants ADD COLUMN IF NOT EXISTS wait_reason text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'participants_admission_check') THEN
    ALTER TABLE participants ADD CONSTRAINT participants_admission_check CHECK (admission IN ('admitted','waiting','denied'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS participants_waiting ON participants (meeting_id) WHERE admission = 'waiting';
