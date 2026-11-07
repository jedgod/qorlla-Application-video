import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strictQuantity, quantityFromText, DEFAULT_MAX_QUANTITY } from '../src/validate.js';
import { requireFeature } from '../src/middleware.js';
import { createMeetGuard } from '../src/meetGuard.js';

const code = (fn) => { try { fn(); return 'ACCEPTED'; } catch (e) { return e.code; } };

test('whole numbers from 1 up to the ceiling are accepted unchanged', () => {
  for (const v of [1, 2, 100, 300, 999_999, DEFAULT_MAX_QUANTITY]) assert.equal(strictQuantity(v), v);
});

test('everything else is rejected: no coercion, no fallback', () => {
  const bad = [0, -0, -1, -100, 0.5, 1.5, 2.0000001, 0.1 + 0.2, NaN, Infinity, -Infinity, JSON.parse('1e999'), JSON.parse('-1e999'),
    '5', '05', ' 5', '5 ', '1e3', '0x10', 'many', '', ' ', '1,000', true, false, [], [5], {}, { valueOf: () => 5 }, new Number(5), () => 5, Symbol.iterator, 10n];
  for (const v of bad) assert.equal(code(() => strictQuantity(v)), 'invalid_quantity', `${typeof v}:${String(v)}`);
});

test('missing is its own error, and only when required', () => {
  assert.equal(code(() => strictQuantity(undefined)), 'quantity_required');
  assert.equal(code(() => strictQuantity(null)), 'quantity_required');
  assert.equal(strictQuantity(undefined, { required: false }), undefined);
  assert.equal(code(() => strictQuantity(null, { required: false })), 'ACCEPTED', 'optional + absent is fine');
  assert.equal(code(() => strictQuantity('x', { required: false })), 'invalid_quantity', 'optional does not mean "anything goes"');
});

test('above the ceiling is quantity_too_large, with the ceiling configurable', () => {
  assert.equal(code(() => strictQuantity(DEFAULT_MAX_QUANTITY + 1)), 'quantity_too_large');
  assert.equal(code(() => strictQuantity(Number.MAX_SAFE_INTEGER)), 'quantity_too_large');
  assert.equal(code(() => strictQuantity(2 ** 60)), 'quantity_too_large');
  assert.equal(strictQuantity(1000, { max: 1000 }), 1000);
  assert.equal(code(() => strictQuantity(1001, { max: 1000 })), 'quantity_too_large');
  try { strictQuantity(5, { max: 3, name: 'max_participants' }); } catch (e) { assert.equal(e.details.field, 'max_participants'); assert.equal(e.details.max, 3); assert.equal(e.statusCode, 400); }
});

test('text-only sources (query strings): plain decimal digits only', () => {
  assert.equal(quantityFromText('300'), 300);
  for (const t of ['0', '01', '-3', '+3', '3.0', '3e2', '0x3', ' 3', '3 ', '', 'abc', '١٢٣', '9'.repeat(30)]) {
    assert.notEqual(code(() => quantityFromText(t)), 'ACCEPTED', JSON.stringify(t));
  }
  assert.equal(code(() => quantityFromText(undefined)), 'quantity_required');
  assert.equal(code(() => quantityFromText(300)), 'invalid_quantity', 'a number is not text');
});

test('the middleware never falls back: a count function that yields nothing or rubbish is a 400 and the service is never asked', async () => {
  const seen = [];
  const service = { canAccess: async (_c, _f, o) => { seen.push(o.quantity); return { allowed: true }; }, maxQuantity: 1000 };
  const run = async (q) => {
    let status = 200, body, nexted = false;
    await requireFeature('meetings.participants', { service, quantity: () => q })({ auth: { customer_id: 'c' } },
      { status(n) { status = n; return this; }, json(b) { body = b; return this; } }, () => { nexted = true; });
    return { status, error: body?.error, nexted };
  };
  for (const [v, err] of [[undefined, 'quantity_required'], [null, 'quantity_required'], ['5', 'invalid_quantity'], [0, 'invalid_quantity'], [-4, 'invalid_quantity'], [2.5, 'invalid_quantity'],
    [NaN, 'invalid_quantity'], [Infinity, 'invalid_quantity'], [true, 'invalid_quantity'], [1001, 'quantity_too_large']]) {
    const r = await run(v);
    assert.deepEqual([r.status, r.error, r.nexted], [400, err, false], String(v));
  }
  assert.deepEqual(seen, [], 'no entitlement or quota check ran for any of them');
  assert.deepEqual(await run(1000), { status: 200, error: undefined, nexted: true });
  assert.deepEqual(seen, [1000], 'and the valid value is passed through exactly');
});

test('the middleware records the exact validated number for the handler, and a flag-only route checks 1', async () => {
  const seen = [];
  const service = { canAccess: async (_c, _f, o) => { seen.push(o.quantity); return { allowed: true }; } };
  const req = { auth: { customer_id: 'c' } };
  await requireFeature('meetings.participants', { service, quantity: () => 37 })(req, {}, () => {});
  await requireFeature('meetings.cloud_recording', { service })(req, {}, () => {});
  assert.deepEqual(req.validated, { 'meetings.participants': 37, 'meetings.cloud_recording': 1 });
  assert.deepEqual(seen, [37, 1]);
});

test('the Meet guard rejects bad bridge counts with the same validator and never defaults them', async () => {
  const calls = [];
  const guard = createMeetGuard({ service: { canAccess: async (...a) => { calls.push(a); return { allowed: true }; } }, maxQuantity: 5000 });
  const run = async (body) => { let status = 200, out; await guard.bridgeCreate()({ body }, { status(n) { status = n; return this; }, json(b) { out = b; return this; } }, () => {}); return [status, out?.error]; };
  const customerId = '11111111-1111-4111-8111-111111111111';
  for (const [v, err] of [['100', 'invalid_quantity'], [0, 'invalid_quantity'], [-1, 'invalid_quantity'], [1.5, 'invalid_quantity'], [NaN, 'invalid_quantity'],
    [Infinity, 'invalid_quantity'], [null, 'quantity_required'], [true, 'invalid_quantity'], [5001, 'quantity_too_large']]) {
    assert.deepEqual(await run({ customerId, maxParticipants: v }), [400, err], 'maxParticipants ' + String(v));
    assert.deepEqual(await run({ customerId, durationMinutes: v }), [400, err], 'durationMinutes ' + String(v));
  }
  assert.equal(calls.length, 0, 'no entitlement check for a malformed count');
  assert.deepEqual(await run({ customerId, maxParticipants: 5000 }), [200, undefined]);
  assert.deepEqual(calls.map((c) => c[2].quantity).sort((a, b) => a - b), [1, 5000], 'host check for 1 and the participant count exactly as validated');
});
