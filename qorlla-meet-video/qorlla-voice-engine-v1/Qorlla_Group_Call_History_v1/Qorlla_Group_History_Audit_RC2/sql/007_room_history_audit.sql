-- Apply AFTER 005_group_rooms.sql. Additive; no historical events are fabricated.
BEGIN;
CREATE TABLE IF NOT EXISTS voice_room_participation_segments (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 room_id uuid NOT NULL REFERENCES voice_rooms(id),
 account_id text NOT NULL REFERENCES voice_identities(account_id),
 joined_at timestamptz NOT NULL,
 left_at timestamptz,
 exit_status text CHECK (exit_status IN ('left','removed','missed','ended','expired')),
 start_generation bigint NOT NULL DEFAULT 0,
 CHECK (left_at IS NULL OR left_at >= joined_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS voice_room_segment_one_open ON voice_room_participation_segments(room_id, account_id) WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS voice_room_segment_account ON voice_room_participation_segments(account_id, joined_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS voice_room_audit_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 room_id uuid NOT NULL REFERENCES voice_rooms(id),
 account_id text REFERENCES voice_identities(account_id),
 actor_id text,
 kind text NOT NULL CHECK (kind IN ('room_created','invited','joined','left','declined','removed','missed','reinvited','host_transferred','room_ended','device_claimed')),
 previous_status text,
 new_status text,
 previous_host_id text,
 new_host_id text,
 generation bigint,
 room_version bigint,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS voice_room_audit_room ON voice_room_audit_events(room_id, id);
CREATE INDEX IF NOT EXISTS voice_room_audit_account ON voice_room_audit_events(account_id, id DESC);
-- Transaction-local actor context is OPTIONAL; absent context is explicitly recorded as unknown.
CREATE OR REPLACE FUNCTION voice_history_actor() RETURNS text LANGUAGE sql STABLE AS $$
 SELECT NULLIF(current_setting('qorlla.voice_actor', true), '')
$$;
CREATE OR REPLACE FUNCTION voice_history_member_changes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ts timestamptz := clock_timestamp(); prev text; ev text;
BEGIN
 IF TG_OP = 'INSERT' THEN
   IF NEW.status = 'joined' THEN
     INSERT INTO voice_room_participation_segments(room_id,account_id,joined_at,start_generation)
     VALUES(NEW.room_id,NEW.account_id,COALESCE(NEW.joined_at,ts),NEW.generation);
   END IF;
   INSERT INTO voice_room_audit_events(room_id,account_id,actor_id,kind,new_status,generation)
   VALUES(NEW.room_id,NEW.account_id,COALESCE(voice_history_actor(),NEW.invited_by),CASE WHEN NEW.status='joined' THEN 'joined' ELSE 'invited' END,NEW.status,NEW.generation);
   RETURN NEW;
 END IF;
 prev := OLD.status;
 IF NEW.status IS DISTINCT FROM OLD.status THEN
   IF OLD.status='joined' AND NEW.status <> 'joined' THEN
     UPDATE voice_room_participation_segments SET left_at=GREATEST(joined_at,COALESCE(NEW.left_at,ts)),
       exit_status=CASE WHEN NEW.status IN ('left','removed','missed') THEN NEW.status ELSE 'ended' END
     WHERE room_id=NEW.room_id AND account_id=NEW.account_id AND left_at IS NULL;
   ELSIF OLD.status <> 'joined' AND NEW.status='joined' THEN
     INSERT INTO voice_room_participation_segments(room_id,account_id,joined_at,start_generation)
     VALUES(NEW.room_id,NEW.account_id,COALESCE(NEW.joined_at,ts),NEW.generation);
   END IF;
   ev := CASE WHEN NEW.status='invited' THEN 'reinvited' ELSE NEW.status END;
   INSERT INTO voice_room_audit_events(room_id,account_id,actor_id,kind,previous_status,new_status,generation)
   VALUES(NEW.room_id,NEW.account_id,voice_history_actor(),ev,prev,NEW.status,NEW.generation);
 ELSIF NEW.status='joined' AND NEW.device_id IS DISTINCT FROM OLD.device_id THEN
   INSERT INTO voice_room_audit_events(room_id,account_id,actor_id,kind,previous_status,new_status,generation)
   VALUES(NEW.room_id,NEW.account_id,voice_history_actor(),'device_claimed',OLD.status,NEW.status,NEW.generation);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS voice_history_member_trigger ON voice_room_members;
CREATE TRIGGER voice_history_member_trigger AFTER INSERT OR UPDATE ON voice_room_members
FOR EACH ROW EXECUTE FUNCTION voice_history_member_changes();
CREATE OR REPLACE FUNCTION voice_history_room_changes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   INSERT INTO voice_room_audit_events(room_id,actor_id,kind,new_host_id,room_version)
   VALUES(NEW.id,COALESCE(voice_history_actor(),NEW.host_id),'room_created',NEW.host_id,NEW.version);
 ELSE
   IF NEW.host_id IS DISTINCT FROM OLD.host_id THEN
     INSERT INTO voice_room_audit_events(room_id,actor_id,kind,previous_host_id,new_host_id,room_version)
     VALUES(NEW.id,voice_history_actor(),'host_transferred',OLD.host_id,NEW.host_id,NEW.version);
   END IF;
   IF NEW.status='ended' AND OLD.status IS DISTINCT FROM 'ended' THEN
     INSERT INTO voice_room_audit_events(room_id,actor_id,kind,previous_status,new_status,room_version,details)
     VALUES(NEW.id,voice_history_actor(),'room_ended',OLD.status,NEW.status,NEW.version,jsonb_build_object('reason',NEW.end_reason));
   END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS voice_history_room_trigger ON voice_rooms;
CREATE TRIGGER voice_history_room_trigger AFTER INSERT OR UPDATE ON voice_rooms
FOR EACH ROW EXECUTE FUNCTION voice_history_room_changes();
-- Existing joined members are a snapshot, NOT proof of when their earlier segments began.
-- Bootstrap current open segments without creating invented audit events.
INSERT INTO voice_room_participation_segments(room_id,account_id,joined_at,start_generation)
SELECT room_id,account_id,COALESCE(joined_at,now()),generation FROM voice_room_members WHERE status='joined'
ON CONFLICT (room_id,account_id) WHERE left_at IS NULL DO NOTHING;
COMMIT;
