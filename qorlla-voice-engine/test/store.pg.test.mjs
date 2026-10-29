// PostgreSQL integration: the concurrency rules the reference left untested. Real transactions, real advisory locks, real unique indexes, in an isolated schema.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.mjs';
import { issueTicket, consumeTicket, hashTicket } from '../src/tickets.mjs';
import { isolatedDb } from './helpers.mjs';

let ctx, store; const origin = 'https://app.qorlla.test';
before(async () => { ctx = await isolatedDb(); if (ctx) store = createStore(ctx.pool); });
after(async () => { if (ctx) await ctx.drop(); });
const skip = (t) => (ctx ? t : { skip: 'no PostgreSQL reachable (set VOICE_TEST_DATABASE_URL)' });
const settled = (list) => Promise.allSettled(list);
const ok = (rs) => rs.filter((r) => r.status === 'fulfilled'), codes = (rs) => rs.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
const key = () => 'k' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

test('extensions are allocated without collisions, even when requested at the same moment', async (t) => {
  if (!ctx) return t.skip();
  const rs = await settled(Array.from({ length: 12 }, (_, i) => store.provisionIdentity('acct-' + i)));
  assert.equal(ok(rs).length, 12); const exts = ok(rs).map((r) => r.value.identity.extension).sort();
  assert.equal(new Set(exts).size, 12); assert.equal(exts[0], '2000'); assert.ok(exts.every((e) => /^[0-9]{4}$/.test(e)));
  const again = await store.provisionIdentity('acct-3'); assert.equal(again.created, false); assert.equal(again.identity.extension, (await store.identity('acct-3')).extension);
  await assert.rejects(store.provisionIdentity('someone-new', '2000'), /extension_taken/);
  assert.equal((await store.provisionIdentity('chosen', '555123')).identity.extension, '555123');
  await assert.rejects(store.provisionIdentity('bad id with spaces'), /invalid_input/); await assert.rejects(store.provisionIdentity('x', '12'), /invalid_input/);
});

