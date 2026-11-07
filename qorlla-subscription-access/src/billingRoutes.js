/**
 * HTTP surface for unified billing (Express). Two routers, mounted by the web tier:
 *
 *  webhookRouter({ billing })       POST /stripe, POST /revenuecat   - public, authenticated by the PROVIDER's signature / authorization.
 *     The body is read RAW (express.raw): a signature over re-serialised JSON can never verify, and a parsed body must never be trusted.
 *     Mount it BEFORE any JSON body parser. Status codes follow what the providers retry on:
 *       401  signature / authorization failed          (not retried usefully; alerted)
 *       400  payload could not be parsed or validated  (a malformed event will not heal by retrying)
 *       503  transient processing failure              (the provider retries; the inbox keeps the event)
 *       200  applied, stale, duplicate, ignored, or parked for an operator (dead) - retrying cannot change the outcome
 *
 *  customerRouter({ gateway, getUserId, csrf })   POST /checkout, GET /summary   - for a signed-in member
 *     `getUserId(req)` is the host application's verified session identity (never a body or header value). `csrf` is a middleware (see csrf.js)
 *     applied to state-changing routes. Authorization (member / owner / admin) is decided live by the gateway, not here.
 *
 * Neither router grants access. Access is granted only by a verified webhook through the subscription engine.
 */

import express from 'express';
import { SubscriptionError, BillingSignatureError, BillingEventError } from './errors.js';

const PROVIDERS = ['stripe', 'revenuecat'];

export function webhookRouter({ billing, logger = console, limit = '256kb' } = {}) {
  if (!billing) throw new Error('webhookRouter requires a BillingProcessor');
  const r = express.Router();
  for (const provider of PROVIDERS) {
    r.post(`/${provider}`, express.raw({ type: () => true, limit }), async (req, res) => {
      if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'raw_body_required' });       // a JSON parser ran first: refuse, never guess
      try {
        const out = await billing.ingest({ provider, rawBody: req.body, headers: req.headers });
        return res.status(200).json({ status: out.status });
      } catch (e) {
        if (e instanceof BillingSignatureError) return res.status(401).json({ error: 'invalid_signature' });
        if (e instanceof BillingEventError) return res.status(400).json({ error: 'invalid_event' });
        if (e instanceof SubscriptionError && e.code === 'webhook_processing_failed') return res.status(503).json({ error: 'retry_later' });
        logger.error?.('[billing] webhook failed:', provider, e?.code || e?.message);
        return res.status(500).json({ error: 'internal_error' });
      }
    });
  }
  // payload-too-large and other body errors from express.raw
  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, next) => res.status(err?.status === 413 ? 413 : 400).json({ error: err?.status === 413 ? 'payload_too_large' : 'invalid_request' }));
  return r;
}

export function customerRouter({ gateway, getUserId, csrf } = {}) {
  if (!gateway) throw new Error('customerRouter requires a BillingGateway');
  if (typeof getUserId !== 'function') throw new Error('customerRouter requires getUserId(req)');
  if (typeof csrf !== 'function') throw new Error('customerRouter requires a csrf middleware (state-changing routes must not run without one)');
  const r = express.Router();
  r.use(express.json({ limit: '10kb' }));
  const user = (req, res, next) => { const u = getUserId(req); if (typeof u !== 'string' || !u) return res.status(401).json({ error: 'unauthenticated' }); req.billingUser = u; return next(); };
  const fail = (res, e) => {
    if (e instanceof SubscriptionError) return res.status(e.statusCode || 400).json({ error: e.code, message: e.message, details: e.details });
    return res.status(500).json({ error: 'internal_error' });
  };
  const str = (v) => (typeof v === 'string' ? v : '');

  r.post('/checkout', user, csrf, async (req, res) => {
    try {
      const b = req.body || {};
      return res.status(201).json(await gateway.beginCheckout({ customerId: str(b.customerId), userId: req.billingUser, provider: str(b.provider), planCode: str(b.planCode) }));
    } catch (e) { return fail(res, e); }
  });
  r.get('/summary', user, async (req, res) => {
    try {
      const features = String(req.query.usage || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
      return res.json(await gateway.summary({ customerId: str(req.query.customerId), userId: req.billingUser, usageFeatures: features }));
    } catch (e) { return fail(res, e); }
  });
  return r;
}
