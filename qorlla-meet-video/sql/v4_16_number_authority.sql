-- Qorlla Numbers & Plans v4.16: ONE number authority. Versioned numbers, a transactional outbox, durable provider operations, uniqueness, immutable audit. NON-DESTRUCTIVE and idempotent:
-- nothing is deleted or rewritten; existing duplicate assignments are REPORTED (qphone_assignment_conflicts) and the uniqueness rule is only enforced once there are none.
-- Run as the owner after v4_14 / v4_15 and BEFORE sql/005_app_role.sql.
-- Rollback (structure only, no data loss): DROP TRIGGER qphone_numbers_authority_a ON qphone_numbers; DROP TRIGGER qphone_numbers_authority_b ON qphone_numbers; DROP INDEX IF EXISTS qphone_one_live_personal; the added tables/columns can stay.

ALTER TABLE qphone_numbers ADD COLUMN IF NOT EXISTS authority_version bigint NOT NULL DEFAULT 1;
ALTER TABLE qphone_numbers ADD COLUMN IF NOT EXISTS state_before_release text;
ALTER TABLE qphone_numbers ADD COLUMN IF NOT EXISTS hold_reason text;      -- non-null = the carrier outcome is UNCERTAIN: no reassignment, no reuse, until reconciled

-- Accounts as the main app reports them (verified / suspended / organization). Reassignment and caller-ID verification read ONLY this, never a client claim. Missing row = unknown = refused.
CREATE TABLE IF NOT EXISTS qphone_accounts (
  account_id text PRIMARY KEY, verified boolean NOT NULL DEFAULT false, suspended boolean NOT NULL DEFAULT false, org_id text, updated_at timestamptz NOT NULL DEFAULT now()
);

-- A durable record of every carrier call that changes something, written BEFORE the call. A timeout or error never means "it did not happen": it leaves the operation 'uncertain' until reconciled.
CREATE TABLE IF NOT EXISTS qphone_provider_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('provision','release')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','in_flight','confirmed','failed','uncertain')),
  number_id uuid REFERENCES qphone_numbers(id), provider_number_id text, e164 text, request_id uuid,
  attempts int NOT NULL DEFAULT 0, last_error text, actor_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS qphone_ops_one_open_release ON qphone_provider_operations (number_id) WHERE kind = 'release' AND state IN ('pending','in_flight','uncertain');
CREATE INDEX IF NOT EXISTS qphone_ops_open ON qphone_provider_operations (state) WHERE state IN ('pending','in_flight','uncertain');

-- At-least-once outbox: one row per number change, committed in the SAME transaction as the change. (provider_number_id, version) is unique and strictly increasing per number.
CREATE TABLE IF NOT EXISTS qphone_number_outbox (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_number_id text NOT NULL, version bigint NOT NULL, type text NOT NULL CHECK (type IN ('number.changed','number.snapshot')),
  payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz, attempts int NOT NULL DEFAULT 0, last_error text, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_number_id, version)
);
CREATE INDEX IF NOT EXISTS qphone_outbox_undelivered ON qphone_number_outbox (provider_number_id, version) WHERE delivered_at IS NULL;

