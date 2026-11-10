import test from 'node:test';
import assert from 'node:assert/strict';
import { startGatewayHeartbeat } from '../src/compose.js';

type Sent = [string, boolean, boolean];
const make = (probe: () => { healthy: boolean; mediaBridge: boolean }, send?: (...a: Sent) => Promise<boolean>) => {
  const sent: Sent[] = [], errors: string[] = [];
  const hb = startGatewayHeartbeat({ instance: 'gw-1', probe, intervalMs: 3_600_000, log: { error: (m) => errors.push(m) }, send: async (...a: Sent) => { sent.push(a); return send ? send(...a) : true; } });
  return { hb, sent, errors };
};

test('a healthy gateway with its media bridge reports both', async () => {
  const { hb, sent } = make(() => ({ healthy: true, mediaBridge: true })); assert.equal(await hb.tick(), true); hb.stop();
  assert.deepEqual(sent, [['gw-1', true, true]]);
});

test('a media bridge is never reported for an unhealthy gateway, and a throwing probe is unhealthy', async () => {
  const a = make(() => ({ healthy: false, mediaBridge: true })); await a.hb.tick(); a.hb.stop(); assert.deepEqual(a.sent, [['gw-1', false, false]]);
  const b = make(() => { throw new Error('boom'); }); await b.hb.tick(); b.hb.stop(); assert.deepEqual(b.sent, [['gw-1', false, false]]);
  const c = make(() => ({ healthy: true, mediaBridge: 'yes' as unknown as boolean })); await c.hb.tick(); c.hb.stop(); assert.deepEqual(c.sent, [['gw-1', true, false]], 'only the boolean true counts');
});

test('a tick that is still in flight is not overlapped, and a failed send is reported without stopping the timer', async () => {
  let release: () => void = () => undefined; const gate = new Promise<void>((r) => { release = r; });
  const slow = make(() => ({ healthy: true, mediaBridge: true }), () => gate.then(() => true));
  const first = slow.hb.tick(); assert.equal(await slow.hb.tick(), false, 'second tick skipped while the first is in flight'); release(); assert.equal(await first, true); slow.hb.stop(); assert.equal(slow.sent.length, 1);
  const bad = make(() => ({ healthy: true, mediaBridge: true }), async () => { throw new Error('meet down'); }); await assert.rejects(bad.hb.tick(), /meet down/); assert.equal(await bad.hb.tick().then(() => 'ok', () => 'rejected'), 'rejected', 'the next tick still runs'); bad.hb.stop();
});
