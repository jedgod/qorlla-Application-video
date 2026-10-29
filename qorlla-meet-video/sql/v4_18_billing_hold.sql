-- Numbers & Plans v4.18: billing hold. The main app / billing system reports it over the trusted bridge (never a browser). A held or delinquent account cannot be given a number, receive a transfer, lose a number to a transfer,
-- or get a verified caller ID until the hold is lifted. Idempotent, non-destructive. Rollback: ALTER TABLE qphone_accounts DROP COLUMN billing_hold;
ALTER TABLE qphone_accounts ADD COLUMN IF NOT EXISTS billing_hold boolean NOT NULL DEFAULT false;