CREATE OR REPLACE FUNCTION qphone_numbers_authority_before() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN NEW.authority_version := 1; RETURN NEW; END IF;
  IF NEW.provider_number_id IS DISTINCT FROM OLD.provider_number_id OR NEW.e164 IS DISTINCT FROM OLD.e164 OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.country IS DISTINCT FROM OLD.country THEN
    RAISE EXCEPTION 'number identity is immutable' USING ERRCODE = '23514'; END IF;
  IF OLD.state = 'released' AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.assigned_to IS DISTINCT FROM OLD.assigned_to) THEN RAISE EXCEPTION 'a released number is final' USING ERRCODE = '23514'; END IF;
  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to AND (OLD.hold_reason IS NOT NULL OR OLD.state IN ('provisioning','releasing','released')) THEN
    RAISE EXCEPTION 'number is locked (uncertain provider outcome or release in progress)' USING ERRCODE = '23514'; END IF;
  IF NEW.kind = 'dialin' AND NEW.assigned_to IS NOT NULL THEN RAISE EXCEPTION 'a shared dial-in number cannot be assigned to a person' USING ERRCODE = '23514'; END IF;
  IF (NEW.state, NEW.assigned_to, NEW.caller_id_verified, NEW.hold_reason) IS DISTINCT FROM (OLD.state, OLD.assigned_to, OLD.caller_id_verified, OLD.hold_reason) THEN NEW.authority_version := OLD.authority_version + 1;
  ELSE NEW.authority_version := OLD.authority_version; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION qphone_numbers_authority_after() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.authority_version IS DISTINCT FROM OLD.authority_version THEN
    INSERT INTO qphone_number_outbox(provider_number_id, version, type, payload) VALUES (NEW.provider_number_id, NEW.authority_version, 'number.changed',
      jsonb_build_object('providerNumberId', NEW.provider_number_id, 'e164', NEW.e164, 'country', NEW.country, 'kind', NEW.kind, 'accountId', NEW.assigned_to, 'state', NEW.state,
        'callerIdVerified', NEW.caller_id_verified, 'hold', NEW.hold_reason IS NOT NULL, 'version', NEW.authority_version));
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS qphone_numbers_authority_b ON qphone_numbers;
CREATE TRIGGER qphone_numbers_authority_b BEFORE INSERT OR UPDATE ON qphone_numbers FOR EACH ROW EXECUTE FUNCTION qphone_numbers_authority_before();
DROP TRIGGER IF EXISTS qphone_numbers_authority_a ON qphone_numbers;
CREATE TRIGGER qphone_numbers_authority_a AFTER INSERT OR UPDATE ON qphone_numbers FOR EACH ROW EXECUTE FUNCTION qphone_numbers_authority_after();

-- Numbers that existed before this migration get a SNAPSHOT event at their current version (never overwritten, never duplicated).
INSERT INTO qphone_number_outbox(provider_number_id, version, type, payload)
SELECT provider_number_id, authority_version, 'number.snapshot', jsonb_build_object('providerNumberId', provider_number_id, 'e164', e164, 'country', country, 'kind', kind, 'accountId', assigned_to, 'state', state,
  'callerIdVerified', caller_id_verified, 'hold', hold_reason IS NOT NULL, 'version', authority_version) FROM qphone_numbers ON CONFLICT (provider_number_id, version) DO NOTHING;

-- Duplicate personal assignments that already exist are listed for an operator; the unique rule starts only when there are none.
CREATE TABLE IF NOT EXISTS qphone_assignment_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id text NOT NULL, number_ids uuid[] NOT NULL, detected_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz, resolution text
);
DO $$
DECLARE dup int;
BEGIN
  INSERT INTO qphone_assignment_conflicts(account_id, number_ids)
    SELECT assigned_to, array_agg(id) FROM qphone_numbers WHERE kind = 'personal' AND assigned_to IS NOT NULL AND state IN ('provisioning','active','suspended','releasing') GROUP BY assigned_to HAVING count(*) > 1
    AND NOT EXISTS (SELECT 1 FROM qphone_assignment_conflicts c WHERE c.account_id = assigned_to AND c.resolved_at IS NULL);
  SELECT count(*) INTO dup FROM qphone_assignment_conflicts WHERE resolved_at IS NULL;
  IF dup = 0 THEN CREATE UNIQUE INDEX IF NOT EXISTS qphone_one_live_personal ON qphone_numbers (assigned_to) WHERE kind = 'personal' AND assigned_to IS NOT NULL AND state IN ('provisioning','active','suspended','releasing');
  ELSE RAISE NOTICE 'qphone_one_live_personal NOT created: % unresolved duplicate assignment(s) in qphone_assignment_conflicts; resolve them (reassign or release) and re-run this migration', dup; END IF;
END $$;

-- The audit trail is append-only for EVERY role (including the owner unless the trigger is dropped, which is itself a privileged, visible act). TRUNCATE is blocked too.
CREATE OR REPLACE FUNCTION qphone_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'qphone_audit is append-only'; END $$;
DROP TRIGGER IF EXISTS qphone_audit_no_change ON qphone_audit;
CREATE TRIGGER qphone_audit_no_change BEFORE UPDATE OR DELETE OR TRUNCATE ON qphone_audit FOR EACH STATEMENT EXECUTE FUNCTION qphone_audit_append_only();
