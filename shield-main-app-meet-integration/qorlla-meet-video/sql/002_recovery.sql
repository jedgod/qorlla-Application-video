-- Apply only after verifying actual meetings(id, ended_at, host_secret_hash) and external_meeting_links columns.
CREATE TABLE IF NOT EXISTS host_recovery_escrow (
 meeting_id uuid PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
 request_id varchar(128) NOT NULL,
 generation bigint NOT NULL CHECK (generation > 0),
 encrypted_secret text,
 state text NOT NULL CHECK (state IN ('pending','acknowledged')),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((state='pending' AND encrypted_secret IS NOT NULL) OR (state='acknowledged' AND encrypted_secret IS NULL))
);
CREATE INDEX IF NOT EXISTS host_recovery_pending_idx ON host_recovery_escrow(updated_at) WHERE state='pending';
