// Qorlla Telephony v2 routes (Meet): server-to-server routes for the main app (bridge secret; the account identity is supplied by the main app from the
// signed-in session, never from a browser) and the carrier's signed webhooks. Capabilities are derived from stored evidence only.
import express from 'express';
import { TelephonyService } from './service.mjs';
import { createCarrier, UnconfiguredBridge, UnconfiguredAudioGateway } from './provider.mjs';
import { voiceTwiml } from './ivr.mjs';
import { normalizeE164 } from './core.mjs';

export function registerTelephony({ app, db, bridgeAuth, phone, env = process.env, carrier = createCarrier(env), bridge = new UnconfiguredBridge(), audio = new UnconfiguredAudioGateway() }) {
  const svc = new TelephonyService({ db, carrier, bridge, audio, env });
  const actorOf = (req) => { const id = String(req.get('x-qorlla-actor') || ''); return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? { id, admin: req.get('x-qorlla-admin') === '1' } : null; };
  const wrap = (fn, code = 200) => async (req, res) => {
    try { res.status(code).set('Cache-Control', 'no-store').json(await fn(req, actorOf(req))); }
    catch (e) { const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500; if (status === 500) console.error('[telephony]', e.code || '', e.message); res.status(status).json({ error: status === 500 ? 'Telephony request failed.' : e.message, code: e.code || 'ERROR' }); }
  };
  const B = '/api/integrations/telephony', json = express.json({ limit: '20kb' });
  app.get(B + '/capabilities', bridgeAuth, wrap((req, a) => svc.capabilities(a && a.id)));
  app.post(B + '/test-connection', bridgeAuth, wrap((req, a) => svc.testConnection(a)));
  app.get(B + '/numbers/available', bridgeAuth, wrap((req, a) => svc.availableNumbers(a, req.query.country, req.query.type)));
  app.post(B + '/numbers/request', bridgeAuth, json, wrap((req, a) => svc.requestNumber(a, req.body || {}), 202));
  app.get(B + '/numbers/requests', bridgeAuth, wrap((req, a) => svc.listRequests(a)));
  app.get(B + '/numbers', bridgeAuth, wrap((req, a) => svc.listNumbers(a, { kind: req.query.kind })));
  app.get(B + '/dial-in', bridgeAuth, wrap(() => svc.dialInDirectory()));
  app.post(B + '/numbers/:id/state', bridgeAuth, json, wrap((req, a) => svc.setNumberState(a, req.params.id, (req.body || {}).state)));
  app.post(B + '/numbers/:id/reassign', bridgeAuth, json, wrap((req, a) => svc.reassignNumber(a, req.params.id, (req.body || {}).to)));
  app.post(B + '/numbers/:id/caller-id', bridgeAuth, json, wrap(async (req, a) => { await svc.setCallerIdVerified(a, req.params.id, (req.body || {}).verified === true); return { ok: true }; }));
  app.post(B + '/calls', bridgeAuth, json, wrap((req, a) => svc.startCall(a, req.body || {}), 202));
  app.get(B + '/calls', bridgeAuth, wrap((req, a) => svc.listCalls(a)));
  app.get(B + '/calls/:id', bridgeAuth, wrap((req, a) => svc.getCall(a, req.params.id)));
  app.post(B + '/calls/:id/end', bridgeAuth, wrap((req, a) => svc.endCall(a, req.params.id)));
  app.get(B + '/usage', bridgeAuth, wrap((req, a) => svc.usage(a)));
  app.post(B + '/usage/:id/adjust', bridgeAuth, json, wrap((req, a) => svc.adjust(a, req.params.id, req.body || {}), 201));
  app.put(B + '/limits/:owner', bridgeAuth, json, wrap((req, a) => svc.setLimit(a, req.params.owner, (req.body || {}).monthlyLimitMicros)));
  app.get(B + '/diagnostics', bridgeAuth, wrap((req, a) => svc.diagnostics(a)));

  // ---- carrier webhooks. Signed with the carrier's own scheme, verified over the URL the carrier was given, de-duplicated by event id, and answered idempotently.
  const form = express.urlencoded({ extended: false, limit: '100kb' }), W = '/api/telephony/webhooks/twilio/';
  async function webhook(req, res, kind) {
    try {
      const pub = String(env.PHONE_PUBLIC_BASE || '').replace(/\/+$/, '');
      if (!carrier.configured || !pub) return res.status(503).type('text/plain').send('Telephony is not configured.');
      if (!carrier.verifyWebhook({ url: pub + req.originalUrl, params: req.body || {}, signature: req.get('x-twilio-signature') })) return res.status(403).type('text/plain').send('Invalid signature.');
      const ev = carrier.parseWebhook(req.body || {}, { ...req.headers, __path: req.originalUrl });
      const ins = await db.query('INSERT INTO qphone_provider_events(provider,provider_event_id,event_type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id', [carrier.name, ev.eventId, kind + ':' + (ev.status || ev.digits ? 'step' : '')]);
      if (!ins.rowCount) { const { rows: [p] } = await db.query('SELECT result FROM qphone_provider_events WHERE provider=$1 AND provider_event_id=$2', [carrier.name, ev.eventId]); return kind === 'voice' ? res.type('text/xml').send(p && p.result ? p.result : '<Response/>') : res.status(204).end(); }
      await svc.markWebhookVerified();
      if (kind === 'status') {
        await svc.applyCallEvent({ providerCallId: ev.providerCallId, status: ev.status, sequence: ev.sequence, duration: ev.duration });
        if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(ev.status)) await phone.endedCall({ callId: ev.providerCallId, type: ev.status }, carrier.name);   // a dial-in caller who hangs up leaves the meeting
        return res.status(204).end();
      }
      const g = await svc.gates(), xml = await voiceTwiml({ db, phone, bridge, audio, params: req.body || {}, query: req.query || {}, base: pub, gateCertified: !!g.bridge && !!g.dialin });
      await db.query('UPDATE qphone_provider_events SET result=$3 WHERE provider=$1 AND provider_event_id=$2', [carrier.name, ev.eventId, xml]); res.type('text/xml').send(xml);
    } catch (e) { console.error('[telephony] webhook failed:', e.code || '', e.message); if (!res.headersSent) res.status(500).type('text/plain').send('Telephony request failed.'); }
  }
  app.post(W + 'voice', form, (req, res) => webhook(req, res, 'voice'));
  app.post(W + 'status', form, (req, res) => webhook(req, res, 'status'));

  // ---- workers: only when a carrier is configured (nothing to do otherwise)
  let timer = null;
  const start = () => { if (!carrier.configured || timer) return; timer = setInterval(() => { svc.tick().catch((e) => console.error('[telephony] tick', e.message)); }, Number(env.PHONE_WORKER_MS || 15000)); timer.unref?.(); };
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  start();
  return { svc, carrier, start, stop, normalizeE164 };
}
