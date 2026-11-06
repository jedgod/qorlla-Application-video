import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, resolveFor } from '../src/decision.js';
import { FEATURES, PLAN_ORDER, resolveEntitlements } from '../src/plans.js';

const ent = (plan, extra = {}) => ({ entitled: true, effective_plan: plan, effective_status: 'active', ...extra });
const lapsed = (reason = 'paused') => ({ entitled: false, effective_plan: 'basic', effective_status: reason, lifecycle_reason: reason });
const bounds = { start: new Date('2026-06-01T00:00:00Z'), end: new Date('2026-07-01T00:00:00Z') };

test('boolean features: allowed on the plan that has them, denied below it with the required plan', () => {
  assert.equal(decide(ent('pro'), {}, 'meetings.cloud_recording', 1).allowed, true);
  const d = decide(ent('basic'), {}, 'meetings.cloud_recording', 1);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'feature_not_available');
  assert.equal(d.required_plan, 'pro');
});

test('capacity features compare the request to the limit only, with an exact boundary', () => {
  assert.equal(decide(ent('basic'), {}, 'meetings.participants', 100).allowed, true);
  const d = decide(ent('basic'), {}, 'meetings.participants', 101);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'limit_exceeded');
  assert.equal(decide(ent('business'), {}, 'meetings.participants', 300).allowed, true);
  assert.equal(decide(ent('business'), {}, 'meetings.duration_minutes', 10 ** 9).allowed, true, 'unlimited');
});

test('consumption features subtract usage AND live reservations; the boundary is exact', () => {
  const u = (used, reserved) => ({ used, reserved, bounds });
  assert.equal(decide(ent('basic'), {}, 'ai.meeting_summaries', 1, u(2, 0)).allowed, true);   // 3 allowed
  assert.equal(decide(ent('basic'), {}, 'ai.meeting_summaries', 1, u(2, 1)).allowed, false);
  assert.equal(decide(ent('basic'), {}, 'ai.meeting_summaries', 2, u(1, 0)).allowed, true, '1 used + 2 requested = exactly the limit of 3');
  const d = decide(ent('basic'), {}, 'ai.meeting_summaries', 3, u(1, 0));
  assert.equal(d.reason, 'limit_exceeded');
  assert.equal(d.remaining, 2);
  assert.equal(decide(ent('basic'), {}, 'ai.meeting_summaries', 2, u(1, 0)).period_start.toISOString(), bounds.start.toISOString());
  assert.equal(decide(ent('pro'), {}, 'ai.meeting_summaries', 10 ** 6, u(10 ** 6, 0)).allowed, true, 'pro is unlimited');
});

test('a lapsed customer keeps the free Basic features and is told the subscription is the problem for paid ones', () => {
  for (const reason of ['paused', 'canceled', 'expired', 'trial_expired']) {
    const s = lapsed(reason);
    assert.equal(decide(s, {}, 'chat.instant', 1).allowed, true, 'free feature survives: ' + reason);
    const paid = decide(s, {}, 'meetings.cloud_recording', 1);
    assert.equal(paid.allowed, false);
    assert.equal(paid.reason, 'subscription_inactive');
    assert.equal(paid.lifecycle_reason, reason);
  }
  assert.equal(decide(lapsed(), {}, 'meetings.participants', 101).allowed, false, 'and gets Basic limits, not the paid ones');
});

test('overrides apply to an entitled subscription and are IGNORED for a lapsed one', () => {
  const o = { 'meetings.cloud_recording': true, 'meetings.participants': 5000 };
  assert.equal(decide(ent('basic'), o, 'meetings.cloud_recording', 1).allowed, true);
  assert.equal(decide(ent('basic'), o, 'meetings.participants', 5000).allowed, true);
  assert.equal(decide(lapsed(), o, 'meetings.cloud_recording', 1).allowed, false);
  assert.equal(decide(lapsed(), o, 'meetings.participants', 200).allowed, false);
  assert.equal(resolveFor(lapsed(), o).values['meetings.participants'], 100);
});

test('an override can lower a limit as well as raise it', () => {
  assert.equal(decide(ent('pro'), { 'meetings.duration_minutes': 60 }, 'meetings.duration_minutes', 61).allowed, false);
});

test('unknown features, malformed entitlement values and numeric values on non-metered features all deny', () => {
  assert.equal(decide(ent('pro'), {}, 'made.up', 1).reason, 'unknown_feature');
  assert.equal(decide(ent('pro'), { 'meetings.participants': -5 }, 'meetings.participants', 1).reason, 'invalid_entitlement');
  assert.equal(decide(ent('pro'), { 'meetings.participants': 'lots' }, 'meetings.participants', 1).reason, 'invalid_entitlement');
  assert.equal(decide(ent('pro'), { 'meetings.cloud_recording': 7 }, 'meetings.cloud_recording', 1).reason, 'invalid_entitlement');
});

test('PSTN is a business-plan entitlement and VoIP does not imply it', () => {
  assert.equal(decide(ent('pro'), {}, 'phone.pstn', 1).allowed, false);
  assert.equal(decide(ent('business'), {}, 'phone.pstn', 1).allowed, true);
  assert.equal(decide(ent('basic'), {}, 'phone.voip', 1).allowed, true);
});

test('catalog self-consistency: every feature has a value on basic, only numeric features have numbers, plans only add', () => {
  const basic = resolveEntitlements('basic');
  for (const [key, meta] of Object.entries(FEATURES)) {
    assert.notEqual(basic[key], undefined, `basic defines ${key}`);
    for (const plan of PLAN_ORDER) {
      const v = resolveEntitlements(plan)[key];
      if (meta.type === 'boolean') assert.equal(typeof v, 'boolean', `${key}@${plan}`);
      else assert.ok(v === 'unlimited' || (Number.isSafeInteger(v) && v >= 0), `${key}@${plan}`);
    }
    if (meta.metering === 'consumption') assert.ok(['billing', 'daily', 'monthly'].includes(meta.period || 'billing'));
  }
});

test('no plan ever has FEWER entitlements than the plan below it', () => {
  const rank = (v) => (v === true || v === 'unlimited' ? Infinity : v === false ? -1 : v);
  for (let i = 1; i < PLAN_ORDER.length; i++) {
    const lo = resolveEntitlements(PLAN_ORDER[i - 1]);
    const hi = resolveEntitlements(PLAN_ORDER[i]);
    for (const k of Object.keys(lo)) assert.ok(rank(hi[k]) >= rank(lo[k]), `${k}: ${PLAN_ORDER[i]} < ${PLAN_ORDER[i - 1]}`);
  }
});
