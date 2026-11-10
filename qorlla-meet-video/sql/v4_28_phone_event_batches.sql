-- Serialize batches per call and capture each transition in source-event order.
-- Does not authorize calls, media, or historical replay.
BEGIN;
-- Fail fast instead of queueing behind long transactions: a waiting SHARE ROW EXCLUSIVE lock blocks new call writes.
SET LOCAL lock_timeout = '5s';
LOCK TABLE phone_calls, phone_call_events IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE phone_lifecycle_legacy_baseline (
  call_id uuid PRIMARY KEY,
  state text NOT NULL
);
INSERT INTO phone_lifecycle_legacy_baseline(call_id,state)
  SELECT c.id,c.state FROM phone_calls c
  WHERE NOT EXISTS (SELECT 1 FROM phone_call_events e WHERE e.call_id=c.id);
CREATE TRIGGER phone_lifecycle_legacy_baseline_no_change
  BEFORE UPDATE OR DELETE ON phone_lifecycle_legacy_baseline
  FOR EACH ROW EXECUTE FUNCTION phone_lifecycle_outbox_immutable();
CREATE TRIGGER phone_lifecycle_legacy_baseline_no_truncate
  BEFORE TRUNCATE ON phone_lifecycle_legacy_baseline
  FOR EACH STATEMENT EXECUTE FUNCTION phone_lifecycle_outbox_immutable();
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qorlla_meet_app') THEN
    REVOKE ALL ON phone_lifecycle_legacy_baseline FROM qorlla_meet_app;
  END IF;
END $$;
DROP TRIGGER phone_lifecycle_outbox_capture ON phone_call_events;

DO $migration$
BEGIN
EXECUTE format($function$
CREATE OR REPLACE FUNCTION phone_lifecycle_outbox_capture() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, %I, pg_temp AS $body$
DECLARE
  item record;
  batch_call record;
  previous_state text;
  version bigint;
  meeting uuid;
BEGIN
  FOR batch_call IN SELECT DISTINCT call_id FROM inserted_phone_events ORDER BY call_id LOOP
    SELECT meeting_id INTO STRICT meeting FROM phone_calls WHERE id=batch_call.call_id FOR UPDATE;
    SELECT count(*), (array_agg(to_state ORDER BY id DESC))[1]
      INTO version, previous_state
      FROM phone_call_events e
      WHERE e.call_id=batch_call.call_id
        AND NOT EXISTS (SELECT 1 FROM inserted_phone_events n WHERE n.id=e.id);
    SELECT event_type,lifecycle_version INTO item FROM phone_lifecycle_outbox
      WHERE call_id=batch_call.call_id ORDER BY lifecycle_version DESC LIMIT 1;
    IF FOUND THEN
      previous_state := item.event_type;
      version := GREATEST(version,item.lifecycle_version);
    END IF;
    IF version=0 THEN
      SELECT state INTO item FROM phone_lifecycle_legacy_baseline WHERE call_id=batch_call.call_id;
      IF FOUND THEN
        previous_state := item.state;
        version := 1;
      END IF;
    END IF;

    FOR item IN SELECT * FROM inserted_phone_events WHERE call_id=batch_call.call_id ORDER BY id LOOP
      IF item.from_state IS DISTINCT FROM previous_state OR (
        (previous_state IS NULL AND item.to_state='REQUESTED') OR
        (previous_state='REQUESTED' AND item.to_state IN ('VERIFIED','REFUSED','CANCELLED','TIMED_OUT')) OR
        (previous_state='VERIFIED' AND item.to_state IN ('AWAITING_HOST','APPROVED','REFUSED','CANCELLED','TIMED_OUT')) OR
        (previous_state='AWAITING_HOST' AND item.to_state IN ('APPROVED','REFUSED','TIMED_OUT','CANCELLED')) OR
        (previous_state='APPROVED' AND item.to_state IN ('MEDIA_CONNECTING','REFUSED','TIMED_OUT','CANCELLED','TERMINATED','ORPHANED')) OR
        (previous_state='MEDIA_CONNECTING' AND item.to_state IN ('MEDIA_CONNECTED','REFUSED','TIMED_OUT','CANCELLED','TERMINATED','ORPHANED')) OR
        (previous_state='MEDIA_CONNECTED' AND item.to_state='TERMINATED') OR
        (previous_state IN ('REFUSED','TIMED_OUT','CANCELLED') AND item.to_state IN ('ORPHANED','TERMINATED')) OR
        (previous_state='ORPHANED' AND item.to_state='TERMINATED')
      ) IS NOT TRUE THEN
        RAISE EXCEPTION 'invalid phone lifecycle transition for call %%', batch_call.call_id
          USING ERRCODE='23514';
      END IF;
      version := version + 1;
      INSERT INTO phone_lifecycle_outbox(source_event_id,call_id,meeting_id,lifecycle_version,from_state,event_type,occurred_at)
        VALUES(item.id,item.call_id,meeting,version,item.from_state,item.to_state,item.at);
      previous_state := item.to_state;
    END LOOP;
  END LOOP;
  RETURN NULL;
END $body$;
$function$, current_schema());
END $migration$;

CREATE TRIGGER phone_lifecycle_outbox_capture
  AFTER INSERT ON phone_call_events REFERENCING NEW TABLE AS inserted_phone_events
  FOR EACH STATEMENT EXECUTE FUNCTION phone_lifecycle_outbox_capture();
COMMIT;
