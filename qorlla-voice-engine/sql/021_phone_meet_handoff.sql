-- Phone -> Meeting hand-off lifecycle (v2.2). One row per transition, everything durable in PostgreSQL so several engine instances agree and a restart loses nothing.
--   pending     the initiator asked; a single-use token (only its SHA-256 is stored) waits for the recipient
--   accepted    the recipient accepted (atomic UPDATE: exactly one caller can win); each side was given its own readiness nonce
--   completing  the server decided both sides are ready and is ending the phone call (recoverable: a crash here is finished by the next touch)
--   completed   the phone call was ended by the server for this reason, exactly once
--   cancelled / expired / failed   the phone call was NOT touched
-- At most ONE open (pending/accepted/completing) hand-off per call: enforced by a partial unique index, not by application code.
-- Rollback: sql/rollback/021_phone_meet_handoff.down.sql (manual; never run by db:migrate). It drops only this table; calls and events are untouched.
CREATE TABLE IF NOT EXISTS voice_handoffs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id        uuid NOT NULL REFERENCES voice_calls(id),
  initiator_id   text NOT NULL,
  recipient_id   text NOT NULL,
  meeting_id     text NOT NULL,
  token_hash     text NOT NULL UNIQUE,
  status         text NOT NULL CHECK (status IN ('pending','accepted','completing','completed','cancelled','expired','failed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,                 -- token validity while pending
  accepted_at    timestamptz,
  release_deadline timestamptz,                        -- after accept: the time by which both sides must be ready, or the hand-off expires and the call carries on
  completed_at   timestamptz,
  closed_reason  text,
  -- readiness nonces are not stored: each is HMAC(server secret, hand-off id, role, token hash), so any engine instance can recompute it and nobody can guess it
  init_session   text,  recip_session text,            -- the Meet session each side reported readiness for (must not change)
  init_first     jsonb, recip_first   jsonb,           -- first accepted report: {at: server receive time (ms), bytes}
  init_last      jsonb, recip_last    jsonb,           -- latest report that proved growth
  init_ready_at  timestamptz, recip_ready_at timestamptz,
  version        integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS voice_handoffs_one_open ON voice_handoffs(call_id) WHERE status IN ('pending','accepted','completing');
CREATE INDEX IF NOT EXISTS voice_handoffs_status_expiry ON voice_handoffs(status, expires_at);
