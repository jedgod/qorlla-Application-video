BEGIN;
CREATE TABLE IF NOT EXISTS shield.meeting_guest_config (
 meeting_id uuid PRIMARY KEY, passcode_salt text NOT NULL,
 passcode_digest bytea NOT NULL, guest_enabled boolean NOT NULL DEFAULT false,
 requires_lobby boolean NOT NULL DEFAULT true,
 ends_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS shield.guest_attempts (
 client_key text NOT NULL, window_start timestamptz NOT NULL,
 attempts int NOT NULL CHECK(attempts>=0),PRIMARY KEY(client_key,window_start)
);
CREATE TABLE IF NOT EXISTS shield.guest_admissions (
 id uuid PRIMARY KEY,meeting_id uuid NOT NULL REFERENCES shield.meeting_guest_config(meeting_id),
 display_name varchar(80) NOT NULL,state text NOT NULL CHECK(state IN ('WAITING','ADMITTED','DENIED','EXPIRED')),
 expires_at timestamptz NOT NULL,approved_at timestamptz
);
CREATE INDEX IF NOT EXISTS guest_admissions_meeting_state_idx ON shield.guest_admissions(meeting_id,state);
COMMIT;
