-- Qorlla Subscription Access - 008 unified billing (Stripe Billing + RevenueCat)
-- (1) a customer is PERSONAL or an ORGANIZATION: personal subscriptions and organization-owned licences never mix
-- (2) checkout intents: at most ONE open checkout per customer, so two clicks / two devices cannot start two subscriptions
-- (3) a narrow, audited way for the trusted checkout gateway (not a webhook) to link a provider customer to the customer of an open intent

ALTER TABLE customers ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'organization' CHECK (kind IN ('personal','organization'));

CREATE TABLE IF NOT EXISTS checkout_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  provider text NOT NULL CHECK (provider IN ('stripe','revenuecat')),
  plan_code text NOT NULL REFERENCES plans(code),
  requested_by text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','expired','canceled')),
  external_customer_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS checkout_one_open_per_customer ON checkout_intents (customer_id) WHERE status = 'open';

-- Cross-provider identity of the PURCHASE (not of the webhook): Stripe's subscription id is also what RevenueCat reports as the
-- original transaction id for a Stripe-sourced purchase. One underlying purchase can therefore only ever be applied once.
CREATE TABLE IF NOT EXISTS purchase_identities (
  source text NOT NULL CHECK (source IN ('stripe','app_store','play_store')),
  source_id text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 200),
  customer_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_id)
);

-- The gateway links the provider customer it just created to the customer of the intent it just opened. The function checks
-- that the intent is open and unexpired, and never overwrites an existing link to a DIFFERENT customer.
CREATE OR REPLACE FUNCTION qorlla_link_checkout_customer(p_intent uuid, p_external text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = subscription_access, pg_catalog AS $$
DECLARE i checkout_intents%ROWTYPE;
BEGIN
  SELECT * INTO i FROM checkout_intents WHERE id = p_intent AND status = 'open' AND expires_at > now() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'checkout intent is not open' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO billing_customers (provider, external_customer_id, customer_id, linked_by)
  VALUES (i.provider, p_external, i.customer_id, 'checkout-gateway:' || i.requested_by)
  ON CONFLICT (provider, external_customer_id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM billing_customers WHERE provider = i.provider AND external_customer_id = p_external AND customer_id = i.customer_id) THEN
    RAISE EXCEPTION 'provider customer is already linked to another customer' USING ERRCODE = 'unique_violation';
  END IF;
  UPDATE checkout_intents SET external_customer_id = p_external WHERE id = p_intent;
END $$;
REVOKE ALL ON FUNCTION qorlla_link_checkout_customer(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qorlla_link_checkout_customer(uuid, text) TO qorlla_sub_billing;

GRANT SELECT ON customers, customer_members TO qorlla_sub_billing;
GRANT SELECT, INSERT, UPDATE ON checkout_intents TO qorlla_sub_billing;
GRANT SELECT, INSERT ON purchase_identities TO qorlla_sub_billing;
GRANT SELECT ON checkout_intents, purchase_identities TO qorlla_sub_runtime, qorlla_sub_ops;

-- A personal account is ONE person: a single member (its owner), at most one personal account per user, and its kind never changes
-- (otherwise a personal subscription could be turned into a shared organization licence, or the reverse, by editing a row).
CREATE UNIQUE INDEX IF NOT EXISTS one_personal_customer_per_user ON customers (created_by) WHERE kind = 'personal';

CREATE OR REPLACE FUNCTION qorlla_personal_single_member() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = subscription_access, pg_catalog AS $$
BEGIN
  IF (SELECT kind FROM customers WHERE id = NEW.customer_id) = 'personal'
     AND EXISTS (SELECT 1 FROM customer_members WHERE customer_id = NEW.customer_id) THEN
    RAISE EXCEPTION 'a personal account has exactly one member' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS personal_single_member ON customer_members;
CREATE TRIGGER personal_single_member BEFORE INSERT ON customer_members FOR EACH ROW EXECUTE FUNCTION qorlla_personal_single_member();

CREATE OR REPLACE FUNCTION qorlla_customer_kind_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN RAISE EXCEPTION 'customers.kind is immutable' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS customer_kind_immutable ON customers;
CREATE TRIGGER customer_kind_immutable BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION qorlla_customer_kind_immutable();
REVOKE ALL ON FUNCTION qorlla_personal_single_member() FROM PUBLIC;
