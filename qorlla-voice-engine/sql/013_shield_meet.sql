-- Security Shield: meetings whose passcode, waiting room and host approval are owned by Qorlla Meet (authority 'meet'). The shield keeps only the POLICY facts it needs to decide a signaling join
-- (organization, host account, whether guests may join, when it ends); it never holds such a meeting's passcode. Meetings created through the shield's own admission (authority 'shield') are unchanged. Idempotent.
-- Suspension holds: each party that suspends an account (the main app's account administrators, security operations, ...) places its OWN hold; only that party can lift it, and the account stays suspended while any hold remains.
ALTER TABLE shield_principals ADD COLUMN IF NOT EXISTS suspend_holds text[] NOT NULL DEFAULT '{}';
UPDATE shield_principals SET suspend_holds = ARRAY['legacy'] WHERE suspended AND cardinality(suspend_holds) = 0;
ALTER TABLE shield_meetings ALTER COLUMN passcode_salt DROP NOT NULL;
ALTER TABLE shield_meetings ALTER COLUMN passcode_hash DROP NOT NULL;
ALTER TABLE shield_meetings ALTER COLUMN org_id DROP NOT NULL;
ALTER TABLE shield_meetings ALTER COLUMN host_account_id DROP NOT NULL;
ALTER TABLE shield_meetings ADD COLUMN IF NOT EXISTS authority text NOT NULL DEFAULT 'shield';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shield_meetings_authority_check') THEN ALTER TABLE shield_meetings ADD CONSTRAINT shield_meetings_authority_check CHECK (authority IN ('shield','meet')); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shield_meetings_passcode_authority') THEN ALTER TABLE shield_meetings ADD CONSTRAINT shield_meetings_passcode_authority CHECK (authority = 'meet' OR (passcode_salt IS NOT NULL AND passcode_hash IS NOT NULL)); END IF;
END $$;
