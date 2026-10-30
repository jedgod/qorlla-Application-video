-- Durable security alerts (A3.5). NOT a second event authority: every alert is DERIVED, inside the same transaction, from a row written to the append-only shield_events table by the existing security paths.
-- The alert row is the operational view (severity, context, occurrence count, first/last, acknowledgement, escalation); the evidence stays in shield_events. Notifications to people/systems go through a
-- transactional outbox (shield_alert_outbox), delivered at least once with retry, exactly like the engine's other outboxes. Idempotent.
ALTER TABLE shield_events ADD COLUMN IF NOT EXISTS context jsonb;      -- workload / tenant / ip / scope / discriminator; never secrets, tokens or passcodes

CREATE TABLE IF NOT EXISTS shield_alerts (
  alert_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  dedupe_key text NOT NULL,                       -- kind + who/where (workload, account, ip) + tenant + discriminator: distinct incidents never share a key
  workload text, account text, tenant text, source_ip text, detail jsonb,
  first_event_id bigint NOT NULL, last_event_id bigint NOT NULL,
  occurrences integer NOT NULL DEFAULT 1,
  first_at timestamptz NOT NULL DEFAULT now(), last_at timestamptz NOT NULL DEFAULT now(),
  ack_state text NOT NULL DEFAULT 'open' CHECK (ack_state IN ('open','acknowledged','resolved')),
  open_since timestamptz NOT NULL DEFAULT now(),  -- start of the current unacknowledged stretch (reset when an acknowledged alert recurs)
  acknowledged_by text, acknowledged_at timestamptz, ack_note text, reopen_count integer NOT NULL DEFAULT 0,
  resolved_by text, resolved_at timestamptz,
  escalation text NOT NULL DEFAULT 'none' CHECK (escalation IN ('none','pending','escalated')),
  escalated_at timestamptz
);
-- one ACTIVE alert per incident key; a resolved alert is history and the next occurrence opens a new one
CREATE UNIQUE INDEX IF NOT EXISTS shield_alerts_one_active ON shield_alerts (dedupe_key) WHERE ack_state <> 'resolved';
CREATE INDEX IF NOT EXISTS shield_alerts_state ON shield_alerts (ack_state, severity, last_at DESC);

