// Provider-neutral billing contract, certified end to end with a provider SIMULATOR (a real provider is not selected yet).
// At every step the REQUEST PATH (AccessService, least-privilege role) must agree with the provider's state.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, newCustomer, sleep, skip } from './helpers/db.js';
import { ProviderSim, simAdapter } from './helpers/provider-sim.js';
import { BillingProcessor } from '../src/billing.js';
import { AccessService } from '../src/accessService.js';

let n = 0;

describe('billing lifecycle contract (PostgreSQL, provider simulator)', { skip }, () => {
  let db, billing, access, changed;
  before(async () => {
    db = await createTestDb(); changed = [];
    billing = new BillingProcessor({ adapters: [simAdapter()], pool: db.poolFor('billing'), onSubscriptionChanged: (c) => changed.push(c) });
    access = new AccessService({ pool: db.poolFor('runtime') });
  });
  after(async () => { await db.drop(); });

  async function world() {
    const customerId = newCustomer(), ext = `cus_${++n}_${Math.random().toString(36).slice(2, 7)}`;
    await db.owner.query(`INSERT INTO billing_customers (provider, external_customer_id, customer_id, linked_by) VALUES ('sim',$1,$2,'test')`, [ext, customerId]);
    return { customerId, sim: new ProviderSim({ externalCustomerId: ext }) };
  }
  const deliver = (d) => billing.ingest({ provider: 'sim', rawBody: d.rawBody, headers: d.headers });
  const can = async (c, feature = 'meetings.cloud_recording', quantity) => (await access.canAccess(c, feature, quantity ? { quantity } : {})).allowed;
  const row = async (c) => (await db.owner.query('SELECT * FROM subscriptions WHERE customer_id=$1', [c])).rows[0];

  test('CREATION with a trial: paid features while trialing, back to the free plan the moment the trial ends (database clock)', async () => {
    const { customerId, sim } = await world();
    assert.equal((await deliver(sim.create({ plan: 'pro', trialMs: 1500 }))).status, 'applied');
    assert.equal(await can(customerId), true, 'trialing: recording allowed');
    assert.equal((await row(customerId)).status, 'trialing');
    await sleep(1800);
    assert.equal(await can(customerId), false, 'trial over, no conversion event needed: fail closed');
    assert.equal(await can(customerId, 'meetings.host'), true, 'and the free tier still works');
  });

  test('RENEWAL: a renewal before the period ends keeps access; a missed renewal ends it exactly at the period end', async () => {
    const [a, b] = [await world(), await world()];
    await deliver(a.sim.create({ plan: 'pro', periodMs: 1500 })); await deliver(b.sim.create({ plan: 'pro', periodMs: 1500 }));
    await deliver(a.sim.renew(60_000));
    await sleep(1800);
    assert.equal(await can(a.customerId), true, 'renewed: still entitled after the ORIGINAL end');
    assert.equal(await can(b.customerId), false, 'not renewed: entitlement ended at the period end');
    assert.equal(Number((await row(a.customerId)).provider_revision), 2);
  });

  test('PAYMENT FAILURE: entitled inside the grace window, denied when it ends, and a recovery restores access at once', async () => {
    const { customerId, sim } = await world();
    await deliver(sim.create({ plan: 'business', periodMs: 60_000 }));
    assert.equal(await can(customerId, 'meetings.participants', 300), true);
    await deliver(sim.paymentFailed(1500));
    assert.equal((await row(customerId)).status, 'past_due');
    assert.equal(await can(customerId, 'meetings.participants', 300), true, 'past_due inside the grace window');
    await sleep(1800);
    assert.equal(await can(customerId, 'meetings.participants', 300), false, 'grace over: Business limits are gone');
    assert.equal(await can(customerId, 'meetings.participants', 100), true, 'free-plan limits remain');
    await deliver(sim.paymentRecovered());
    assert.equal(await can(customerId, 'meetings.participants', 300), true, 'payment recovered: restored immediately');
    assert.equal((await row(customerId)).status, 'active');
  });

  test('UPGRADE and DOWNGRADE take effect at once; a late (out-of-order) older event cannot undo the newer one', async () => {
    const { customerId, sim } = await world();
    await deliver(sim.create({ plan: 'basic' }));
    assert.equal(await can(customerId, 'meetings.participants', 300), false);
    const up = sim.changePlan('business');                      // revision 2
    const down = sim.changePlan('pro');                         // revision 3
    assert.equal((await deliver(down)).status, 'applied');       // the NEWER event arrives first
    assert.equal(await can(customerId, 'meetings.participants', 300), false, 'pro: 100 participants');
    assert.equal((await deliver(up)).status, 'stale', 'the older upgrade arrives late and is ignored');
    assert.equal(await can(customerId, 'meetings.participants', 300), false, 'still pro');
    assert.equal(await can(customerId), true, 'recording is a pro feature');
    assert.equal((await row(customerId)).plan_code, 'pro');
    await deliver(sim.changePlan('business'));
    assert.equal(await can(customerId, 'meetings.participants', 300), true);
    await deliver(sim.changePlan('basic'));
    assert.equal(await can(customerId), false, 'downgraded to basic');
  });

  test('CANCELLATION at period end keeps access until then; an immediate cancellation ends it at once; a MISSED final webhook still ends it at the period end', async () => {
    const [soft, hard, missed] = [await world(), await world(), await world()];
    for (const w of [soft, hard, missed]) await deliver(w.sim.create({ plan: 'pro', periodMs: 5000 }));
    await deliver(soft.sim.cancelAtPeriodEnd());
    await deliver(hard.sim.cancelNow());
    assert.equal(await can(soft.customerId), true, 'cancel-at-period-end: still paid up');
    assert.equal((await row(soft.customerId)).cancel_at_period_end, true);
    assert.equal(await can(hard.customerId), false, 'canceled now');
    assert.equal(await can(missed.customerId), true);
    await sleep(5300);
    assert.equal(await can(soft.customerId), false, 'the paid period ended (even though no final webhook has arrived)');
    assert.equal(await can(missed.customerId), false, 'and a webhook that never comes cannot keep access alive');
  });

  test('REFUND is recorded and published but never changes entitlements by itself; PAUSE and RESUME follow the provider', async () => {
    const { customerId, sim } = await world();
    await deliver(sim.create({ plan: 'pro' }));
    const r = await deliver(sim.refund(4900));
    assert.equal(r.status, 'applied');
    assert.equal(await can(customerId), true, 'a refund is a money event, not an entitlement event');
    const o = (await db.owner.query(`SELECT topic, payload FROM billing_outbox WHERE dedupe_key=$1`, [`sim:${sim.sent.at(-1).event.eventId}`])).rows[0];
    assert.equal(o.topic, 'billing.invoice.refunded'); assert.equal(o.payload.invoice.refunded, 4900);
    await deliver(sim.pause()); assert.equal(await can(customerId), false, 'paused');
    await deliver(sim.resume()); assert.equal(await can(customerId), true, 'resumed');
    await deliver(sim.cancelNow()); assert.equal(await can(customerId), false);
  });

  test('RECONCILIATION after MISSED webhooks: local state is behind, reconcile() pulls the provider\'s authoritative state, reports drift, and access follows', async () => {
    const { customerId, sim } = await world();
    await deliver(sim.create({ plan: 'basic' }));
    sim.silently(() => sim.changePlan('business'));            // three events the provider sent and we never received
    sim.silently(() => sim.renew(60_000));
    sim.silently(() => sim.paymentFailed(60_000));
    assert.equal(await can(customerId, 'meetings.participants', 300), false, 'we still think it is basic');
    const out = await billing.reconcile(customerId, 'sim', async () => sim.authoritative());
    assert.equal(out.drift, true); assert.equal(out.status, 'applied');
    const r = await row(customerId);
    assert.deepEqual([r.plan_code, r.status, Number(r.provider_revision)], ['business', 'past_due', sim.revision]);
    assert.equal(await can(customerId, 'meetings.participants', 300), true, 'past_due inside its grace window, on the real plan');
    assert.equal((await db.owner.query(`SELECT count(*)::int n FROM security_events WHERE event_type='reconcile_drift' AND customer_id=$1`, [customerId])).rows[0].n, 1);
    assert.equal((await billing.reconcile(customerId, 'sim', async () => sim.authoritative())).drift, false, 'a second run finds nothing to fix');
  });

  test('DUPLICATE, SHUFFLED and CONCURRENT delivery of a whole lifecycle converges to the provider\'s final state, applying each event once', async () => {
    const { customerId, sim } = await world();
    const ds = [sim.create({ plan: 'basic', periodMs: 120_000 }), sim.changePlan('pro'), sim.renew(120_000), sim.paymentFailed(60_000), sim.paymentRecovered(120_000), sim.changePlan('business'),
      sim.cancelAtPeriodEnd(), sim.refund(100), sim.pause(), sim.resume()];
    const flood = ds.flatMap((d) => [d, d, d]).sort(() => Math.random() - 0.5);               // every event three times, in random order
    const workers = Array.from({ length: 4 }, () => new BillingProcessor({ adapters: [simAdapter()], pool: db.poolFor('billing', { max: 6 }) }));
    const results = await Promise.all(flood.map((d, i) => workers[i % 4].ingest({ provider: 'sim', rawBody: d.rawBody, headers: d.headers })));
    const r = await row(customerId);
    assert.deepEqual([r.plan_code, r.status, r.cancel_at_period_end, Number(r.provider_revision)], ['business', 'active', true, sim.revision]);
    assert.equal(results.filter((x) => x.status === 'duplicate').length, 20, 'exactly 20 of 30 deliveries were duplicates');
    assert.equal((await db.owner.query(`SELECT count(*)::int n FROM billing_inbox WHERE payload->>'externalCustomerId'=$1`, [sim.ext])).rows[0].n, 10, 'each event stored once');
    assert.equal((await db.owner.query(`SELECT count(*)::int n FROM billing_outbox WHERE customer_id=$1`, [customerId])).rows[0].n, 10, 'and published once');
    assert.equal(await can(customerId, 'meetings.participants', 300), true);
  });

  test('every delivery is authenticated: an unsigned or re-signed-with-another-key event never changes anything', async () => {
    const { customerId, sim } = await world();
    const d = sim.create({ plan: 'enterprise' });
    await assert.rejects(billing.ingest({ provider: 'sim', rawBody: d.rawBody, headers: {} }), { code: 'webhook_signature_invalid' });
    await assert.rejects(billing.ingest({ provider: 'sim', rawBody: d.rawBody, headers: { 'x-signature': 't=1,v1=' + '0'.repeat(64) } }), { code: 'webhook_signature_invalid' });
    assert.equal(await row(customerId), undefined);
    assert.equal(await can(customerId, 'compliance.hipaa'), false);
  });
});
