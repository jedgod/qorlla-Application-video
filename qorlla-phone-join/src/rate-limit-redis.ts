import type express from 'express';

/** The one Redis command the limiter needs. ioredis' `Redis` satisfies it. */
export interface RedisLike { eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> }

// Atomic fixed-window counter: increments, sets the window on the first hit (and repairs a key that lost its expiry), returns [count, ms left].
const SCRIPT = `local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local t = redis.call('PTTL', KEYS[1])
if t < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); t = tonumber(ARGV[1]) end
return {c, t}`;

export type LimiterOptions = {
  redis: RedisLike;
  windowMs: number;
  max: number;
  /** Key prefix, one per limiter (for example 'pj:ip'). */
  prefix: string;
  /** What is being limited. Return null to refuse the request (no usable identity is not a reason to let it through). */
  keyOf: (req: express.Request) => string | null;
  /** Redis must answer within this time (default 500 ms) or the request is refused. */
  timeoutMs?: number;
  onError?: (e: unknown) => void;
};

/**
 * Distributed rate limit for telephone admission, FAIL CLOSED: when Redis is down, slow, or answers something unexpected, the request is refused with 503 - it is never waved through.
 * Over the limit -> 429 with Retry-After. Shared across every gateway replica because the counter lives in Redis.
 */
export function createRedisRateLimiter(o: LimiterOptions): express.RequestHandler {
  const timeoutMs = o.timeoutMs ?? 500;
  return async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const key = o.keyOf(req); if (!key) return void res.status(400).json({ code: 'INVALID_REQUEST' });
    let count: number, ttl: number;
    try {
      let timer: ReturnType<typeof setTimeout>;
      const out = await Promise.race([o.redis.eval(SCRIPT, 1, o.prefix + ':' + key, o.windowMs), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('redis timeout')), timeoutMs); })]).finally(() => clearTimeout(timer));
      if (!Array.isArray(out) || out.length !== 2 || !Number.isFinite(Number(out[0])) || !Number.isFinite(Number(out[1]))) throw new Error('unexpected redis answer');
      count = Number(out[0]); ttl = Number(out[1]);
    } catch (e) { try { o.onError?.(e); } catch { /* reporting must not break the refusal */ } return void res.status(503).json({ code: 'RATE_LIMITER_UNAVAILABLE' }); }
    if (count > o.max) { res.setHeader('Retry-After', String(Math.max(1, Math.ceil(ttl / 1000)))); return void res.status(429).json({ code: 'RATE_LIMITED' }); }
    next();
  };
}

/** Runs several limiters in order; the first one that answers (429/503) ends the request. */
export const allLimits = (...limiters: express.RequestHandler[]): express.RequestHandler => (req, res, next) => {
  let i = 0; const step = (err?: unknown) => { if (err) return next(err as Error); if (i >= limiters.length) return next(); limiters[i++](req, res, step); };
  step();
};
