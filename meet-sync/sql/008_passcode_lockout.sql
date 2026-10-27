-- Durable, multi-instance-safe meeting passcode lockout (MAIN). Rows are locked with SELECT ... FOR UPDATE; expiry uses the database clock.
-- Rollback: DROP TABLE public.meeting_passcode_events; DROP TABLE public.meeting_passcode_attempts;
CREATE TABLE IF NOT EXISTS public.meeting_passcode_attempts (
  meeting_id      TEXT PRIMARY KEY,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.meeting_passcode_events (
  id         BIGSERIAL PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('locked','cleared_by_host')),
  actor      TEXT,                      -- truncated hash, never an address or the passcode
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_passcode_events_meeting ON public.meeting_passcode_events (meeting_id, id DESC);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qorlla_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.meeting_passcode_attempts TO qorlla_app;
    GRANT SELECT, INSERT ON public.meeting_passcode_events TO qorlla_app;
    GRANT USAGE, SELECT ON SEQUENCE public.meeting_passcode_events_id_seq TO qorlla_app;
  END IF;
END $$;
