-- Durable event snapshots only. No delivery service or Portal authorization is enabled here.
BEGIN;
CREATE TABLE phone_lifecycle_outbox (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_event_id bigint NOT NULL UNIQUE,
  call_id uuid NOT NULL,
  meeting_id uuid NOT NULL,
  lifecycle_version bigint NOT NULL CHECK (lifecycle_version > 0),
  from_state text,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, lifecycle_version)
);

CREATE FUNCTION phone_lifecycle_outbox_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'phone lifecycle outbox events are immutable';
END $$;
CREATE TRIGGER phone_lifecycle_outbox_no_change BEFORE UPDATE OR DELETE ON phone_lifecycle_outbox
  FOR EACH ROW EXECUTE FUNCTION phone_lifecycle_outbox_immutable();
CREATE TRIGGER phone_lifecycle_outbox_no_truncate BEFORE TRUNCATE ON phone_lifecycle_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION phone_lifecycle_outbox_immutable();

DO $migration$
BEGIN
EXECUTE format($function$
CREATE FUNCTION phone_lifecycle_outbox_capture() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, %I, pg_temp AS $body$
DECLARE meeting uuid; version bigint;
BEGIN
  SELECT meeting_id INTO STRICT meeting FROM phone_calls WHERE id=NEW.call_id FOR UPDATE;
  SELECT count(*) INTO version FROM phone_call_events WHERE call_id=NEW.call_id;
  INSERT INTO phone_lifecycle_outbox(source_event_id,call_id,meeting_id,lifecycle_version,from_state,event_type,occurred_at)
    VALUES(NEW.id,NEW.call_id,meeting,version,NEW.from_state,NEW.to_state,NEW.at);
  RETURN NEW;
END $body$;
$function$, current_schema());
END $migration$;
CREATE TRIGGER phone_lifecycle_outbox_capture AFTER INSERT ON phone_call_events
  FOR EACH ROW EXECUTE FUNCTION phone_lifecycle_outbox_capture();
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qorlla_meet_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON phone_lifecycle_outbox FROM qorlla_meet_app;
  END IF;
END $$;
COMMIT;
