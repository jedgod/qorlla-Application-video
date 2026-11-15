import test from 'node:test';
import assert from 'node:assert/strict';
import { createSignalBudget } from '../server/signal-budget.mjs';
test('signaling admits normal ICE bursts, bounds sustained floods and resets windows independently', () => {
  let now = 0; const allow = createSignalBudget(() => now);
  for (let window = 0; window < 5; window++) {
    now = window * 1000;
    for (let i = 0; i < 120; i++) assert.equal(allow(), true);
    assert.equal(allow(), false);
  }
  now = 5000; assert.equal(allow(), false, 'sustained budget survives burst reset');
  now = 10000; assert.equal(allow(), true);
  const other = createSignalBudget(() => now);
  assert.equal(other(), true, 'a different participant has an independent budget');
});
