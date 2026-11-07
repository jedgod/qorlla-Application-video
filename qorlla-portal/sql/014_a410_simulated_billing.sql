-- Staging-only journal; entries in these tables are not financial postings.
BEGIN;
CREATE TABLE portal.a410_simulated_tariffs (
  version text PRIMARY KEY,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  destination text NOT NULL,
  rate_micro_minor_per_second bigint NOT NULL CHECK (rate_micro_minor_per_second >= 0),
  minimum_minor bigint NOT NULL CHECK (minimum_minor >= 0),
  connection_minor bigint NOT NULL CHECK (connection_minor >= 0),
  approved_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE portal.a410_simulated_journal (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  call_id uuid NOT NULL UNIQUE REFERENCES portal.a49_call_refs(meet_call_id),
  workspace_id uuid NOT NULL,
  tariff_version text NOT NULL REFERENCES portal.a410_simulated_tariffs(version),
  duration_ms bigint NOT NULL CHECK (duration_ms >= 0),
  seconds bigint NOT NULL CHECK (seconds >= 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (call_id, workspace_id) REFERENCES portal.a49_call_refs(meet_call_id, workspace_id)
);
CREATE TABLE portal.a410_simulated_postings (
  journal_id uuid NOT NULL REFERENCES portal.a410_simulated_journal(id),
  account text NOT NULL CHECK (account IN ('customer', 'simulated_revenue')),
  amount_minor bigint NOT NULL,
  PRIMARY KEY (journal_id, account)
);
CREATE FUNCTION portal.a410_simulated_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'simulated accounting records are immutable';
END $$;
CREATE TRIGGER a410_tariff_immutable BEFORE UPDATE OR DELETE ON portal.a410_simulated_tariffs
  FOR EACH ROW EXECUTE FUNCTION portal.a410_simulated_immutable();
CREATE TRIGGER a410_journal_immutable BEFORE UPDATE OR DELETE ON portal.a410_simulated_journal
  FOR EACH ROW EXECUTE FUNCTION portal.a410_simulated_immutable();
CREATE TRIGGER a410_postings_immutable BEFORE UPDATE OR DELETE ON portal.a410_simulated_postings
  FOR EACH ROW EXECUTE FUNCTION portal.a410_simulated_immutable();
CREATE FUNCTION portal.a410_simulated_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total numeric; n integer; amounts_match boolean;
BEGIN
  SELECT count(*), coalesce(sum(amount_minor), 0),
    bool_and((account = 'customer' AND amount_minor = NEW.amount_minor) OR
             (account = 'simulated_revenue' AND amount_minor = -NEW.amount_minor))
    INTO n, total, amounts_match
    FROM portal.a410_simulated_postings WHERE journal_id = NEW.id;
  IF n <> 2 OR total <> 0 OR amounts_match IS NOT TRUE THEN
    RAISE EXCEPTION 'simulated journal must have two balanced postings matching its amount';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER a410_balanced AFTER INSERT ON portal.a410_simulated_journal
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION portal.a410_simulated_balanced();
COMMIT;
