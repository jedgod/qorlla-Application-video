-- Qorlla Meet: telephone dial-in (audio-only participants who call in with the meeting ID and a PIN) (v4.13). Idempotent; run as the owner BEFORE sql/005_app_role.sql.
-- A phone caller is an ordinary participant row (kind='phone') of the same 11-digit meeting, so attendance, the waiting room, host controls, history and
-- recording consent all work for them the same way. No telephone number is ever stored in clear: callers are identified by a keyed hash and the last 4 digits.
-- Rollback: DROP TABLE phone_webhook_events, phone_attempts, phone_bans, phone_calls, meeting_phone_access; ALTER TABLE participants DROP COLUMN kind;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'web';
CREATE TABLE IF NOT EXISTS meeting_phone_access (
  meeting_id uuid PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  pin_hash   text NOT NULL,                       -- scrypt verifier; the PIN itself is shown once and never stored
  created_at timestamptz NOT NULL DEFAULT now(), rotated_at timestamptz, revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS phone_calls (
  id               uuid PRIMARY KEY,
  meeting_id       uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  provider         text NOT NULL,                 -- which adapter handled the call ('test-double' is never a real carrier)
  provider_call_id text NOT NULL,
  caller_hash      text NOT NULL,
  caller_last4     text NOT NULL DEFAULT '',
  status           text NOT NULL CHECK (status IN ('waiting','connected','denied','removed','ended')),
  participant_id   uuid REFERENCES participants(id) ON DELETE SET NULL,
  muted            boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(), connected_at timestamptz, ended_at timestamptz, end_reason text,
  UNIQUE (provider, provider_call_id)
);
CREATE INDEX IF NOT EXISTS phone_calls_meeting ON phone_calls (meeting_id, created_at);
CREATE TABLE IF NOT EXISTS phone_attempts (       -- failed PIN attempts per caller and per meeting (bounded retries, lockout)
  key text PRIMARY KEY, failures int NOT NULL DEFAULT 0, window_started timestamptz NOT NULL DEFAULT now(), locked_until timestamptz
);
CREATE TABLE IF NOT EXISTS phone_bans ( meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, caller_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (meeting_id, caller_hash) );
CREATE TABLE IF NOT EXISTS phone_webhook_events ( -- replay protection and idempotency: an event id is processed once; a repeat gets the stored answer
  event_id text NOT NULL, provider text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), result jsonb, PRIMARY KEY (provider, event_id)
);
