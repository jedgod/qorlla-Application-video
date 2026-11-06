/**
 * Integration example. There is deliberately NO default authentication: you must supply `authenticate`.
 *
 *   authenticate(req) -> { customer_id, user_id } | null
 *
 * It MUST verify the session before returning anything: JWT signature, issuer, audience and expiry, that the session is
 * still live (not revoked), and that the user belongs to the organization whose customer_id is returned. Never derive
 * customer_id from a header, query string, URL parameter or request body.
 */

import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { respondWithAccessError } from '../src/middleware.js';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createExampleApp({ service, middleware, billing, authenticate, internalToken }) {
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

  // Capacity features: pure limit checks (admission).
  app.post('/api/meetings',
    middleware.requireFeature('meetings.participants', { quantity: (req) => Number(req.body?.max_participants) || 1 }),
    middleware.requireFeature('meetings.duration_minutes', { quantity: (req) => Number(req.body?.duration_minutes) || 30 }),
    (req, res) => res.status(201).json({ plan: req.subscription.plan }));

  // Consumption features: reserve -> work -> commit, release on failure, never both.
  app.post('/api/ai/summaries', async (req, res) => {
    const key = req.get('idempotency-key');
    if (!key) return res.status(400).json({ error: 'idempotency_key_required' });
    let reservation; let committed = false;
    try {
      reservation = await middleware.reserve(req, 'ai.meeting_summaries', 1, { idempotencyKey: `${req.auth.user_id}:${key}`, metadata: { meeting_id: req.body?.meeting_id } });
      if (!reservation.allowed) return res.status(reservation.reason === 'subscription_inactive' ? 402 : 403).json({ error: 'subscription_required', code: reservation.reason });
      if (reservation.replay) return res.status(200).json({ ok: true, replay: true, status: reservation.status });

      // ... the expensive work happens here (renew with middleware.renewReservation for long jobs) ...

      if (reservation.reservationId) {
        const done = await middleware.commitReservation(req, reservation.reservationId);
        committed = done.ok;
      }
      return res.status(201).json({ ok: true, remaining: reservation.remaining });
    } catch (err) {
      return respondWithAccessError(res, err);
    } finally {
      // A replay belongs to the original request, which may still be running: never release someone else's reservation.
      if (reservation?.reservationId && !reservation.replay && !committed) await middleware.releaseReservation(req, reservation.reservationId).catch(() => {});
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
