-- Qorlla Voice v1.11.1: outbox ordering and failure recovery. Additive and idempotent. Run with the migration role.
--   account_id   copied onto the outbox row (by a trigger, so every writer gets it) so the worker can claim "the oldest undelivered event of each account" from a tiny partial index instead of scanning history.
--   dead_at      a poison event (it fails every time for a reason of its own) is set aside after the retry limit so it cannot block its account for ever. It stays in voice_reliable_events and is still replayed
--                to a device that reconnects; it is counted so an alert can fire. A bus (Redis) outage is never a reason to set an event aside.
ALTER TABLE voice_outbox ADD COLUMN IF NOT EXISTS account_id text;
ALTER TABLE voice_outbox ADD COLUMN IF NOT EXISTS dead_at timestamptz;
CREATE OR REPLACE FUNCTION voice_outbox_set_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id IS NULL THEN SELECT account_id INTO NEW.account_id FROM voice_reliable_events WHERE id = NEW.event_id; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS voice_outbox_account ON voice_outbox;
CREATE TRIGGER voice_outbox_account BEFORE INSERT ON voice_outbox FOR EACH ROW EXECUTE FUNCTION voice_outbox_set_account();
UPDATE voice_outbox o SET account_id = e.account_id FROM voice_reliable_events e WHERE e.id = o.event_id AND o.account_id IS NULL;
CREATE INDEX IF NOT EXISTS voice_outbox_pending_account ON voice_outbox (account_id, event_id) WHERE delivered_at IS NULL AND dead_at IS NULL;
CREATE INDEX IF NOT EXISTS voice_outbox_dead ON voice_outbox (dead_at) WHERE dead_at IS NOT NULL;
