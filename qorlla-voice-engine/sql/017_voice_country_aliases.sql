-- Country-aware internal aliases (A3.7). An alias is a Qorlla-ONLY, national-style number for an account that is reachable by other Qorlla accounts of the same confirmed country inside the same tenant.
-- It is NOT a telephone number: it is never reachable from a phone network, never routed to a carrier, never billable. The globally unique EXTENSION in voice_identities stays the authoritative routing identity;
-- this table is an INDEX from an alias to that extension, not a second authority. Retired aliases are kept FOREVER and their digits are never issued again. Idempotent; run with the migration role.
CREATE TABLE IF NOT EXISTS voice_country_confirmations (
  account_id text PRIMARY KEY REFERENCES voice_identities(account_id),
  iso_country char(2) NOT NULL CHECK (iso_country ~ '^[A-Z]{2}$'),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  confirmations integer NOT NULL DEFAULT 1                -- an explicit user choice; never derived from an IP address, a header or the browser's locale
);
CREATE TABLE IF NOT EXISTS voice_country_aliases (
  alias_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL REFERENCES voice_identities(account_id),
  extension text NOT NULL REFERENCES voice_identities(extension),
  iso_country char(2) NOT NULL CHECK (iso_country ~ '^[A-Z]{2}$'),
  canonical_national text NOT NULL UNIQUE CHECK (canonical_national ~ '^[0-9]{9,15}$'),     -- 9-15 digits can never be confused with an extension (3-8 digits); UNIQUE over ALL rows, retired included: never reused
  display_national text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz, retired_by text, retire_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS voice_alias_one_active ON voice_country_aliases (account_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS voice_alias_lookup ON voice_country_aliases (iso_country, canonical_national) WHERE status = 'active';

-- Aliases are never deleted, never moved to another account/extension/country, never un-retired.
CREATE OR REPLACE FUNCTION voice_alias_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.extension IS DISTINCT FROM OLD.extension OR NEW.iso_country IS DISTINCT FROM OLD.iso_country OR NEW.canonical_national IS DISTINCT FROM OLD.canonical_national OR NEW.display_national IS DISTINCT FROM OLD.display_national THEN RAISE EXCEPTION 'an alias is immutable' USING ERRCODE = '23514'; END IF;
    IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN RAISE EXCEPTION 'a retired alias is final' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'aliases are never deleted' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS voice_alias_no_change ON voice_country_aliases;
CREATE TRIGGER voice_alias_no_change BEFORE UPDATE ON voice_country_aliases FOR EACH ROW EXECUTE FUNCTION voice_alias_guard();
DROP TRIGGER IF EXISTS voice_alias_no_delete ON voice_country_aliases;
CREATE TRIGGER voice_alias_no_delete BEFORE DELETE OR TRUNCATE ON voice_country_aliases FOR EACH STATEMENT EXECUTE FUNCTION voice_alias_guard();
