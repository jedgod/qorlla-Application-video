const { test, expect } = require('@playwright/test');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const express = require('express');
const viewer = require('../number-viewer');

// Number Authority VIEWER (read-only) and fail-closed call features. No database, no carrier and no network beyond 127.0.0.1:
// the real Meet telephony routes run against a stub database, so these prove the permission rules, not any provider behaviour.
// They do NOT prove that forwarding, voicemail, spam protection, DND, blocked numbers or call waiting are ENFORCED at call time: no carrier or
// call-routing path exists in this build, so none of them can be. They prove that nothing is ever reported as active without carrier evidence.
const M = (f) => import(pathToFileURL(path.resolve(__dirname, '..', 'qorlla-meet-video', 'server', 'telephony', f)).href);

const ENV = { PHONE_NUMBER_VIEWER_USERS: 'Stryker, nobody*, other' };
const user = (o) => ({ id: 'u_1', username: 'stryker', emailVerified: true, suspended: false, ...o });

test.describe('viewer policy (main app)', () => {
  test('only exact, verified, non-admin, non-suspended usernames are viewers; wildcards never match', () => {
    expect(viewer.isViewer(user(), false, ENV)).toBe(true);
    expect(viewer.isViewer(user({ username: 'STRYKER' }), false, ENV)).toBe(true);
    expect(viewer.isViewer(user({ username: 'strykerx' }), false, ENV)).toBe(false);
    expect(viewer.isViewer(user({ username: 'nobodyelse' }), false, ENV)).toBe(false);       // "nobody*" is ignored, not a prefix rule
    expect(viewer.isViewer(user({ emailVerified: false }), false, ENV)).toBe(false);
    expect(viewer.isViewer(user({ suspended: true }), false, ENV)).toBe(false);
    expect(viewer.isViewer(user(), true, ENV)).toBe(false);                                  // an administrator is not a viewer
    expect(viewer.isViewer(user(), false, {})).toBe(false);                                  // unset means nobody
    expect(viewer.isViewer(null, false, ENV)).toBe(false);
  });

  test('the viewer flag reaches Meet only for an opted-in GET on a read-only route', () => {
    const a = (o) => viewer.actorFor(user(), { admin: false, ...o }, ENV);
    expect(a({ method: 'GET', route: '/numbers/requests', viewerRead: true }).viewer).toBe(true);
    expect(a({ method: 'GET', route: '/numbers', viewerRead: true }).viewer).toBe(true);
    expect(a({ method: 'GET', route: '/numbers' }).viewer).toBe(false);                      // internal lookups (the overview) do not opt in
    for (const [method, route] of [['POST', '/numbers/request'], ['POST', '/numbers/x/state'], ['POST', '/numbers/x/reassign'], ['POST', '/numbers/x/caller-id'], ['PUT', '/limits/u'], ['POST', '/usage/x/adjust'], ['POST', '/calls'], ['GET', '/numbers/available'], ['GET', '/usage'], ['PUT', '/features/desired']]) {
      expect(a({ method, route, viewerRead: true }).viewer, method + ' ' + route).toBe(false);
    }
    expect(viewer.actorFor(user(), { admin: true, method: 'GET', route: '/numbers', viewerRead: true }, ENV)).toEqual({ id: 'u_1', admin: true, viewer: false });
  });
});

