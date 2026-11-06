import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSignedJsonAdapter, validateEvent } from '../src/billingAdapters.js';
import { BillingEventError } from '../src/errors.js';

const SECRET = 's'.repeat(40), OLD = 'o'.repeat(40);
const adapter = createSignedJsonAdapter({ provider: 'acme', secrets: [SECRET, OLD], header: 'X-Acme-Signature' });
const now = Date.now();
const body = (o = {}) => Buffer.from(JSON.stringify({ provider: 'acme', eventId: 'e1', type: 'subscription.updated', revision: 1, occurredAt: new Date(now).toISOString(), externalCustomerId: 'c1', ...o }));
const hdr = (raw, t = now, key = SECRET) => ({ 'x-acme-signature': adapter.sign(raw, t, key) });

test('a correct signature over the exact bytes verifies; header lookup is case-insensitive', () => {
  const raw = body();
  assert.deepEqual(adapter.verify(raw, hdr(raw), now), { ok: true });
});

test('a tampered body, a re-serialised body and a wrong secret are all refused', () => {
  const raw = body();
  const h = hdr(raw);
  assert.equal(adapter.verify(body({ revision: 2 }), h, now).ok, false, 'content changed');
  assert.equal(adapter.verify(Buffer.from(JSON.stringify(JSON.parse(raw), null, 2)), h, now).ok, false, 'same JSON, different bytes');
  assert.equal(adapter.verify(raw, { 'x-acme-signature': adapter.sign(raw, now, 'x'.repeat(40)) }, now).ok, false);
  assert.equal(adapter.verify(raw, hdr(raw, now, 'x'.repeat(40)), now).reason, 'signature_mismatch');
});

test('secret rotation: events signed with the previous secret still verify while it is configured', () => {
  const raw = body();
  assert.equal(adapter.verify(raw, hdr(raw, now, OLD), now).ok, true);
  const rotated = createSignedJsonAdapter({ provider: 'acme', secrets: [SECRET], header: 'X-Acme-Signature' });
  assert.equal(rotated.verify(raw, hdr(raw, now, OLD), now).ok, false, 'retired secret no longer works');
});

test('replay window: timestamps outside the tolerance are refused in both directions', () => {
  const raw = body();
  assert.equal(adapter.verify(raw, hdr(raw, now - 301_000), now).reason, 'timestamp_out_of_tolerance');
  assert.equal(adapter.verify(raw, hdr(raw, now + 301_000), now).reason, 'timestamp_out_of_tolerance');
  assert.equal(adapter.verify(raw, hdr(raw, now - 299_000), now).ok, true);
});

test('missing, malformed and oversized signature headers are refused without throwing', () => {
  const raw = body();
  for (const h of [{}, { 'x-acme-signature': '' }, { 'x-acme-signature': 'garbage' }, { 'x-acme-signature': 't=abc,v1=zz' },
    { 'x-acme-signature': 't=1,v1=' + 'a'.repeat(63) }, { 'x-acme-signature': 'x'.repeat(5000) }]) {
    assert.equal(adapter.verify(raw, h, now).ok, false);
  }
  assert.equal(adapter.verify('a string, not bytes', hdr(raw), now).reason, 'raw_body_required');
});

test('construction refuses weak or missing secrets and bad provider names', () => {
  assert.throws(() => createSignedJsonAdapter({ provider: 'acme', secrets: ['short'] }));
  assert.throws(() => createSignedJsonAdapter({ provider: 'acme', secrets: [] }));
  assert.throws(() => createSignedJsonAdapter({ provider: 'Bad Name!', secrets: [SECRET] }));
});

const snap = (o = {}) => ({ externalId: 'sub_1', planCode: 'pro', status: 'active', currentPeriodStart: '2026-06-01T00:00:00Z', currentPeriodEnd: '2026-07-01T00:00:00Z', ...o });
const ev = (o = {}) => ({ provider: 'acme', eventId: 'e1', type: 'subscription.updated', revision: 3, occurredAt: '2026-06-02T00:00:00Z', externalCustomerId: 'c1', subscription: snap(), ...o });

test('validateEvent accepts a complete snapshot event', () => {
  assert.equal(validateEvent('acme', ev()).eventId, 'e1');
});

test('validateEvent rejects structurally invalid events', () => {
  const bad = [
    ev({ provider: 'other' }), ev({ eventId: '' }), ev({ externalCustomerId: undefined }), ev({ occurredAt: 'nope' }),
    ev({ revision: 0 }), ev({ revision: 1.5 }), ev({ revision: undefined }),
    ev({ subscription: snap({ planCode: 'platinum' }) }), ev({ subscription: snap({ status: 'zombie' }) }),
    ev({ subscription: snap({ currentPeriodEnd: '2026-05-01T00:00:00Z' }) }), ev({ subscription: snap({ currentPeriodStart: undefined }) }),
    ev({ subscription: snap({ quantity: 0 }) }), ev({ subscription: snap({ trialEndsAt: 'soon' }) }), ev({ subscription: snap({ externalId: '' }) }), null, 'text',
  ];
  for (const e of bad) assert.throws(() => validateEvent('acme', e), BillingEventError, JSON.stringify(e)?.slice(0, 80));
});

test('an unknown event type is passed through as ignorable, not rejected', () => {
  assert.equal(validateEvent('acme', { provider: 'acme', eventId: 'x', type: 'something.new' }).unknownType, true);
});
