/**
 * Integration example. There is deliberately NO default authentication: you must supply `authenticate`.
 *
 *   authenticate(req) -> { customer_id, user_id } | null
 *
 * It MUST verify the session before returning anything: JWT signature, issuer, audience and expiry, that the session is
 * still live (not revoked), and that the user belongs to the organization whose customer_id is returned. Never derive
 * customer_id from a header, query string, URL parameter or request body.
 *
 * METERED OPERATIONS (POST /api/ai/summaries) follow one protocol, stored in PostgreSQL so it holds across restarts and across
 * any number of application instances:
 *
 *   first request   reserve -> run the work ONCE -> commit (storing the response) -> 201 with the response
 *   retry, original finished     -> the STORED response, replayed (header Idempotent-Replay: true). The work does not run again.
 *   retry, original still running -> 409 request_in_progress (+ Retry-After). Never a success, the work does not run again.
 *   retry, original failed/abandoned -> 409 previous_attempt_failed. Never a success; the caller uses a NEW Idempotency-Key.
 *   same key, different request   -> 409 idempotency_key_conflict
 *
 * COUNTS (max_participants, duration_minutes) are required, whole numbers; there is no fallback to a default. The number that
 * is checked against the plan is exactly the number the handler uses (`req.validated`).
 */

import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { respondWithAccessError } from '../src/middleware.js';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * @param {object} deps
 * @param {(req) => Promise<object>} [deps.work]  the protected operation; its return value becomes the stored response body
 */
export function createExampleApp({ service, middleware, billing, authenticate, internalToken, work = async () => ({ summary: 'done' }) }) {
  if (typeof authenticate !== 'function') throw new Error('authenticate(req) is required: there is no safe default');
  if (typeof internalToken !== 'string' || internalToken.length < 32) throw new Error('internalToken (32+ characters) is required for service-to-service routes');

  const app = express();
  app.disable('x-powered-by');

  // -------------------------------------------------------------------------
  // Webhooks: the RAW body is needed to verify the signature, so this route is mounted BEFORE any JSON parser.
  // -------------------------------------------------------------------------
  app.post('/webhooks/:provider', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    try {
      const out = await billing.ingest({ provider: req.params.provider, rawBody: req.body, headers: req.headers });
      res.status(200).json({ status: out.status });                      // 200 for duplicate/stale too: the provider must stop retrying
    } catch (err) {
      respondWithAccessError(res, err);                                  // 401 bad signature, 400 bad event, 503 retry later
    }
  });

  app.use(express.json({ limit: '100kb' }));

  app.use(async (req, res, next) => {
    try {
      const who = await authenticate(req);
      if (!who?.customer_id) return res.status(401).json({ error: 'unauthenticated' });
      req.auth = { customer_id: who.customer_id, user_id: who.user_id };
      return next();
    } catch (err) {
      return respondWithAccessError(res, err);
    }
  });

  // Capacity features: both counts are REQUIRED and strictly validated (400 otherwise); the handler uses the validated numbers.
  app.post('/api/meetings',
    middleware.requireFeature('meetings.participants', { quantity: (req) => req.body?.max_participants }),
    middleware.requireFeature('meetings.duration_minutes', { quantity: (req) => req.body?.duration_minutes }),
    (req, res) => res.status(201).json({
      plan: req.subscription.plan,
      participants: req.validated['meetings.participants'],            // exactly what was checked
      duration_minutes: req.validated['meetings.duration_minutes'],
    }));

  // Consumption feature: reserve -> work -> commit, with the replay protocol described above.
  app.post('/api/ai/summaries', async (req, res) => {
    const key = req.get('idempotency-key');
    if (!key || key.length > 150) return res.status(400).json({ error: 'idempotency_key_required' });
    let reservation; let committed = false; let workDone = false;
    try {
      reservation = await middleware.reserve(req, 'ai.meeting_summaries', 1, { idempotencyKey: `${req.auth.user_id}:${key}`, metadata: { meeting_id: req.body?.meeting_id } });

      if (reservation.replay) {
        if (reservation.status === 'committed') {
          const stored = reservation.result || { status: 200, body: { ok: true } };
          return res.status(stored.status).set('Idempotent-Replay', 'true').json(stored.body);
        }
        if (reservation.status === 'reserved') return res.status(409).set('Retry-After', '2').json({ error: 'request_in_progress' });
        return res.status(409).json({ error: 'previous_attempt_failed', hint: 'send a new Idempotency-Key' });
      }
      if (!reservation.allowed) {
        return res.status(reservation.reason === 'subscription_inactive' ? 402 : 403).json({ error: 'subscription_required', code: reservation.reason });
      }

      // ... the expensive work runs here, once. Long jobs: middleware.renewReservation(req, id) ...
      let output;
      try { output = await work(req); } catch {
        // Give the quota back BEFORE answering, so a client that retries at once never sees a stale "in progress".
        await middleware.releaseReservation(req, reservation.reservationId).catch(() => {});
        return res.status(500).json({ error: 'operation_failed' });
      }
      workDone = true;                                                  // from here the quota is spent: it must be committed, never released
      const body = { ok: true, ...output };
      let done;
      for (let attempt = 1; attempt <= 3 && !done?.ok; attempt++) {     // a transient database error must not lose the usage
        try { done = await middleware.commitReservation(req, reservation.reservationId, { metadata: { result: { status: 201, body } } }); } catch (e) { if (attempt === 3) throw e; await new Promise((r) => setTimeout(r, 100 * attempt)); }
      }
      committed = done.ok;
      if (!committed) return res.status(409).json({ error: 'previous_attempt_failed' });   // the reservation was lost; nothing was recorded
      return res.status(201).json(body);
    } catch (err) {
      return respondWithAccessError(res, err);
    } finally {
      // A replay belongs to the original request, which may still be running: never release someone else's reservation.
      // If the work finished but the commit could not be recorded, the hold is KEPT (it expires on its own): releasing would be a free ride.
      if (reservation?.reservationId && !reservation.replay && !committed && !workDone) await middleware.releaseReservation(req, reservation.reservationId).catch(() => {});
    }
  });

  // Entitled is not enabled: the operational PSTN gate is checked by the service as well.
  app.post('/api/phone/pstn/enable', middleware.requireFeature('phone.pstn'), (_req, res) => res.json({ entitled: true }));

  // Entitlements for the UI.
  app.get('/api/me/entitlements', middleware.loadSubscription(), (req, res) => {
    const { plan, status, entitled, features } = req.subscription;
    const publicFeatures = { ...features };
    delete publicFeatures.__plan; delete publicFeatures.__status; delete publicFeatures.__entitled;
    res.json({ plan, status, entitled, features: publicFeatures });
  });

  // Service-to-service only: cache invalidation after an administrative change. Not reachable with a user session.
  app.post('/internal/subscriptions/:customerId/refresh', (req, res) => {
    if (!safeEqual(req.get('x-internal-token') || '', internalToken)) return res.status(401).json({ error: 'unauthorized' });
    service.invalidate(req.params.customerId);
    return res.json({ ok: true });
  });

  return app;
}

export default createExampleApp;
