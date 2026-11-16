import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Redis } from 'ioredis';
import { createRedisRateLimiter, allLimits, type RedisLike } from '../src/rate-limit-redis.js';
import { listen, closeAllServers } from './support.js';

const REDIS_URL = process.env.PHONE_JOIN_TEST_REDIS_URL, skip = REDIS_URL ? false : 'PHONE_JOIN_TEST_REDIS_URL is not set';
const app = (limiter: express.RequestHandler) => { const a = express(); a.post('/x', limiter, (_req, res) => res.json({ ok: true })); return a; };
const hit = (url: string, ip = 'a') => fetch(url + '/x', { method: 'POST', headers: { 'x-test-id': ip } });
const keyOf = (req: express.Request) => String(req.get('x-test-id') || '') || null;
// a one-process fake with the same semantics as the Lua script
const fakeRedis = (): RedisLike & { store: Map<string, { n: number; until: number }> } => { const store = new Map<string, { n: number; until: number }>(); return { store, eval: async (_s, _n, key, win) => { const k = String(key), now = Date.now(); let e = store.get(k); if (!e || e.until <= now) { e = { n: 0, until: now + Number(win) }; store.set(k, e); } e.n++; return [e.n, e.until - now]; } }; };

test('limiter: allows up to max per window, then 429 with Retry-After; keys are independent', async () => {
  const s = await listen(app(createRedisRateLimiter({ redis: fakeRedis(), windowMs: 60_000, max: 3, prefix: 't', keyOf })));
  for (let i = 0; i < 3; i++) assert.equal((await hit(s.url)).status, 200);
  const over = await hit(s.url); assert.equal(over.status, 429); assert.ok(Number(over.headers.get('retry-after')) >= 1); assert.deepEqual(await over.json(), { code: 'RATE_LIMITED' });
  assert.equal((await hit(s.url, 'b')).status, 200, 'another key is unaffected'); await s.close();
});
test('limiter FAILS CLOSED: Redis errors, hangs, malformed answers and a missing identity are all refused, never waved through', async () => {
  const run = async (redis: RedisLike, opts: { timeoutMs?: number; key?: boolean } = {}) => { const errors: unknown[] = []; const s = await listen(app(createRedisRateLimiter({ redis, windowMs: 1000, max: 100, prefix: 't', keyOf: opts.key === false ? () => null : keyOf, timeoutMs: opts.timeoutMs, onError: (e) => errors.push(e) }))); const r = await hit(s.url); await s.close(); return { status: r.status, code: ((await r.json()) as any).code, errors: errors.length }; };
  assert.deepEqual(await run({ eval: async () => { throw new Error('ECONNREFUSED'); } }), { status: 503, code: 'RATE_LIMITER_UNAVAILABLE', errors: 1 });
  assert.deepEqual(await run({ eval: () => new Promise(() => {}) }, { timeoutMs: 50 }), { status: 503, code: 'RATE_LIMITER_UNAVAILABLE', errors: 1 });
  for (const bad of [null, 'OK', [1], [NaN, 5], ['x', 'y'], undefined]) assert.equal((await run({ eval: async () => bad })).status, 503, JSON.stringify(bad));
  assert.equal((await run(fakeRedis(), { key: false })).status, 400, 'no identity to count against');
});
test('limiters compose: the first refusal ends the request and later limiters are not charged', async () => {
  const r = fakeRedis(); const tight = createRedisRateLimiter({ redis: r, windowMs: 60_000, max: 1, prefix: 'tight', keyOf }), wide = createRedisRateLimiter({ redis: r, windowMs: 60_000, max: 100, prefix: 'wide', keyOf });
  const s = await listen(app(allLimits(tight, wide))); assert.equal((await hit(s.url)).status, 200); assert.equal((await hit(s.url)).status, 429);
  assert.equal(r.store.get('wide:a')!.n, 1, 'the wide limiter was not charged for the refused request'); await s.close();
});

test('REAL Redis: 60 concurrent requests, limit 10 - exactly 10 pass, across two separate connections ("replicas")', { skip }, async () => {
  const c1 = new Redis(REDIS_URL!), c2 = new Redis(REDIS_URL!), prefix = 'pjtest:' + Math.random().toString(36).slice(2, 8);
  try {
    const mk = (c: Redis) => listen(app(createRedisRateLimiter({ redis: c as unknown as RedisLike, windowMs: 30_000, max: 10, prefix, keyOf })));
    const [a, b] = await Promise.all([mk(c1), mk(c2)]);
    const codes = await Promise.all(Array.from({ length: 60 }, (_, i) => hit(i % 2 ? a.url : b.url, 'same').then((r) => r.status)));
    assert.equal(codes.filter((x) => x === 200).length, 10); assert.equal(codes.filter((x) => x === 429).length, 50);
    const ttl = await c1.pttl(prefix + ':same'); assert.ok(ttl > 0 && ttl <= 30_000, 'the window has an expiry');
    await a.close(); await b.close();
  } finally { await c1.quit(); await c2.quit(); }
});
test('REAL Redis: the window resets after it expires', { skip }, async () => {
  const c = new Redis(REDIS_URL!), prefix = 'pjtest:' + Math.random().toString(36).slice(2, 8);
  try { const s = await listen(app(createRedisRateLimiter({ redis: c as unknown as RedisLike, windowMs: 400, max: 1, prefix, keyOf }))); assert.equal((await hit(s.url)).status, 200); assert.equal((await hit(s.url)).status, 429); await new Promise((r) => setTimeout(r, 500)); assert.equal((await hit(s.url)).status, 200); await s.close(); }
  finally { await c.quit(); }
});
test('REAL Redis down: the request is refused (503), not allowed', { skip }, async () => {
  const dead = new Redis({ host: '127.0.0.1', port: 1, lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null }); dead.on('error', () => undefined);
  const s = await listen(app(createRedisRateLimiter({ redis: dead as unknown as RedisLike, windowMs: 1000, max: 5, prefix: 'x', keyOf, timeoutMs: 800 }))); const r = await hit(s.url); assert.equal(r.status, 503); assert.equal(((await r.json()) as any).code, 'RATE_LIMITER_UNAVAILABLE'); await s.close(); dead.disconnect();
});
test.after(closeAllServers);
