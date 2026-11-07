-- Qorlla Subscription Access - 005 customer directory
-- The main application has users and sessions but no organizations. This is the tenant model the subscription engine
-- needs: a CUSTOMER (the billing tenant, a UUID) with MEMBERS who hold a role, plus platform STAFF who may administer
-- billing. Membership is read live on every request, so removing someone or changing a role takes effect at once.

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_members (
  customer_id uuid NOT NULL REFERENCES customers(id),
  user_id text NOT NULL CHECK (char_length(user_id) BETWEEN 1 AND 100),
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  added_by text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, user_id)
);
CREATE INDEX IF NOT EXISTS customer_members_user_idx ON customer_members (user_id);

CREATE TABLE IF NOT EXISTS customer_member_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  user_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('add','role_change','remove','customer_created','customer_suspended','customer_reactivated')),
  old_role text,
  new_role text,
  actor text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_member_history_customer_idx ON customer_member_history (customer_id, occurred_at DESC);

-- A customer can never be left without an owner. Enforced HERE, under a per-customer lock, so two concurrent demotions
-- of two different owners cannot both succeed.
CREATE OR REPLACE FUNCTION qorlla_keep_an_owner() RETURNS trigger LANGUAGE plpgsql SET search_path = subscription_access, pg_catalog AS $$
BEGIN
  IF OLD.role = 'owner' AND (TG_OP = 'DELETE' OR NEW.role <> 'owner') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('members:' || OLD.customer_id::text, 0));
    IF NOT EXISTS (SELECT 1 FROM customer_members WHERE customer_id = OLD.customer_id AND role = 'owner' AND user_id <> OLD.user_id) THEN
      RAISE EXCEPTION 'a customer must keep at least one owner' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_members_keep_owner BEFORE UPDATE OR DELETE ON customer_members FOR EACH ROW EXECUTE FUNCTION qorlla_keep_an_owner();

CREATE TRIGGER customer_member_history_immutable_row BEFORE UPDATE OR DELETE ON customer_member_history FOR EACH ROW EXECUTE FUNCTION qorlla_forbid_mutation();
CREATE TRIGGER customer_member_history_immutable_trunc BEFORE TRUNCATE ON customer_member_history FOR EACH STATEMENT EXECUTE FUNCTION qorlla_forbid_mutation();

-- Platform staff may administer billing (overrides, customer links). Staff are managed by the DBA / migrator, not by any
-- application role: who may touch billing is an infrastructure decision, not something the app can grant itself.
CREATE TABLE IF NOT EXISTS platform_staff (
  user_id text PRIMARY KEY CHECK (char_length(user_id) BETWEEN 1 AND 100),
  roles text[] NOT NULL DEFAULT '{}',
  all_customers boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  granted_by text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_staff_customers (
  user_id text NOT NULL REFERENCES platform_staff(user_id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id),
  PRIMARY KEY (user_id, customer_id)
);

-- Grants. Runtime reads the directory; the admin service manages customers and members; nobody but the owner manages staff.
GRANT SELECT ON customers, customer_members TO qorlla_sub_runtime;
GRANT SELECT, INSERT, UPDATE ON customers TO qorlla_sub_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_members TO qorlla_sub_admin;
GRANT SELECT, INSERT ON customer_member_history TO qorlla_sub_admin;
GRANT SELECT ON platform_staff, platform_staff_customers TO qorlla_sub_admin;
