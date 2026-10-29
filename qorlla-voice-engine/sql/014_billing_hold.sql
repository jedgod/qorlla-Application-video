-- A principal on billing hold cannot authorize PSTN calls (the authority also refuses number changes). Reported by the trusted backend; absent = unchanged. Idempotent.
ALTER TABLE shield_principals ADD COLUMN IF NOT EXISTS billing_hold boolean NOT NULL DEFAULT false;
