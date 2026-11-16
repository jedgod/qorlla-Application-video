-- Delivery state only; v4.26 remains the immutable event source.
BEGIN;
CREATE TABLE phone_lifecycle_delivery (
  event_id uuid PRIMARY KEY REFERENCES phone_lifecycle_outbox(event_id),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner uuid,
  lease_token uuid,
  lease_until timestamptz,
  delivered_at timestamptz,
  dead_lettered_at timestamptz,
  last_error text,
  CHECK ((lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL)
      OR (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (delivered_at IS NULL OR dead_lettered_at IS NULL)
);
CREATE INDEX phone_lifecycle_delivery_pending ON phone_lifecycle_delivery(next_attempt_at, event_id)
  WHERE delivered_at IS NULL AND dead_lettered_at IS NULL;

DO $migration$
BEGIN
EXECUTE format($function$
CREATE FUNCTION phone_lifecycle_delivery_capture() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, %I, pg_temp AS $body$
BEGIN
  INSERT INTO phone_lifecycle_delivery(event_id) VALUES(NEW.event_id);
  RETURN NEW;
END $body$;
$function$, current_schema());
END $migration$;
CREATE TRIGGER phone_lifecycle_delivery_capture AFTER INSERT ON phone_lifecycle_outbox
  FOR EACH ROW EXECUTE FUNCTION phone_lifecycle_delivery_capture();

INSERT INTO phone_lifecycle_delivery(event_id) SELECT event_id FROM phone_lifecycle_outbox;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qorlla_meet_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON phone_lifecycle_delivery FROM qorlla_meet_app;
  END IF;
END $$;
COMMIT;
