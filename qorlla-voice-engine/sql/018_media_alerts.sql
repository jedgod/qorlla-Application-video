-- A3.7.1: a suspension or revocation that could not end the account's MEDIA (TURN credentials not deleted, or live relay allocations not cancelled) becomes a critical alert, like a signaling termination failure.
-- Only the classification changes; the trigger (016) is unchanged and keeps pointing at this function.
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
    WHEN NEW.reason = 'MEDIA_TERMINATION_FAILED' THEN 'media_termination_failure'
    ELSE NULL END;
  IF k IS NULL THEN RETURN NULL; END IF;
  sev := CASE k WHEN 'revoked_certificate_attempt' THEN 'critical' WHEN 'unauthorized_suspension_attempt' THEN 'critical' WHEN 'unauthorized_certificate_revocation' THEN 'critical'
    WHEN 'signaling_termination_failure' THEN 'critical' WHEN 'media_termination_failure' THEN 'critical' WHEN 'certificate_failure' THEN 'medium' ELSE 'high' END;
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
