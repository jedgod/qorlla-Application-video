import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLifecycle, periodBounds, utcDay, utcMonth } from '../src/lifecycle.js';
import { getFeatureMeta } from '../src/plans.js';

const H = 3_600_000, D = 24 * H;
const NOW = Date.parse('2026-06-15T12:00:00Z');
const sub = (o = {}) => ({
  plan_code: 'pro', status: 'active',
  current_period_start: new Date(NOW - 10 * D), current_period_end: new Date(NOW + 20 * D),
  trial_ends_at: null, grace_period_ends_at: null, ...o,
});
const ev = (o, opts) => evaluateLifecycle(sub(o), NOW, opts);

test('active and trialing inside the period are entitled to their plan', () => {
  assert.equal(ev({}).entitled, true);
  assert.equal(ev({}).effective_plan, 'pro');
  const t = ev({ status: 'trialing', trial_ends_at: new Date(NOW + D) });
  assert.equal(t.entitled, true);
  assert.equal(t.effective_status, 'trialing');
});

test('paused, canceled, incomplete, expired and unknown statuses are NOT entitled and fall back to basic', () => {
  for (const status of ['paused', 'canceled', 'incomplete', 'expired', 'banana']) {
    const r = ev({ status });
    assert.equal(r.entitled, false, status);
    assert.equal(r.effective_plan, 'basic', status);
  }
  assert.equal(ev({ status: 'banana' }).lifecycle_reason, 'unknown_status');
});

test('an unknown plan code is never entitled', () => {
  const r = ev({ plan_code: 'platinum' });
  assert.equal(r.entitled, false);
  assert.equal(r.lifecycle_reason, 'unknown_plan');
});

test('trial: valid until trial_ends_at, denied at and after it', () => {
  assert.equal(ev({ status: 'trialing', trial_ends_at: new Date(NOW + 1) }).entitled, true);
  assert.equal(ev({ status: 'trialing', trial_ends_at: new Date(NOW) }).entitled, false);
  const r = ev({ status: 'trialing', trial_ends_at: new Date(NOW - 1) });
  assert.equal(r.lifecycle_reason, 'trial_expired');
});

test('active past current_period_end is denied; renewalGraceMs is the only tolerance and defaults to none', () => {
  const past = { current_period_start: new Date(NOW - 40 * D), current_period_end: new Date(NOW - H) };
  assert.equal(ev(past).entitled, false);
  assert.equal(ev(past).lifecycle_reason, 'period_expired');
  assert.equal(ev(past, { renewalGraceMs: 2 * H }).entitled, true);
  assert.equal(ev(past, { renewalGraceMs: H }).entitled, false, 'boundary is exclusive');
});

test('past_due: explicit grace_period_ends_at governs, even before the period ends', () => {
  assert.equal(ev({ status: 'past_due', grace_period_ends_at: new Date(NOW + H) }).entitled, true);
  assert.equal(ev({ status: 'past_due', grace_period_ends_at: new Date(NOW + H) }).effective_status, 'past_due_grace');
  const lapsed = ev({ status: 'past_due', grace_period_ends_at: new Date(NOW - 1) });
  assert.equal(lapsed.entitled, false, 'explicit grace over -> denied although current_period_end is still in the future');
  assert.equal(lapsed.lifecycle_reason, 'grace_expired');
});

test('every deadline is exclusive: at the exact instant a period, trial or grace ends, access has ended', () => {
  assert.equal(ev({ status: 'past_due', grace_period_ends_at: new Date(NOW) }).entitled, false, 'explicit grace ends AT grace_period_ends_at');
  assert.equal(ev({ status: 'past_due', grace_period_ends_at: new Date(NOW + 1) }).entitled, true, 'one millisecond earlier it is still open');
  assert.equal(ev({ current_period_start: new Date(NOW - 40 * D), current_period_end: new Date(NOW) }).entitled, false, 'period ends AT current_period_end');
  assert.equal(ev({ current_period_start: new Date(NOW - 40 * D), current_period_end: new Date(NOW + 1) }).entitled, true);
  const pd = (end) => ({ status: 'past_due', current_period_start: new Date(NOW - 40 * D), current_period_end: new Date(end) });
  assert.equal(ev(pd(NOW - 3 * D)).entitled, false, 'default grace ends exactly 3 days after the period end');
  assert.equal(ev(pd(NOW - 3 * D + 1)).entitled, true);
});

test('past_due without explicit grace: current_period_end + default grace', () => {
  const end = (ms) => ({ status: 'past_due', current_period_start: new Date(NOW - 40 * D), current_period_end: new Date(NOW + ms) });
  assert.equal(ev(end(-2 * D)).entitled, true, 'two days after period end, inside the 3 day default');
  assert.equal(ev(end(-4 * D)).entitled, false);
  assert.equal(ev(end(-4 * D), { defaultGraceMs: 5 * D }).entitled, true);
});

test('a period that has not started yet is denied beyond the clock-skew allowance', () => {
  assert.equal(ev({ current_period_start: new Date(NOW + 2 * 60_000), current_period_end: new Date(NOW + 30 * D) }).entitled, true, '2 minutes of skew tolerated');
  const r = ev({ current_period_start: new Date(NOW + H), current_period_end: new Date(NOW + 30 * D) });
  assert.equal(r.entitled, false);
  assert.equal(r.lifecycle_reason, 'period_not_started');
});

test('missing or invalid dates and an invalid clock fail closed', () => {
  assert.equal(ev({ current_period_end: null }).entitled, false);
  assert.equal(ev({ current_period_end: 'not a date' }).entitled, false);
  assert.equal(evaluateLifecycle(sub(), NaN).entitled, false);
});

test('accepts ISO strings as well as Date objects', () => {
  const r = evaluateLifecycle(sub({ current_period_start: new Date(NOW - D).toISOString(), current_period_end: new Date(NOW + D).toISOString() }), new Date(NOW));
  assert.equal(r.entitled, true);
});

test('usage windows are UTC calendar boundaries and do not depend on the process time zone', () => {
  const edge = Date.parse('2026-12-31T23:59:59.999Z');
  assert.equal(utcMonth(edge).start.toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(utcMonth(edge).end.toISOString(), '2027-01-01T00:00:00.000Z');
  assert.equal(utcDay(edge).start.toISOString(), '2026-12-31T00:00:00.000Z');
  assert.equal(utcDay(edge).end.toISOString(), '2027-01-01T00:00:00.000Z');
  const feb = Date.parse('2028-02-29T00:00:00Z');
  assert.equal(utcMonth(feb).end.toISOString(), '2028-03-01T00:00:00.000Z', 'leap year');
});

test('billing-period usage window: the subscription period when entitled and containing now; otherwise the UTC month', () => {
  const meta = getFeatureMeta('ai.meeting_summaries');
  const entitled = { entitled: true, source: 'db', current_period_start: new Date(NOW - 10 * D), current_period_end: new Date(NOW + 20 * D) };
  assert.equal(periodBounds(entitled, meta, NOW).start.getTime(), NOW - 10 * D);
  assert.equal(periodBounds({ ...entitled, entitled: false }, meta, NOW).start.toISOString(), '2026-06-01T00:00:00.000Z', 'lapsed customers use the calendar month');
  assert.equal(periodBounds({ ...entitled, current_period_end: new Date(NOW - 1) }, meta, NOW).start.toISOString(), '2026-06-01T00:00:00.000Z', 'stale period is never used');
  assert.equal(periodBounds({ entitled: true, source: 'default' }, meta, NOW).start.toISOString(), '2026-06-01T00:00:00.000Z');
});