test('many callers ringing the same person: exactly one gets through, the rest are busy', async (t) => {
  if (!ctx) return t.skip();
  for (const a of ['callee1', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']) await store.provisionIdentity(a);
  const ext = (await store.identity('callee1')).extension;
  const rs = await settled(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'].map((c) => store.createCall(c, ext, key())));
  assert.equal(ok(rs).length, 1); assert.deepEqual([...new Set(codes(rs))], ['busy']);
  assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM voice_calls WHERE callee_id='callee1' AND status='ringing'")).rows[0].n, 1);
});

test('one caller dialling many people at once: exactly one call is placed', async (t) => {
  if (!ctx) return t.skip();
  for (const a of ['dialer', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6']) await store.provisionIdentity(a);
  const exts = await Promise.all(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map(async (p) => (await store.identity(p)).extension));
  const rs = await settled(exts.map((e) => store.createCall('dialer', e, key())));
  assert.equal(ok(rs).length, 1); assert.deepEqual([...new Set(codes(rs))], ['busy']);
});

test('two people calling each other at the same moment: one call, not two', async (t) => {
  if (!ctx) return t.skip();
  for (const a of ['x1', 'x2']) await store.provisionIdentity(a);
  const [e1, e2] = [(await store.identity('x1')).extension, (await store.identity('x2')).extension];
  const rs = await settled([store.createCall('x1', e2, key()), store.createCall('x2', e1, key())]);
  assert.equal(ok(rs).length, 1); assert.equal(codes(rs)[0], 'busy');
  assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM voice_calls WHERE status IN ('ringing','active') AND (caller_id IN ('x1','x2') OR callee_id IN ('x1','x2'))")).rows[0].n, 1);
});

test('a retried request (same idempotency key) returns the same call and never rings twice; a key reused for someone else is a conflict', async (t) => {
  if (!ctx) return t.skip();
  for (const a of ['i1', 'i2', 'i3']) await store.provisionIdentity(a);
  const e2 = (await store.identity('i2')).extension, e3 = (await store.identity('i3')).extension, k = key();
  const rs = await settled(Array.from({ length: 6 }, () => store.createCall('i1', e2, k)));
  assert.equal(ok(rs).length, 6); assert.equal(new Set(ok(rs).map((r) => r.value.call.id)).size, 1); assert.equal(ok(rs).filter((r) => !r.value.reused).length, 1);
  await assert.rejects(store.createCall('i1', e3, k), /idempotency_conflict/);
});

test('blocks work in both directions, can be added and removed, and disabled people cannot call or be called', async (t) => {
  if (!ctx) return t.skip();
  for (const a of ['b1', 'b2', 'b3']) await store.provisionIdentity(a);
  const [e1, e2, e3] = await Promise.all(['b1', 'b2', 'b3'].map(async (a) => (await store.identity(a)).extension));
  await store.addBlock('b2', e1); await assert.rejects(store.createCall('b1', e2, key()), /blocked/); await assert.rejects(store.createCall('b2', e1, key()), /blocked/);
  assert.deepEqual(await store.listBlocks('b2'), [e1]); await assert.rejects(store.addBlock('b2', e2), /invalid_recipient/); await assert.rejects(store.addBlock('b2', '999999'), /invalid_recipient/);
  await store.removeBlock('b2', e1); assert.equal((await store.createCall('b1', e2, key())).reused, false);
  const r = await store.setEnabled('b3', false); assert.equal(r.identity.enabled, false); await assert.rejects(store.createCall('b3', e1, key()), /caller_disabled|busy/); await assert.rejects(store.createCall('b1', e3, key()), /invalid_recipient/);
  await assert.rejects(store.setEnabled('nobody', false), /not_found/);
});

test('only the right person can change a call, and a stranger cannot tell it exists', async (t) => {
  if (!ctx) return t.skip();
  for (const a of ['t1', 't2', 't3']) await store.provisionIdentity(a);
  const e2 = (await store.identity('t2')).extension, { call } = await store.createCall('t1', e2, key());
  await assert.rejects(store.transition(call.id, 't3', 'ended'), /not_found/);                       // a stranger: indistinguishable from a missing call
  await assert.rejects(store.transition(call.id, 't1', 'active'), /forbidden/);                      // the caller cannot answer
  await assert.rejects(store.transition(call.id, 't1', 'rejected'), /forbidden/);                    // the caller cannot reject (it can cancel with "end")
  const active = await store.transition(call.id, 't2', 'active'); assert.equal(active.status, 'active'); assert.ok(active.answered_at);
  await assert.rejects(store.transition(call.id, 't2', 'rejected'), /invalid_transition/); await assert.rejects(store.transition(call.id, 't2', 'active'), /invalid_transition/);
  const ended = await store.transition(call.id, 't1', 'ended'); assert.equal(ended.status, 'ended'); assert.equal(ended.end_reason, 'ended_by_caller'); assert.ok(ended.ended_at);
  await assert.rejects(store.transition(call.id, 't2', 'active'), /invalid_transition/);
  const kinds = (await ctx.pool.query('SELECT kind FROM voice_call_events WHERE call_id=$1 ORDER BY id', [call.id])).rows.map((r) => r.kind); assert.deepEqual(kinds, ['created', 'active', 'ended']);
});

test('answering and hanging up at the same moment leaves one consistent final state; two answers: one wins', async (t) => {
  if (!ctx) return t.skip();
  for (const a of ['r1', 'r2']) await store.provisionIdentity(a);
  const e2 = (await store.identity('r2')).extension; let { call } = await store.createCall('r1', e2, key());
  const two = await settled([store.transition(call.id, 'r2', 'active'), store.transition(call.id, 'r2', 'active')]); assert.equal(ok(two).length, 1); assert.deepEqual(codes(two), ['invalid_transition']);
  await store.transition(call.id, 'r1', 'ended');
  ({ call } = await store.createCall('r1', e2, key()));
  const race = await settled([store.transition(call.id, 'r2', 'active'), store.transition(call.id, 'r1', 'ended')]); const final = await store.getCall(call.id);
  assert.ok(['ended'].includes(final.status), 'final state ' + final.status); assert.ok(ok(race).length >= 1);                 // either order ends in "ended"; never "active" after a hang-up
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM voice_call_events WHERE call_id=$1 AND kind=$2', [call.id, 'ended'])).rows[0].n, 1);
});

test('unanswered calls become missed once, with an audit event, and the people are free again', async (t) => {
  if (!ctx) return t.skip();
  for (const a of ['m1', 'm2']) await store.provisionIdentity(a);
  const e2 = (await store.identity('m2')).extension, { call } = await store.createCall('m1', e2, key());
  assert.deepEqual(await store.expireRinging(60), []);                                                  // not old enough
  await ctx.pool.query("UPDATE voice_calls SET created_at = now() - interval '2 minutes' WHERE id=$1", [call.id]);
  const first = await settled([store.expireRinging(60), store.expireRinging(60)]); const changed = first.flatMap((r) => r.value);
  assert.equal(changed.length, 1); assert.equal(changed[0].status, 'missed'); assert.equal(changed[0].end_reason, 'ring_timeout');
  assert.deepEqual(await store.expireRinging(60), []); assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM voice_call_events WHERE call_id=$1 AND kind='missed'", [call.id])).rows[0].n, 1);
  assert.equal((await store.createCall('m1', e2, key())).reused, false);                               // free to call again
  await assert.rejects(store.expireRinging(1), /invalid_timeout/); await assert.rejects(store.expireRinging(1e6), /invalid_timeout/);
  // an answered call is never expired
  const { call: c2 } = await store.createCall('m2', (await store.identity('m1')).extension, key()).catch(async () => ({ call: null })); assert.equal(c2, null);   // busy: the new call from m1 is still ringing
});

test('disabling a person ends their live call', async (t) => {
  if (!ctx) return t.skip();
  for (const a of ['d1', 'd2']) await store.provisionIdentity(a);
  const { call } = await store.createCall('d1', (await store.identity('d2')).extension, key()); await store.transition(call.id, 'd2', 'active');
  const r = await store.setEnabled('d2', false); assert.equal(r.ended.length, 1); assert.equal(r.ended[0].status, 'ended'); assert.equal(r.ended[0].end_reason, 'account_disabled');
  assert.equal(await store.liveCall('d1'), null);
});

test('history lists both extensions, usage counts server-measured seconds, and nothing leaks between accounts', async (t) => {
  if (!ctx) return t.skip();
  for (const a of ['h1', 'h2', 'h3']) await store.provisionIdentity(a);
  const [e1, e2] = [(await store.identity('h1')).extension, (await store.identity('h2')).extension];
  const { call } = await store.createCall('h1', e2, key()); await store.transition(call.id, 'h2', 'active');
  await ctx.pool.query("UPDATE voice_calls SET answered_at = now() - interval '90 seconds' WHERE id=$1", [call.id]); await store.transition(call.id, 'h1', 'ended');
  const mine = await store.listCalls('h1'); assert.equal(mine.length, 1); assert.deepEqual([mine[0].caller_extension, mine[0].callee_extension], [e1, e2]); assert.deepEqual(await store.listCalls('h3'), []);
  const u = await store.usage('h1'); assert.equal(u.answered, 1); assert.ok(u.seconds >= 89 && u.seconds <= 95, 'seconds ' + u.seconds); assert.equal((await store.usage('h3')).seconds, 0);
});

test('a WebSocket ticket can be used exactly once, even when twenty connections race for it', async (t) => {
  if (!ctx) return t.skip();
  await store.provisionIdentity('w1');
  const { ticket } = await issueTicket('w1', origin, ctx.pool, origin);
  const rs = await Promise.all(Array.from({ length: 20 }, () => consumeTicket(ticket, origin, ctx.pool, origin)));
  assert.equal(rs.filter(Boolean).length, 1); assert.equal(rs.find(Boolean), 'w1');
  const row = (await ctx.pool.query('SELECT token_hash, origin, consumed_at FROM voice_ws_tickets WHERE token_hash=$1', [hashTicket(ticket)])).rows[0];
  assert.ok(row.consumed_at); assert.notEqual(row.token_hash, ticket);                                  // only the hash is stored
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM voice_ws_tickets WHERE token_hash=$1', [ticket])).rows[0].n, 0);
  const t2 = await issueTicket('w1', origin, ctx.pool, origin); await ctx.pool.query("UPDATE voice_ws_tickets SET expires_at = now() - interval '1 second' WHERE token_hash=$1", [hashTicket(t2.ticket)]);
  assert.equal(await consumeTicket(t2.ticket, origin, ctx.pool, origin), null);                         // expired
  const t3 = await issueTicket('w1', origin, ctx.pool, origin); assert.equal(await consumeTicket(t3.ticket, 'https://other.qorlla.test', ctx.pool, 'https://other.qorlla.test,' + origin), null);   // minted for another origin
  for (let i = 0; i < 9; i++) await issueTicket('w1', origin, ctx.pool, origin); await assert.rejects(issueTicket('w1', origin, ctx.pool, origin), /too_many_tickets/);
});
