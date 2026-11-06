// Provider-neutral billing ingestion against a real PostgreSQL, using the least-privilege billing role.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, newCustomer, seedSubscription, skip } from './helpers/db.js';
import { BillingProcessor } from '../src/billing.js';
import { AdminService } from '../src/admin.js';
import { AccessService } from '../src/accessService.js';
import { createSignedJsonAdapter } from '../src/billingAdapters.js';

const SECRET = 'k'.repeat(40);
const adapter = createSignedJsonAdapter({ provider: 'acme', secrets: [SECRET] });
const D = 86_400_000;
let seq = 0;

describe('BillingProcessor (PostgreSQL)', { skip }, () => {
  let db, billing, admin, runtime, changed;
  const processors = [];
  before(async () => {
    db = await createTestDb();
    changed = [];
    billing = new BillingProcessor({ adapters: [adapter], pool: db.poolFor('billing'), onSubscriptionChanged: (c) => changed.push(c) });
    admin = new AdminService({ pool: db.poolFor('admin'), authorize: async () => true });
    runtime = new AccessService({ pool: db.poolFor('runtime') });
  });
  after(async () => {
    if (process.env.SUBACC_DEBUG) console.error('FAILED INBOX ROWS', JSON.stringify((await db.owner.query(`SELECT event_type, status, attempts, error FROM billing_inbox WHERE status='failed' OR error IS NOT NULL`)).rows.slice(0, 5)));
    await db.drop();
  });

  const adminActor = { id: 'admin-1', roles: ['billing_admin'], mfaVerifiedAt: Date.now() };
  /** A linked customer: returns { c, ext } */
  const linked = async () => {
    const c = newCustomer(); const ext = `cus_${++seq}_${Math.random().toString(36).slice(2, 8)}`;
    await admin.linkBillingCustomer(adminActor, 'acme', ext, c);
    return { c, ext };
  };
  const snap = (o = {}) => ({ externalId: 'sub_1', planCode: 'pro', status: 'active',
    currentPeriodStart: new Date(Date.now() - 10 * D).toISOString(), currentPeriodEnd: new Date(Date.now() + 20 * D).toISOString(), ...o });
  // A provider's subscription id is unique to its customer: the default one is derived from the customer reference.
  const evt = (ext, o = {}) => {
    const e = { provider: 'acme', eventId: `evt_${++seq}_${Math.random().toString(36).slice(2, 8)}`, type: 'subscription.updated', revision: 1,
      occurredAt: new Date().toISOString(), externalCustomerId: ext, subscription: snap(), ...o };
    if (e.subscription && e.subscription.externalId === 'sub_1') e.subscription = { ...e.subscription, externalId: 'sub_' + ext };
    return e;
  };
  const raw = (e) => Buffer.from(JSON.stringify(e));
  const send = (e, proc = billing, { key, nowMs } = {}) => { const body = raw(e); return proc.ingest({ provider: 'acme', rawBody: body, headers: { 'x-signature': adapter.sign(body, nowMs, key) } }); };
  const sub = async (c) => (await db.owner.query('SELECT * FROM subscriptions WHERE customer_id=$1', [c])).rows[0];
  const count = async (sql, args) => Number((await db.owner.query(sql, args)).rows[0].n);
  const inbox = async (eventId) => (await db.owner.query('SELECT * FROM billing_inbox WHERE event_id=$1', [eventId])).rows[0];

  test('a signed event for an unlinked customer is parked (dead) and changes nothing; once an administrator links the customer it can be re-driven', async () => {
    const c = newCustomer(), ext = `cus_unlinked_${++seq}`;
    const e = evt(ext, { revision: 3 });
    const r = await send(e);
    assert.equal(r.status, 'dead'); assert.equal(r.reason, 'unmapped_customer');
    assert.equal(await sub(c), undefined);
    assert.equal(await count(`SELECT count(*) AS n FROM security_events WHERE event_type='webhook_unmapped_customer'`), 1);
    assert.equal((await inbox(e.eventId)).status, 'dead');
    await admin.linkBillingCustomer(adminActor, 'acme', ext, c);
    const again = await billing.redrive('acme', e.eventId);
    assert.equal(again.status, 'applied');
    assert.equal((await sub(c)).plan_code, 'pro');
    assert.equal((await billing.redrive('acme', e.eventId)).status, 'not_redrivable', 'applied events cannot be re-driven');
  });

  test('a webhook cannot attach itself to a tenant: the mapping table is not writable by the billing role', async () => {
    await assert.rejects(db.poolFor('billing').query(`INSERT INTO billing_customers (provider, external_customer_id, customer_id, linked_by) VALUES ('acme','sneaky',$1,'x')`, [newCustomer()]), { code: '42501' });
  });

  test('applying an event creates the subscription and the request path sees it immediately; a later higher revision overrides it', async () => {
    const { c, ext } = await linked();
    const r = await send(evt(ext, { revision: 1 }));
    assert.equal(r.status, 'applied');
    const s = await sub(c);
    assert.deepEqual([s.provider, s.external_id, Number(s.provider_revision), s.plan_code, s.status], ['acme', 'sub_' + ext, 1, 'pro', 'active']);
    assert.equal((await runtime.canAccess(c, 'meetings.cloud_recording')).allowed, true);
    await send(evt(ext, { revision: 2, type: 'subscription.paused', subscription: snap({ status: 'paused', pausedAt: new Date().toISOString() }) }));
    assert.equal((await runtime.canAccess(c, 'meetings.cloud_recording')).allowed, false, 'paused -> no paid entitlement, at once');
    assert.deepEqual(changed.filter((x) => x === c).length, 2, 'cache invalidation hook ran once per applied change');
  });

  test('replay: the same event delivered again is a duplicate - no second change, no second outbox row', async () => {
    const { c, ext } = await linked();
    const e = evt(ext, { revision: 4 });
    assert.equal((await send(e)).status, 'applied');
    const before = changed.length;
    for (let i = 0; i < 3; i++) { const r = await send(e); assert.equal(r.status, 'duplicate'); assert.equal(r.previous, 'applied'); }
    assert.equal(changed.length, before);
    assert.equal(await count(`SELECT count(*) AS n FROM billing_outbox WHERE dedupe_key=$1`, [`acme:${e.eventId}`]), 1);
    assert.equal(await count('SELECT count(*) AS n FROM billing_inbox WHERE event_id=$1', [e.eventId]), 1);
    assert.equal(Number((await sub(c)).provider_revision), 4);
  });

  test('a replayed event id carrying DIFFERENT (validly signed) content is flagged critical and ignored', async () => {
    const { c, ext } = await linked();
    const e = evt(ext, { revision: 2 });
    await send(e);
    const r = await send({ ...e, subscription: snap({ planCode: 'enterprise' }) });
    assert.equal(r.status, 'duplicate'); assert.equal(r.conflict, true);
    assert.equal((await sub(c)).plan_code, 'pro');
    assert.equal(await count(`SELECT count(*) AS n FROM security_events WHERE event_type='webhook_replay_mismatch' AND severity='critical' AND details->>'eventId'=$1`, [e.eventId]), 1);
  });

  test('ordering: a lower or equal revision never moves state backwards', async () => {
    const { c, ext } = await linked();
    await send(evt(ext, { revision: 5, subscription: snap({ planCode: 'business' }) }));
    const before = changed.length;
    assert.equal((await send(evt(ext, { revision: 4, subscription: snap({ planCode: 'basic' }) }))).status, 'stale');
    assert.equal((await send(evt(ext, { revision: 5, subscription: snap({ planCode: 'basic' }) }))).status, 'stale', 'same revision, different event id: not newer');
    assert.equal((await sub(c)).plan_code, 'business');
    assert.equal(changed.length, before, 'stale events do not invalidate anything');
    assert.equal((await send(evt(ext, { revision: 6, subscription: snap({ planCode: 'enterprise' }) }))).status, 'applied');
    assert.equal((await sub(c)).plan_code, 'enterprise');
  });

  test('20 parallel deliveries of ONE event across 4 workers: applied exactly once', async () => {
    const { c, ext } = await linked();
    const workers = Array.from({ length: 4 }, () => new BillingProcessor({ adapters: [adapter], pool: db.poolFor('billing', { max: 8 }) }));
    const e = evt(ext, { revision: 9 });
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => send(e, workers[i % 4])));
    assert.equal(rs.filter((r) => r.status === 'applied').length, 1);
    assert.equal(rs.filter((r) => r.status === 'duplicate').length, 19);
    assert.equal(await count('SELECT count(*) AS n FROM billing_outbox WHERE customer_id=$1', [c]), 1);
  });

  test('revisions 1..12 arriving in random order, in parallel: the highest always wins', async () => {
    const { c, ext } = await linked();
    const workers = Array.from({ length: 3 }, () => new BillingProcessor({ adapters: [adapter], pool: db.poolFor('billing', { max: 8 }) }));
    const plans = ['basic', 'pro', 'business', 'enterprise'];
    const events = Array.from({ length: 12 }, (_, i) => evt(ext, { revision: i + 1, subscription: snap({ planCode: plans[(i + 1) % 4] }) })).sort(() => Math.random() - 0.5);
    await Promise.all(events.map((e, i) => send(e, workers[i % 3])));
    const s = await sub(c);
    assert.equal(Number(s.provider_revision), 12);
    assert.equal(s.plan_code, plans[12 % 4]);
  });

  test('forged, tampered, stale and re-serialised webhooks are refused with nothing stored', async () => {
    const { ext } = await linked();
    const good = evt(ext);
    const bodyRaw = raw(good);
    const inboxBefore = await count('SELECT count(*) AS n FROM billing_inbox');
    const secBefore = await count(`SELECT count(*) AS n FROM security_events WHERE event_type='webhook_signature_invalid'`);
    const cases = [
      ['wrong secret', () => billing.ingest({ provider: 'acme', rawBody: bodyRaw, headers: { 'x-signature': adapter.sign(bodyRaw, Date.now(), 'z'.repeat(40)) } })],
      ['tampered body', () => billing.ingest({ provider: 'acme', rawBody: raw({ ...good, revision: 99 }), headers: { 'x-signature': adapter.sign(bodyRaw) } })],
      ['five minutes old', () => billing.ingest({ provider: 'acme', rawBody: bodyRaw, headers: { 'x-signature': adapter.sign(bodyRaw, Date.now() - 400_000) } })],
      ['no header', () => billing.ingest({ provider: 'acme', rawBody: bodyRaw, headers: {} })],
      ['re-serialised JSON', () => billing.ingest({ provider: 'acme', rawBody: Buffer.from(JSON.stringify(good, null, 2)), headers: { 'x-signature': adapter.sign(bodyRaw) } })],
    ];
    for (const [name, call] of cases) await assert.rejects(call(), { code: 'webhook_signature_invalid', statusCode: 401 }, name);
    assert.equal(await count('SELECT count(*) AS n FROM billing_inbox'), inboxBefore);
    assert.equal(await count(`SELECT count(*) AS n FROM security_events WHERE event_type='webhook_signature_invalid'`), secBefore + cases.length);
    await assert.rejects(billing.ingest({ provider: 'acme', rawBody: JSON.stringify(good), headers: { 'x-signature': adapter.sign(bodyRaw) } }), { code: 'raw_body_required' });
    await assert.rejects(billing.ingest({ provider: 'nobody', rawBody: bodyRaw, headers: {} }), { code: 'unknown_provider' });
    await assert.rejects(billing.ingest({ provider: 'acme', rawBody: Buffer.alloc(1024 * 1024 + 1), headers: {} }), { code: 'webhook_too_large' });
  });

  test('a correctly signed but malformed event is rejected (400) and recorded, never stored or applied', async () => {
    const { ext } = await linked();
    for (const bad of [{ ...evt(ext), provider: 'other' }, { ...evt(ext), subscription: snap({ planCode: 'platinum' }) }, { ...evt(ext), revision: 0 }, { ...evt(ext), eventId: '' }]) {
      await assert.rejects(send(bad), { code: 'webhook_event_invalid', statusCode: 400 });
    }
    await assert.rejects(billing.ingest({ provider: 'acme', rawBody: Buffer.from('{not json'), headers: { 'x-signature': adapter.sign(Buffer.from('{not json')) } }), { code: 'webhook_event_invalid' });
    assert.ok(await count(`SELECT count(*) AS n FROM security_events WHERE event_type='webhook_payload_invalid'`) >= 5);
  });

  test('an unknown event type is stored as ignored and changes nothing', async () => {
    const { c, ext } = await linked();
    const r = await send({ provider: 'acme', eventId: `evt_new_${++seq}`, type: 'something.brand_new', externalCustomerId: ext, occurredAt: new Date().toISOString() });
    assert.equal(r.status, 'ignored');
    assert.equal(await sub(c), undefined);
  });

  test('one customer, one subscription, one provider: a different subscription id or provider is a conflict, not a merge', async () => {
    const { c, ext } = await linked();
    await send(evt(ext, { revision: 1 }));
    const r = await send(evt(ext, { revision: 2, subscription: snap({ externalId: 'sub_OTHER', planCode: 'enterprise' }) }));
    assert.equal(r.status, 'dead'); assert.equal(r.reason, 'subscription_conflict');
    assert.equal((await sub(c)).plan_code, 'pro');
    assert.equal((await sub(c)).external_id, 'sub_' + ext);
  });

  test("cross-tenant: a provider subscription id that already belongs to another customer is refused as a critical conflict", async () => {
    const [a, b] = [await linked(), await linked()];
    await send(evt(a.ext, { revision: 1 }));
    const stolen = evt(b.ext, { revision: 1, subscription: snap({ externalId: 'sub_' + a.ext, planCode: 'enterprise' }) });
    const r = await send(stolen);
    assert.equal(r.status, 'dead'); assert.equal(r.reason, 'subscription_conflict');
    assert.equal(await sub(b.c), undefined, 'the second tenant received nothing');
    assert.equal((await sub(a.c)).plan_code, 'pro', 'and the first tenant is untouched');
    assert.equal(await count(`SELECT count(*) AS n FROM security_events WHERE event_type='webhook_subscription_collision' AND severity='critical' AND customer_id=$1`, [b.c]), 1);
  });

  test('processing failures are recorded, return 503 so the provider retries, count attempts, and finally park as dead - without blocking other events', async () => {
    const strict = new BillingProcessor({ adapters: [adapter], pool: db.poolFor('billing'), maxAttempts: 2 });
    const { c, ext } = await linked();
    const poison = evt(ext, { revision: 1, subscription: snap({ quantity: 3_000_000_000 }) });       // valid JSON/shape, but overflows the integer column
    await assert.rejects(send(poison, strict), { code: 'webhook_processing_failed', statusCode: 503 });
    let row = await inbox(poison.eventId);
    assert.equal(row.status, 'failed'); assert.equal(Number(row.attempts), 1); assert.match(row.error, /out of range|integer/i);
    await assert.rejects(send(poison, strict), { code: 'webhook_processing_failed' });
    assert.equal(Number((await inbox(poison.eventId)).attempts), 2);
    const parked = await send(poison, strict);
    assert.equal(parked.status, 'dead'); assert.equal(parked.reason, 'max_attempts');
    assert.equal(await sub(c), undefined, 'a failed event leaves no partial state');
    assert.equal((await send(evt(ext, { revision: 2 }), strict)).status, 'applied', 'the stream keeps flowing');
  });

  test('invoice and refund events without a snapshot go to the outbox only', async () => {
    const { c, ext } = await linked();
    const e = { provider: 'acme', eventId: `evt_inv_${++seq}`, type: 'invoice.payment_failed', occurredAt: new Date().toISOString(), externalCustomerId: ext, invoice: { id: 'in_1', amount: 4900 } };
    assert.equal((await send(e)).status, 'applied');
    assert.equal(await sub(c), undefined, 'no entitlement change without a snapshot');
    const o = (await db.owner.query('SELECT topic, payload FROM billing_outbox WHERE dedupe_key=$1', [`acme:${e.eventId}`])).rows[0];
    assert.equal(o.topic, 'billing.invoice.payment_failed'); assert.equal(o.payload.invoice.id, 'in_1');
  });

  test('outbox: at-least-once with retries, a failed publish stays queued with its error, and concurrent drainers publish each row once', async () => {
    const { ext } = await linked();
    for (let i = 0; i < 6; i++) await send(evt(ext, { revision: 100 + i }));
    const pendingBefore = await count('SELECT count(*) AS n FROM billing_outbox WHERE published_at IS NULL');
    assert.ok(pendingBefore >= 6);

    let calls = 0;
    const flaky = await billing.drainOutbox(async () => { calls++; throw new Error('bus down'); }, { batch: 1000 });
    assert.equal(flaky.published, 0); assert.equal(flaky.failed, calls);
    assert.equal(await count('SELECT count(*) AS n FROM billing_outbox WHERE published_at IS NULL'), pendingBefore, 'nothing is lost');
    assert.equal((await db.owner.query(`SELECT last_error FROM billing_outbox WHERE last_error IS NOT NULL LIMIT 1`)).rows[0].last_error, 'bus down');

    const seen = [];
    const publish = async (row) => { seen.push(row.dedupe_key); await new Promise((r) => setTimeout(r, 5)); };
    const drainers = Array.from({ length: 3 }, () => new BillingProcessor({ adapters: [adapter], pool: db.poolFor('billing') }));
    const results = await Promise.all(drainers.map((d) => d.drainOutbox(publish, { batch: 4 })));
    const second = await Promise.all(drainers.map((d) => d.drainOutbox(publish, { batch: 1000 })));
    const total = [...results, ...second].reduce((a, r) => a + r.published, 0);
    assert.equal(total, pendingBefore);
    assert.equal(new Set(seen).size, seen.length, 'no row was published twice');
    assert.equal(await count('SELECT count(*) AS n FROM billing_outbox WHERE published_at IS NULL'), 0);
  });

  test('reconcile: the provider\'s authoritative state wins when its revision is newer, and drift is reported', async () => {
    const { c, ext } = await linked();
    const s0 = snap({ externalId: 'sub_' + ext });
    await send(evt(ext, { revision: 1, subscription: s0 }));
    const same = await billing.reconcile(c, 'acme', async () => ({ revision: 1, subscription: s0 }));
    assert.equal(same.drift, false); assert.equal(same.status, 'stale');
    const drifted = await billing.reconcile(c, 'acme', async () => ({ revision: 7, subscription: snap({ externalId: 'sub_' + ext, status: 'past_due', gracePeriodEndsAt: new Date(Date.now() + D).toISOString() }) }));
    assert.equal(drifted.drift, true); assert.equal(drifted.status, 'applied');
    assert.equal((await sub(c)).status, 'past_due');
    assert.equal(await count(`SELECT count(*) AS n FROM security_events WHERE event_type='reconcile_drift' AND customer_id=$1`, [c]), 1);
    assert.equal((await runtime.canAccess(c, 'meetings.cloud_recording')).allowed, true, 'inside the explicit grace window');
    assert.equal((await billing.reconcile(newCustomer(), 'acme', async () => { throw new Error('unreachable'); })).status, 'not_linked');
    assert.equal((await billing.reconcile(c, 'acme', async () => null)).status, 'no_snapshot');
  });

  test('the billing role is confined: it can run the inbox, subscriptions and outbox and nothing else', async () => {
    const p = db.poolFor('billing');
    for (const sql of ['SELECT 1 FROM entitlement_overrides', 'SELECT 1 FROM quota_reservations', 'SELECT 1 FROM usage_events', 'SELECT 1 FROM access_audit',
      'DELETE FROM subscriptions', 'DELETE FROM billing_inbox', 'DELETE FROM billing_outbox', 'DROP TABLE billing_inbox', 'TRUNCATE billing_outbox']) {
      await assert.rejects(p.query(sql), { code: '42501' }, sql);
    }
    await seedSubscription(db.owner, newCustomer(), {});            // sanity: owner setup still fine
  });
});
