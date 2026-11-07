import test from 'node:test';
import assert from 'node:assert/strict';
import { createA411Worker } from '../server/telephony/a411-worker.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('worker survives failed polls, uses bounded concurrency and stops cleanly', async () => {
  const calls = [], errors = [];
  const worker = createA411Worker({
    concurrency: 2, pollMs: 100, log: { error: (...args) => errors.push(args) },
    outbox: { async runOnce(id, limit) { calls.push({ id, limit }); if (calls.length === 1) throw new Error('database unavailable'); return 0; } }
  });
  worker.start();
  assert.throws(() => worker.start(), /already running/);
  for (let n = 0; n < 30 && calls.length < 2; n++) await delay(20);
  await worker.stop();
  assert.ok(calls.length >= 2); assert.equal(calls[0].id, calls[1].id);
  assert.ok(calls.every(call => call.limit === 2));
  assert.equal(worker.health().running, false);
  assert.equal(worker.health().failures, 1);
  assert.ok(worker.health().lastSuccessAt); assert.equal(errors.length, 1);
  const total = calls.length; await delay(150); assert.equal(calls.length, total);
});

test('stop waits for an in-flight poll without starting another', async () => {
  let release, count = 0;
  const hold = new Promise(resolve => { release = resolve; });
  const worker = createA411Worker({
    pollMs: 100, log: { error() {} },
    outbox: { async runOnce() { count++; await hold; } }
  });
  worker.start();
  const stopped = worker.stop();
  assert.throws(() => worker.start(), /stopping/);
  release(); await stopped;
  assert.equal(count, 1); assert.equal(worker.health().running, false);
});

test('a timed-out drain reports failure and does not allow overlapping workers', async () => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const worker = createA411Worker({ pollMs: 100, log: { error() {} }, outbox: { runOnce: () => hold } });
  worker.start();
  await assert.rejects(worker.stop({ timeoutMs: 10 }), /drain timed out/);
  assert.throws(() => worker.start(), /stopping/);
  release(); await worker.stop();
  worker.start(); await worker.stop();
});
