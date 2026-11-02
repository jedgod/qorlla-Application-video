-- Qorlla Telephony v2.2 (v4.15): which saved call preferences are really enforced by the carrier. Idempotent; run as the owner BEFORE sql/005_app_role.sql (after v4_14_telephony.sql).
-- A preference the user saved (forwarding, voicemail, do-not-disturb, ...) is DESIRED state. This table tracks the carrier side: requested -> active (confirmed by reading it back) or failed,
-- and drift when the carrier's state later differs. A row never claims "active" without a read-back from the carrier.
-- Rollback: DROP TABLE qphone_feature_state;
CREATE TABLE IF NOT EXISTS qphone_feature_state (
  owner_id text NOT NULL, feature text NOT NULL CHECK (feature IN ('forwarding','voicemail','doNotDisturb','callWaiting','spamProtection','blockedNumbers','callerId')),
  desired jsonb NOT NULL, desired_hash text NOT NULL,
  state text NOT NULL DEFAULT 'off' CHECK (state IN ('off','requested','active','drift','failed')),
  error_code text, confirmed_at timestamptz, checked_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, feature)
);
CREATE INDEX IF NOT EXISTS qphone_feature_state_work ON qphone_feature_state (state) WHERE state IN ('requested','active','drift');
