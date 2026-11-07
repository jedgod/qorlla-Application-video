-- A4.9 reporting foundation. A5 Meet remains authoritative for call state.
BEGIN;
CREATE TABLE portal.a49_call_refs (
  meet_call_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES portal.workspaces(id),
  source_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meet_call_id, workspace_id)
);
CREATE TABLE portal.a49_ratings (
  meet_call_id uuid PRIMARY KEY REFERENCES portal.a49_call_refs(meet_call_id),
  seconds bigint NOT NULL CHECK (seconds >= 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  tariff_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE portal.a49_carrier_cdr (
  carrier_id text NOT NULL,
  cdr_id text NOT NULL,
  meet_call_id uuid NOT NULL REFERENCES portal.a49_call_refs(meet_call_id),
  seconds bigint NOT NULL CHECK (seconds >= 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  payload_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (carrier_id, cdr_id)
);
CREATE VIEW portal.a49_reconciliation AS
 SELECT c.carrier_id, c.cdr_id, c.meet_call_id, c.seconds AS carrier_seconds,
        r.seconds AS rated_seconds, c.amount_minor AS carrier_minor, r.amount_minor AS rated_minor,
        CASE WHEN r.meet_call_id IS NULL THEN 'pending'
             WHEN c.currency <> r.currency OR c.amount_minor <> r.amount_minor OR c.seconds <> r.seconds THEN 'disputed'
             ELSE 'matched' END AS result
 FROM portal.a49_carrier_cdr c LEFT JOIN portal.a49_ratings r ON r.meet_call_id = c.meet_call_id;
COMMIT;
