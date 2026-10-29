// Delivery of Numbers & Plans authority events to the voice engine. Authenticated with a SHORT-LIVED WORKLOAD CREDENTIAL (ES256 JWT: issuer, audience qorlla-shield, one-time jti, 2 minute life),
// never a shared secret. At-least-once: a failed delivery is retried by the outbox; the engine de-duplicates by event id and orders by per-number version.
import crypto from 'node:crypto';

const b64 = (b) => Buffer.from(b).toString('base64url');
export function signWorkloadJwt({ privateKeyPem, kid = 'w1', issuer, subject, audience = 'qorlla-shield', ttlSeconds = 120, now = Math.floor(Date.now() / 1000) }) {
  const head = b64(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid })), body = b64(JSON.stringify({ iss: issuer, sub: subject, aud: audience, iat: now, exp: now + ttlSeconds, jti: crypto.randomUUID() + crypto.randomUUID() }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: privateKeyPem, dsaEncoding: 'ieee-p1363' });
  return head + '.' + body + '.' + b64(sig);
}

/** sink(event) for TelephonyService.deliverOutbox. Resolves only when the engine ACKNOWLEDGED the event (accepted, duplicate or stale); anything else throws so the outbox retries. */
export function createEngineSink({ url, privateKeyPem, issuer, subject = 'svc:numbers-plans', kid, fetchImpl = fetch, timeoutMs = 5000 }) {
  const base = String(url).replace(/\/+$/, '');
  const post = async (path, body) => {
    const r = await fetchImpl(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signWorkloadJwt({ privateKeyPem, kid, issuer, subject }) }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const data = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error('engine_refused_' + r.status), { status: r.status }); return data;
  };
  const sink = async (event) => { const out = await post('/v1/shield/numbers/events', event); if (!['applied', 'duplicate', 'stale'].includes(out.result)) throw new Error('engine_result_' + out.result); return out; };
  sink.reconcile = (snapshot) => post('/v1/shield/numbers/reconcile', { numbers: snapshot });
  return sink;
}

/** Background dispatcher: deliver the outbox, ask the carrier about unresolved operations, and hand the consumer a full snapshot now and then so a lost event can never leave it wrong. */
export function startNumberSync({ svc, sink, intervalMs = 2000, reconcileEveryMs = 60000, snapshotEveryMs = 300000, log = console }) {
  let lastRec = 0, lastSnap = 0, busy = false;
  const t = setInterval(async () => {
    if (busy) return; busy = true;
    try {
      await svc.deliverOutbox(sink);
      const now = Date.now();
      if (now - lastRec > reconcileEveryMs) { lastRec = now; await svc.reconcileOperations(); }
      if (sink.reconcile && now - lastSnap > snapshotEveryMs) { lastSnap = now; await sink.reconcile(await svc.numberSnapshot()); }
    } catch (e) { log.error('[number-sync]', e.code || '', e.message); } finally { busy = false; }
  }, intervalMs);
  t.unref(); return () => clearInterval(t);
}
