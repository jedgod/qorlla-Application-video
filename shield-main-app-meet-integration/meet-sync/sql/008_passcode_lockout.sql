-- Durable, multi-instance-safe meeting passcode lockout (MAIN). Rows are locked with SELECT ... FOR UPDATE; expiry uses the database clock.
-- Idempotent: safe to run again, and it upgrades earlier revisions in place (including REVOKING privileges an earlier revision granted).
-- UPGRADE ORDER: apply this file to the MAIN database BEFORE starting the new MAIN version. Until it is applied, protected meeting joins are
--   refused with 503 (the application never falls back to memory). Fresh volumes get it automatically through docker-entrypoint-initdb.d.
-- ROLLBACK (only after stopping the new MAIN version, or its protected joins will refuse with 503):
--   DROP TABLE IF EXISTS public.meeting_passcode_reservations; DROP TABLE IF EXISTS public.meeting_passcode_events; DROP TABLE IF EXISTS public.meeting_passcode_attempts;
--   DROP TABLE IF EXISTS public.meeting_passcode_maintenance; DROP FUNCTION IF EXISTS public.prune_passcode_events(integer);
--
-- SECURITY EVENTS ARE APPEND-ONLY FOR THE APPLICATION ROLE: qorlla_app gets SELECT and INSERT on meeting_passcode_events and nothing else.
-- This file REVOKES any other privilege (direct or on PUBLIC) and then CHECKS THE EFFECTIVE privileges, which include anything inherited through
-- role membership. If an inherited grant still permits UPDATE/DELETE/TRUNCATE the migration FAILS (revoke that grant, then run it again).
-- Retention is a separate, owner-run, audited step: SELECT public.prune_passcode_events(90);  (see docs/RUNBOOK.md)
CREATE TABLE IF NOT EXISTS public.meeting_passcode_attempts (
  meeting_id      TEXT PRIMARY KEY,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.meeting_passcode_attempts ADD COLUMN IF NOT EXISTS epoch BIGINT NOT NULL DEFAULT 0;   -- bumped by every reset/lock; voids open reservations
CREATE TABLE IF NOT EXISTS public.meeting_passcode_reservations (   -- short-lived operational rows (deletable by the application)
  attempt_id UUID PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  epoch      BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_passcode_reservations_meeting ON public.meeting_passcode_reservations (meeting_id);
CREATE TABLE IF NOT EXISTS public.meeting_passcode_events (         -- PERMANENT security history
  id         BIGSERIAL PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  kind       TEXT NOT NULL,
  actor      TEXT,                      -- truncated hash, never an address, secret or the passcode
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.meeting_passcode_events ADD COLUMN IF NOT EXISTS reason TEXT;     -- reason code for rejected host actions
ALTER TABLE public.meeting_passcode_events DROP CONSTRAINT IF EXISTS meeting_passcode_events_kind_check;
ALTER TABLE public.meeting_passcode_events ADD CONSTRAINT meeting_passcode_events_kind_check CHECK (kind IN ('locked','cleared_by_host','clear_rejected'));
CREATE INDEX IF NOT EXISTS meeting_passcode_events_meeting ON public.meeting_passcode_events (meeting_id, id DESC);

-- Maintenance (owner only): audited retention of REJECTED-request records. Never touches 'locked' or 'cleared_by_host', and refuses windows
-- shorter than two days so events still needed for the one-hour recovery limit can never be pruned.
CREATE TABLE IF NOT EXISTS public.meeting_passcode_maintenance (
  id              BIGSERIAL PRIMARY KEY,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  operator        TEXT NOT NULL DEFAULT current_user,
  older_than_days INTEGER NOT NULL,
  deleted_events  INTEGER NOT NULL
);
CREATE OR REPLACE FUNCTION public.prune_passcode_events(days integer DEFAULT 90) RETURNS integer LANGUAGE plpgsql AS $f$
DECLARE n integer;
BEGIN
  IF days IS NULL OR days < 2 THEN RAISE EXCEPTION 'retention must be at least 2 days'; END IF;
  DELETE FROM public.meeting_passcode_events WHERE kind = 'clear_rejected' AND at < now() - make_interval(days => days);
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO public.meeting_passcode_maintenance(older_than_days, deleted_events) VALUES (days, n);
  RETURN n;
END $f$;
REVOKE ALL ON FUNCTION public.prune_passcode_events(integer) FROM PUBLIC;
REVOKE ALL ON TABLE public.meeting_passcode_maintenance FROM PUBLIC;
REVOKE ALL ON TABLE public.meeting_passcode_events FROM PUBLIC;
REVOKE ALL ON TABLE public.meeting_passcode_attempts FROM PUBLIC;
REVOKE ALL ON TABLE public.meeting_passcode_reservations FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qorlla_app') THEN
    REVOKE ALL ON TABLE public.meeting_passcode_events FROM qorlla_app;           -- drops DELETE (and anything else) from earlier revisions
    REVOKE ALL ON TABLE public.meeting_passcode_maintenance FROM qorlla_app;
    REVOKE ALL ON FUNCTION public.prune_passcode_events(integer) FROM qorlla_app;
    GRANT SELECT, INSERT, UPDATE ON public.meeting_passcode_attempts TO qorlla_app;
    GRANT SELECT, INSERT, DELETE ON public.meeting_passcode_reservations TO qorlla_app;
    GRANT SELECT, INSERT ON public.meeting_passcode_events TO qorlla_app;           -- append-only
    GRANT USAGE, SELECT ON SEQUENCE public.meeting_passcode_events_id_seq TO qorlla_app;
    -- Effective privileges (direct + inherited through role membership + PUBLIC): refuse to finish if the events table is not append-only.
    IF has_table_privilege('qorlla_app', 'public.meeting_passcode_events', 'DELETE')
       OR has_table_privilege('qorlla_app', 'public.meeting_passcode_events', 'UPDATE')
       OR has_table_privilege('qorlla_app', 'public.meeting_passcode_events', 'TRUNCATE')
       OR has_table_privilege('qorlla_app', 'public.meeting_passcode_events', 'REFERENCES')
       OR has_table_privilege('qorlla_app', 'public.meeting_passcode_events', 'TRIGGER') THEN
      RAISE EXCEPTION 'qorlla_app still has a modifying privilege on meeting_passcode_events through an inherited role or PUBLIC; revoke it and run this file again';
    END IF;
    IF has_table_privilege('qorlla_app', 'public.meeting_passcode_maintenance', 'SELECT') OR has_function_privilege('qorlla_app', 'public.prune_passcode_events(integer)', 'EXECUTE') THEN
      RAISE EXCEPTION 'qorlla_app can reach the retention maintenance objects through an inherited role or PUBLIC; revoke it and run this file again';
    END IF;
  END IF;
END $$;
