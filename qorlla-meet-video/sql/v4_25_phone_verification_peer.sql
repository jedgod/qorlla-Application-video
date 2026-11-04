-- Qorlla Meet: restricted verification-phase telephone peer (v4.25). Idempotent; run as the owner BEFORE sql/005_app_role.sql. Rollback: sql/v4_25_phone_verification_peer.rollback.sql
--
-- Meet has no media server: browsers form a mesh, so a telephone caller's audio can only be verified after the telephone gateway's WebRTC peer has negotiated with the browsers over Meet's signalling. That peer is NOT a
-- participant (the call is APPROVED / MEDIA_CONNECTING, the participant row is not admitted, the room does not see it). It holds a short-lived, SINGLE-USE credential recorded here, bound to one call, one meeting and one
-- gateway identity. It can be revoked (closing its signalling and media) at any time; a revoked or expired credential can never be used again, and a late callback can never restore it.
CREATE TABLE IF NOT EXISTS phone_peer_credentials (
  jti            text PRIMARY KEY CHECK (length(jti) BETWEEN 16 AND 100),
  call_id        uuid NOT NULL REFERENCES phone_calls(id) ON DELETE CASCADE,
  meeting_id     uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL,
  subject        text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),       -- the gateway workload identity the credential was issued to
  issued_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,                                                    -- set ATOMICALLY by the first (and only) connection that presents it
  promoted_at    timestamptz,                                                    -- set when Meet promoted the call to MEDIA_CONNECTED on verified media
  revoked_at     timestamptz,
  revoked_reason text,
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '120 seconds'),
  CHECK (promoted_at IS NULL OR consumed_at IS NOT NULL)
);
-- One LIVE credential per call: a second one can only be issued after the first was revoked (an unconsumed one is superseded by the issuing transaction).
CREATE UNIQUE INDEX IF NOT EXISTS phone_peer_one_live ON phone_peer_credentials (call_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS phone_peer_expiry ON phone_peer_credentials (expires_at) WHERE consumed_at IS NULL AND revoked_at IS NULL;