CREATE TABLE IF NOT EXISTS shield_alert_outbox (
  notification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id uuid NOT NULL REFERENCES shield_alerts(alert_id),
  kind text NOT NULL CHECK (kind IN ('opened','reopened','severity_raised','escalated')),
  payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz, attempts integer NOT NULL DEFAULT 0, last_error text, next_attempt_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shield_alert_outbox_due ON shield_alert_outbox (next_attempt_at) WHERE delivered_at IS NULL;

CREATE OR REPLACE FUNCTION shield_sev_rank(s text) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT CASE s WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END $$;
CREATE OR REPLACE FUNCTION shield_sev_name(r int) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN r >= 4 THEN 'critical' WHEN r = 3 THEN 'high' WHEN r = 2 THEN 'medium' ELSE 'low' END $$;

CREATE OR REPLACE FUNCTION shield_alert_from_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text; sev text; wl text; acct text; tn text; ip text; disc text; dkey text; cur shield_alerts%ROWTYPE; newsev text; esc text; ntf text; id uuid;
BEGIN
  IF NEW.decision NOT IN ('DENY','ALERT') THEN RETURN NULL; END IF;
  k := CASE
    WHEN NEW.reason = 'CERT_REVOKED' THEN 'revoked_certificate_attempt'
    WHEN NEW.reason IN ('CERT_BINDING_MISMATCH','CERT_BINDING_MISSING','CERT_MISSING','CERT_PROOF_FAILED') THEN 'workload_token_binding_failure'
    WHEN NEW.reason = 'TLS_HANDSHAKE_REFUSED' THEN 'certificate_failure'
    WHEN NEW.reason = 'WORKLOAD_REPLAY' THEN 'workload_replay_rejected'
    WHEN NEW.reason = 'WORKLOAD_NOT_AUTHORIZED' AND NEW.action = 'workload.shield.suspend' THEN 'unauthorized_suspension_attempt'
    WHEN NEW.reason = 'WORKLOAD_NOT_AUTHORIZED' AND NEW.action = 'workload.shield.cert.revoke' THEN 'unauthorized_certificate_revocation'
    WHEN NEW.reason = 'WORKLOAD_NOT_AUTHORIZED' THEN 'workload_not_authorized'
    WHEN NEW.reason = 'CROSS_TENANT' THEN 'cross_tenant_attempt'
    WHEN NEW.reason = 'SIGNALING_TERMINATION_FAILED' THEN 'signaling_termination_failure'
    WHEN NEW.reason = 'OUTBOX_DELIVERY_FAILED' THEN 'outbox_delivery_failure'
    ELSE NULL END;
  IF k IS NULL THEN RETURN NULL; END IF;
  sev := CASE k WHEN 'revoked_certificate_attempt' THEN 'critical' WHEN 'unauthorized_suspension_attempt' THEN 'critical' WHEN 'unauthorized_certificate_revocation' THEN 'critical'
    WHEN 'signaling_termination_failure' THEN 'critical' WHEN 'certificate_failure' THEN 'medium' ELSE 'high' END;
  wl := COALESCE(NEW.context->>'workload', CASE WHEN NEW.action LIKE 'workload.%' OR NEW.action LIKE 'numbers.%' THEN NEW.actor END);
  acct := CASE WHEN wl IS NULL THEN NEW.actor END; tn := NEW.context->>'tenant'; ip := NEW.context->>'ip'; disc := COALESCE(NEW.context->>'discriminator', '');
  dkey := k || '|' || COALESCE(wl, acct, ip, '') || '|' || COALESCE(tn, '') || '|' || disc;
  LOOP
    UPDATE shield_alerts SET occurrences = occurrences + 1, last_at = NEW.at, last_event_id = NEW.id,
      severity = shield_sev_name(GREATEST(shield_sev_rank(severity), shield_sev_rank(sev), CASE WHEN occurrences + 1 >= 50 THEN 4 WHEN occurrences + 1 >= 10 THEN 3 ELSE 1 END)),
      reopen_count = reopen_count + CASE WHEN ack_state = 'acknowledged' THEN 1 ELSE 0 END,
      open_since = CASE WHEN ack_state = 'acknowledged' THEN NEW.at ELSE open_since END,
      escalation = CASE WHEN ack_state = 'acknowledged' THEN 'pending' ELSE escalation END,
      ack_state = 'open'
      WHERE dedupe_key = dkey AND ack_state <> 'resolved' RETURNING * INTO cur;
    IF FOUND THEN
      -- a recurrence after acknowledgement is announced again; a rising severity is announced; plain repeats are counted silently (deduplicated)
      IF cur.reopen_count > 0 AND cur.ack_state = 'open' AND cur.open_since = NEW.at THEN ntf := 'reopened';
      ELSIF shield_sev_rank(cur.severity) > shield_sev_rank(sev) AND cur.occurrences IN (10, 50) THEN ntf := 'severity_raised'; END IF;
      IF ntf IS NOT NULL THEN INSERT INTO shield_alert_outbox(alert_id, kind, payload) VALUES (cur.alert_id, ntf, to_jsonb(cur)); END IF;
      RETURN NULL;
    END IF;
    BEGIN
      esc := CASE WHEN shield_sev_rank(sev) >= 3 THEN 'pending' ELSE 'none' END;
      INSERT INTO shield_alerts(kind, severity, dedupe_key, workload, account, tenant, source_ip, detail, first_event_id, last_event_id, first_at, last_at, open_since, escalation)
        VALUES (k, sev, dkey, wl, acct, tn, ip, NEW.context - 'workload' - 'tenant' - 'ip', NEW.id, NEW.id, NEW.at, NEW.at, NEW.at, esc) RETURNING * INTO cur;
      INSERT INTO shield_alert_outbox(alert_id, kind, payload) VALUES (cur.alert_id, 'opened', to_jsonb(cur));
      RETURN NULL;
    EXCEPTION WHEN unique_violation THEN NULL;       -- a concurrent event opened it first: loop and count this one
    END;
  END LOOP;
END $$;
DROP TRIGGER IF EXISTS shield_events_alert ON shield_events;
CREATE TRIGGER shield_events_alert AFTER INSERT ON shield_events FOR EACH ROW EXECUTE FUNCTION shield_alert_from_event();
