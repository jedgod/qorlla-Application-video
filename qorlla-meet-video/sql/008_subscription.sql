-- Qorlla Meet 008: subscription enforcement (this is MEET's database; the subscription engine has its own).
-- Safe to apply before the feature is switched on: every column is nullable or defaulted and nothing reads them while
-- SUBSCRIPTION_ENFORCEMENT is "off".

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS customer_id uuid;                     -- the billing tenant that owns the meeting; NULL = anonymous (free plan limits)
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS entitled_features jsonb NOT NULL DEFAULT '{}';   -- what the plan allowed at creation (recording, webinar, breakout rooms)
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS started_at timestamptz;               -- first admission
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS deadline_at timestamptz;              -- the server-enforced end, fixed at first admission, survives restarts
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS warned_at timestamptz;                -- "ending soon" notice already sent
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS end_reason text;                      -- 'host' | 'time_limit' | 'account_suspended' | ...

-- A seat is held from admission until the participant leaves. A join whose socket never connects stops counting after 60 seconds.
ALTER TABLE participants ADD COLUMN IF NOT EXISTS connected_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_meetings_deadline ON meetings (deadline_at) WHERE ended_at IS NULL AND deadline_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meetings_customer ON meetings (customer_id) WHERE ended_at IS NULL AND customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_participants_seats ON participants (meeting_id) WHERE left_at IS NULL;
