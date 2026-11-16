// A5.4 LAB DIAGNOSTICS ONLY. Preloaded with `node --import` (or NODE_OPTIONS) it wraps fetch() so that every HTTP request the gateway side makes carries a correlation id (`x-qorlla-trace`) and is timed:
// start (UTC), time to response headers, time to read the body, status, and the error name when it failed (for example the abort that is a request timeout). It records durations only: never URLs' query strings,
// request or response bodies, headers other than the trace id, PINs or credentials. Inert unless A54_TRACE_FILE_GW is set. Not loaded into the Meet server process.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

const FILE = process.env.A54_TRACE_FILE_GW;
if (FILE && !/server[\\/]index\.js$/.test(process.argv[1] || '')) {
  const orig = globalThis.fetch, out = (o) => { try { fs.appendFileSync(FILE, JSON.stringify(o) + '\n'); } catch { /* never affect the caller */ } };
  const mask = (u) => { try { return new URL(String(u)).pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id').replace(/\d{6,}/g, ':n').slice(0, 120); } catch { return '?'; } };
  const r1 = (x) => Math.round(x * 10) / 10;
  globalThis.fetch = async (input, init = {}) => {
    const trace = crypto.randomBytes(6).toString('hex'), url = typeof input === 'string' || input instanceof URL ? String(input) : input.url, t0 = performance.now(), startUtc = Date.now();
    const headers = new Headers(init.headers || (typeof input === 'object' && input.headers) || {}); headers.set('x-qorlla-trace', trace);
    const rec = { k: 'gw', trace, method: (init.method || 'GET').toUpperCase(), path: mask(url), startUtc, pid: process.pid };
    try {
      const r = await orig(input, { ...init, headers }); rec.status = r.status; rec.headersMs = r1(performance.now() - t0);
      for (const m of ['json', 'text']) { const f = r[m].bind(r); r[m] = async () => { const tb = performance.now(); try { return await f(); } finally { rec.bodyMs = r1(performance.now() - tb); rec.totalMs = r1(performance.now() - t0); out(rec); } }; }
      queueMicrotask(() => { /* a body that is never read is still reported below */ }); setTimeout(() => { if (rec.totalMs === undefined) { rec.totalMs = null; rec.bodyUnread = true; out(rec); } }, 10_000).unref();
      return r;
    } catch (e) { rec.err = String(e?.name || 'Error') + (e?.cause?.code ? ':' + e.cause.code : ''); rec.totalMs = r1(performance.now() - t0); out(rec); throw e; }
  };
}
