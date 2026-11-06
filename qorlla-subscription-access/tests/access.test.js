/**
 * Unit tests — entitlement resolution, lifecycle logic (pure), capacity vs consumption distinction.
 * node --test tests/access.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEntitlements,
  minimumPlanFor,
  getFeatureMeta,
  PLAN_ORDER,
} from '../src/plans.js';

test('inheritance — basic limits', () => {
  const e = resolveEntitlements('basic');
  assert.equal(e['meetings.duration_minutes'], 40);
  assert.equal(e['meetings.cloud_recording'], false);
  assert.equal(e['ai.meeting_summaries'], 3);
  assert.equal(e['phone.pstn'], false);
  assert.equal(e['phone.voip'], true);
});

test('inheritance — pro / business / enterprise', () => {
  const pro = resolveEntitlements('pro');
  assert.equal(pro['meetings.duration_minutes'], 1800);
  assert.equal(pro['ai.meeting_summaries'], 'unlimited');
  assert.equal(pro['storage.cloud_gb'], 10);

  const biz = resolveEntitlements('business');
  assert.equal(biz['meetings.participants'], 300);
  assert.equal(biz['phone.pstn'], true);
  assert.equal(biz['admin.sso'], true);

  const ent = resolveEntitlements('enterprise');
  assert.equal(ent['compliance.hipaa'], true);
  assert.equal(ent['storage.cloud_gb'], 500);
});

test('minimumPlanFor', () => {
  assert.equal(minimumPlanFor('meetings.host'), 'basic');
  assert.equal(minimumPlanFor('meetings.cloud_recording'), 'pro');
  assert.equal(minimumPlanFor('phone.pstn'), 'business');
  assert.equal(minimumPlanFor('compliance.hipaa'), 'enterprise');
});

test('capacity vs consumption metering', () => {
  assert.equal(getFeatureMeta('meetings.participants').metering, 'capacity');
  assert.equal(getFeatureMeta('storage.cloud_gb').metering, 'capacity');
  assert.equal(getFeatureMeta('ai.meeting_summaries').metering, 'consumption');
  assert.equal(getFeatureMeta('notes.ai_note_taking').metering, 'consumption');
  assert.equal(getFeatureMeta('meetings.cloud_recording').metering, 'none');
});

test('billing period is declared on consumption features', () => {
  assert.equal(getFeatureMeta('ai.meeting_summaries').period, 'billing');
  assert.equal(getFeatureMeta('clips.create').period, 'billing');
});

test('PLAN_ORDER', () => {
  assert.deepEqual(PLAN_ORDER, ['basic', 'pro', 'business', 'enterprise']);
});
