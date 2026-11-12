-- Qorlla Meet v4.24 (ASCS-M1.2): the durable registry of relay (TURN) credentials issued for screen sharing. Idempotent.
--   One row per credential: bound to a MEETING, a PARTICIPANT and a SHARE, with its role on that share's dedicated relay connection.
--   The row holds NO secret: the username is opaque and random, the password is never stored (coturn's user database in Redis holds only its own MD5 key, with a TTL).
--   revoked_at / revoke_reason : the REVOCATION IS RECORDED HERE FIRST (durably), before anything is deleted in Redis or cancelled in coturn.
--   terminated_at              : set only when the credential's key is gone from Redis AND no live relay allocation of it remains. A revoked row without it is
--                                "pending termination": the reconciler (on boot and on every sweep) finishes the job, so a crash, a restart or an unreachable relay never leaves a revoked
--                                credential's media alive forever.
-- Rollback: DROP TABLE relay_credentials;
CREATE TABLE IF NOT EXISTS relay_credentials (
  username text PRIMARY KEY,
  meeting_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  share_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('presenter', 'viewer')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  terminated_at timestamptz,
  termination_error text
);
CREATE INDEX IF NOT EXISTS relay_credentials_share ON relay_credentials (share_id);
CREATE INDEX IF NOT EXISTS relay_credentials_meeting ON relay_credentials (meeting_id);
CREATE INDEX IF NOT EXISTS relay_credentials_pending ON relay_credentials (revoked_at) WHERE terminated_at IS NULL;
