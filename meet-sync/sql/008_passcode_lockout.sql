-- Durable, multi-instance-safe meeting passcode lockout (MAIN). Rows are locked with SELECT ... FOR UPDATE; expiry uses the database clock.
-- Idempotent: safe to run again, and upgrades the first (tag 86b39ba) revision in place.
-- UPGRADE ORDER: apply this file to the MAIN database BEFORE starting the new MAIN version. Until it is applied, protected meeting joins are
--   refused with 503 (the application never falls back to memory). Fresh volumes get it automatically through docker-entrypoint-initdb.d.
-- ROLLBACK (only after stopping the new MAIN version, or its protected joins will refuse with 503):
--   DROP TABLE IF EXISTS public.meeting_passcode_reservations; DROP TABLE IF EXISTS public.meeting_passcode_events; DROP TABLE IF EXISTS public.meeting_passcode_attempts;
CREATE TABLE IF NOT EXISTS public.meeting_passcode_attempts (
  meeting_id      TEXT PRIMARY KEY,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.meeting_passcode_attempts ADD COLUMN IF NOT EXISTS epoch BIGINT NOT NULL DEFAULT 0;   -- bumped by every reset/lock; voids open reservations
CREATE TABLE IF NOT EXISTS public.meeting_passcode_reservations (
  attempt_id UUID PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  epoch      BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_passcode_reservations_meeting ON public.meeting_passcode_reservations (meeting_id);
CREATE TABLE IF NOT EXISTS public.meeting_passcode_events (
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
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qorlla_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.meeting_passcode_attempts TO qorlla_app;
    GRANT SELECT, INSERT, DELETE ON public.meeting_passcode_reservations TO qorlla_app;   -- reservations are short-lived rows
    GRANT SELECT, INSERT, DELETE ON public.meeting_passcode_events TO qorlla_app;         -- DELETE only prunes old rejected-request audits
    GRANT USAGE, SELECT ON SEQUENCE public.meeting_passcode_events_id_seq TO qorlla_app;
  END IF;
END $$;
