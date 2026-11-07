import test from 'node:test';
import assert from 'node:assert/strict';
import { requireFeature, createMiddleware } from '../src/middleware.js';

test('untrusted req.customerId is not accepted as tenant identity', async () => {
  let called = false;
  const middleware = requireFeature('meetings.cloud_recording', {
    service: { canAccess: async () => { called = true; return { allowed: true }; } },
  });
  let response;
  await middleware({ customerId: 'attacker-tenant' }, {
    status(n) { response = n; return this; }, json() { return this; },
  }, () => {});
  assert.equal(response, 401);
  assert.equal(called, false);
});

test('quota check does not pass a soft-limit override', async () => {
  let received;
  const middleware = requireFeature('meetings.cloud_recording', {
    service: { canAccess: async (_c, _f, opts) => { received = opts; return { allowed: true }; } },
    soft: true,
  });
  await middleware({ auth: { customer_id: 'verified' } }, {}, () => {});
  assert.equal(received.soft, undefined);
});

test('reservation commit and release use authenticated tenant context', async () => {
  let committed, released;
  const api = createMiddleware({
    commitReservation: async (...args) => { committed = args; },
    releaseReservation: async (...args) => { released = args; },
  });
  const req = { auth: { customer_id: 'verified-tenant' } };
  await api.commitReservation(req, 'reservation-id');
  await api.releaseReservation(req, 'reservation-id');
  assert.equal(committed[1].customerId, 'verified-tenant');
  assert.equal(released[1].customerId, 'verified-tenant');
});

test('an UNEXPECTED failure (not a typed error) is a 503 with no detail, and next() is never called', async () => {
  for (const make of [() => new TypeError('Cannot read properties of undefined (reading rows)'), () => Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432'), { code: 'ECONNREFUSED' }), () => 'a thrown string']) {
    let nexted = false, status, body;
    const middleware = requireFeature('meetings.cloud_recording', { service: { canAccess: async () => { throw make(); } } });
    await middleware({ auth: { customer_id: 'verified' } }, { status(n) { status = n; return this; }, json(b) { body = b; return this; } }, () => { nexted = true; });
    assert.equal(status, 503); assert.equal(nexted, false);
    assert.deepEqual(Object.keys(body).sort(), ['error', 'message']);
    assert.doesNotMatch(JSON.stringify(body), /ECONNREFUSED|10\.1\.2\.3|TypeError|undefined|rows/);
  }
});

test('a typed error keeps its own status (for example a bad quantity is 400, a missing customer is 401)', async () => {
  let status;
  const res = { status(n) { status = n; return this; }, json() { return this; } };
  await requireFeature('meetings.participants', { service: { canAccess: async () => ({ allowed: true }) }, quantity: () => 0 })({ auth: { customer_id: 'v' } }, res, () => {});
  assert.equal(status, 400);
  await requireFeature('meetings.participants', { service: {} })({}, res, () => {});
  assert.equal(status, 401);
});
