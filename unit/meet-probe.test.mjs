import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createMeetProbe } = createRequire(import.meta.url)('../meet-probe.js');

const clock = () => { let t = 1_000_000; return { now: () => t, tick: (ms) => { t += ms; } }; };

test('a working Meet is reported, and asked again only after the refresh interval', async () => {
  const c = clock(); let calls = 0, p = createMeetProbe({ check: async () => { calls++; return 3310; }, now: c.now });
  assert.equal(await p(), 3310); assert.equal(await p(), 3310); assert.equal(calls, 1, 'cached inside the refresh interval'); c.tick(4001); assert.equal(await p(), 3310); assert.equal(calls, 2);
});

test('ONE slow or failed answer does not make Meet "gone": the last good address is kept for the grace period', async () => {
  const c = clock(); let ok = true, p = createMeetProbe({ check: async () => { if (!ok) throw new Error('timeout'); return 3310; }, now: c.now });
  assert.equal(await p(), 3310); ok = false; c.tick(4001);
  assert.equal(await p(), 3310, 'a single failure inside the grace period still answers with Meet’s address'); c.tick(4001); assert.equal(await p(), 3310, 'and so does the next one, until the grace ends');
});

test('Meet that is genuinely gone is reported as gone once the grace period has passed, and comes back as soon as it answers', async () => {
  const c = clock(); let ok = true, p = createMeetProbe({ check: async () => { if (!ok) throw new Error('refused'); return 3310; }, now: c.now, graceMs: 60000 });
  assert.equal(await p(), 3310); ok = false; for (let i = 0; i < 16; i++) { c.tick(4001); await p(); } assert.equal(await p(), 0, 'after more than a minute of failures Meet is reported as gone');
  ok = true; c.tick(4001); assert.equal(await p(), 3310, 'and it is found again as soon as it answers');
});

test('a Meet that was never found is reported as not running (no grace for something that never answered)', async () => {
  const c = clock(), p = createMeetProbe({ check: async () => 0, now: c.now }); assert.equal(await p(), 0);
});
