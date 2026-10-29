-- Qorlla Voice Engine: read-only PROJECTION of the Numbers & Plans number authority (keyed by the carrier's stable number id). The engine never buys, releases or activates a number; it only mirrors
-- the authority's versioned events and decides, with the Security Shield, whether a number may be used. Idempotent. Run with the migration role.
CREATE TABLE IF NOT EXISTS voice_number_projection (
  provider_number_id text PRIMARY KEY,
  e164 text NOT NULL CHECK (e164 ~ '^\+[1-9][0-9]{7,14}$'),
  country char(2),
  kind text NOT NULL CHECK (kind IN ('personal','dialin')),
  account_id text,
  state text NOT NULL CHECK (state IN ('provisioning','active','suspended','releasing','released')),
  caller_id_verified boolean NOT NULL DEFAULT false,
  hold boolean NOT NULL DEFAULT false,                      -- the authority says a carrier outcome is uncertain: never usable
  authority_version bigint NOT NULL CHECK (authority_version > 0),
  last_event_id uuid,
  conflict boolean NOT NULL DEFAULT false,                  -- would have given an account a second live number: stored for the operator, never usable
  stale boolean NOT NULL DEFAULT false,                     -- absent from the authority's latest full snapshot: never usable until the authority confirms it
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- an e164 can be live in only one row; one live personal number per account (conflicting rows are excluded and flagged instead)
CREATE UNIQUE INDEX IF NOT EXISTS voice_number_one_live_e164 ON voice_number_projection (e164) WHERE state <> 'released';
CREATE UNIQUE INDEX IF NOT EXISTS voice_number_one_live_personal ON voice_number_projection (account_id) WHERE kind = 'personal' AND account_id IS NOT NULL AND state IN ('provisioning','active','suspended','releasing') AND NOT conflict;
CREATE TABLE IF NOT EXISTS voice_number_events (
  event_id uuid PRIMARY KEY,
  provider_number_id text NOT NULL, version bigint NOT NULL, type text NOT NULL,
  result text NOT NULL CHECK (result IN ('applied','stale','conflict')),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_number_events_number ON voice_number_events (provider_number_id, version);
CREATE TABLE IF NOT EXISTS voice_number_gaps (
  provider_number_id text PRIMARY KEY, expected_version bigint NOT NULL, got_version bigint NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
