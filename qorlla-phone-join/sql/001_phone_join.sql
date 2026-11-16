-- Telephone admission gateway: shared call ledger and gateway-token replay record. PostgreSQL.
-- Rollback: sql/001_phone_join.rollback.sql
-- Ownership of a call id is a PRIMARY KEY: with several gateway replicas, exactly one INSERT can win. State changes are validated against an allowed-transition table inside one transaction,
-- and every change is written to an append-only history.
CREATE TABLE IF NOT EXISTS phone_join_calls (
  call_id            text PRIMARY KEY CHECK (call_id ~ '^[-A-Za-z0-9_:]{8,128}$'),
  state              text NOT NULL CHECK (state IN ('claimed','authorizing','awaiting_host','attaching','connected','failed','terminating','ended','orphaned')),
  meeting_session_id text CHECK (meeting_session_id IS NULL OR length(meeting_session_id) <= 128),
  reason             text CHECK (reason IS NULL OR length(reason) <= 200),
  claimed_by         text NOT NULL,
  claimed_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  ended_at           timestamptz
);
CREATE INDEX IF NOT EXISTS phone_join_calls_open ON phone_join_calls (updated_at) WHERE state IN ('claimed','authorizing','awaiting_host','attaching','terminating');

CREATE TABLE IF NOT EXISTS phone_join_call_events (
  id         bigserial PRIMARY KEY,
  call_id    text NOT NULL,
  from_state text,
  to_state   text NOT NULL,
  reason     text,
  actor      text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phone_join_call_events_call ON phone_join_call_events (call_id, id);
-- append-only: history can be read and added to, never changed
CREATE OR REPLACE FUNCTION phone_join_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'phone_join_call_events is append-only'; END $$;
DROP TRIGGER IF EXISTS phone_join_events_no_change ON phone_join_call_events;
CREATE TRIGGER phone_join_events_no_change BEFORE UPDATE OR DELETE ON phone_join_call_events FOR EACH ROW EXECUTE FUNCTION phone_join_events_immutable();

-- One-use workload tokens: a token id (jti) is accepted once, until it would have expired anyway.
CREATE TABLE IF NOT EXISTS phone_join_replay (
  jti        text PRIMARY KEY CHECK (length(jti) BETWEEN 16 AND 200),
  issuer     text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS phone_join_replay_expiry ON phone_join_replay (expires_at);