test.describe('Meet telephony routes with a viewer (stub database)', () => {
  let srv, base, queries;
  test.beforeAll(async () => {
    const { registerTelephony } = await M('routes.mjs');
    queries = [];
    const db = { query: async (sql) => { queries.push(String(sql)); return { rows: [], rowCount: 0 }; }, connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {} }) };
    const app = express();
    registerTelephony({ app, db, bridgeAuth: (req, res, next) => next(), phone: {}, env: { VOICE_NUMBERS_ENABLED: 'true' } });   // test-local env object: nothing real is switched on
    srv = http.createServer(app); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + srv.address().port + '/api/integrations/telephony';
  });
  test.afterAll(() => new Promise((r) => srv.close(r)));
  const call = (method, route, who, body) => fetch(base + route, { method, headers: { 'content-type': 'application/json', 'x-qorlla-actor': 'u_1', 'x-qorlla-admin': who === 'admin' ? '1' : '0', 'x-qorlla-viewer': who === 'viewer' ? '1' : '0' }, body: body ? JSON.stringify(body) : undefined });

  test('a viewer can read requests, inventory and the snapshot', async () => {
    for (const route of ['/numbers/requests', '/numbers', '/numbers/snapshot']) { const r = await call('GET', route, 'viewer'); expect(r.status, route).toBe(200); }
  });

  test('a viewer cannot purchase, assign, release, change caller ID, adjust billing, set limits, reconcile or start calls; nothing reaches the database as a write', async () => {
    const id = '00000000-0000-0000-0000-000000000001';
    const attempts = [['POST', '/numbers/request', { country: 'US', kind: 'personal' }], ['POST', '/numbers/' + id + '/state', { state: 'active' }], ['POST', '/numbers/' + id + '/reassign', { to: 'u_2' }], ['POST', '/numbers/' + id + '/caller-id', { verified: true }],
      ['POST', '/usage/' + id + '/adjust', { kind: 'refund', amountMicros: 1 }], ['PUT', '/limits/u_2', { monthlyLimitMicros: 1 }], ['POST', '/numbers/reconcile'], ['GET', '/numbers/available?country=US']];
    queries.length = 0;
    for (const [m, route, body] of attempts) { const r = await call(m, route, 'viewer', body); expect(r.status, m + ' ' + route).toBe(403); }
    expect(queries.filter((q) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q))).toEqual([]);
  });

  test('an ordinary account (no admin, no viewer) sees none of the number-management reads', async () => {
    for (const route of ['/numbers/requests', '/numbers/snapshot']) expect((await call('GET', route, 'user')).status, route).toBe(403);
  });
});

test.describe('call features are never reported as active without carrier evidence', () => {
  test('forwarding, voicemail, spam protection, DND, blocked numbers, call waiting and caller ID: off, inactive, pending or active only with every proof', async () => {
    const { evaluateFeature, FEATURE_IDS } = await M('features.mjs');
    expect(FEATURE_IDS.sort()).toEqual(['blockedNumbers', 'callWaiting', 'callerId', 'doNotDisturb', 'forwarding', 'spamProtection', 'voicemail']);
    const all = { providerConfigured: true, providerActive: true, flagOn: true, hasNumber: true, supported: true };
    const confirmed = { state: 'active', confirmed_at: new Date() };
    for (const id of FEATURE_IDS) {
      const desired = { enabled: true };
      expect(evaluateFeature({ desired: { enabled: false }, record: confirmed, ...all }).state, id + ' off').toBe('off');
      // remove each proof in turn: the answer is never "active"
      for (const missing of ['providerConfigured', 'providerActive', 'flagOn', 'hasNumber', 'supported']) {
        const r = evaluateFeature({ desired, record: confirmed, ...all, [missing]: false });
        expect(r.state, id + ' without ' + missing).toBe('inactive');
      }
      expect(evaluateFeature({ desired, record: null, ...all }).state, id + ' not yet applied').toBe('pending');
      expect(evaluateFeature({ desired, record: { state: 'failed', error_code: 'x' }, ...all }).state, id + ' failed').toBe('failed');
      expect(evaluateFeature({ desired, record: confirmed, ...all }).state, id + ' all proofs').toBe('active');
    }
  });

  test('the carrier in this build supports no feature, so nothing can be confirmed', async () => {
    const { featureSupport } = await M('features.mjs'); const { createCarrier } = await M('provider.mjs');
    expect(featureSupport(createCarrier({})).size).toBe(0);
  });
});
