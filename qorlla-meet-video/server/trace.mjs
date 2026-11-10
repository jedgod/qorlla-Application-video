// A5.4 LAB DIAGNOSTICS ONLY (inert unless A54_TRACE_FILE is set; not part of any release). Request-path timing for the real Meet server, one JSON line per request, correlated with the caller through the
// `x-qorlla-trace` header. It records durations and counters only: never bodies, PINs, tokens, credentials or SQL parameters; paths have digits/UUIDs masked; SQL is reduced to its first words.
// Durations come from a monotonic clock (performance.now); `utc` is the wall clock for correlating across processes on one host.
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

const FILE = process.env.A54_TRACE_FILE;
const als = new AsyncLocalStorage();
const out = (o) => { try { fs.appendFileSync(FILE, JSON.stringify(o) + '\n'); } catch { /* diagnostics must never affect the server */ } };
const mask = (p) => String(p).split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id').replace(/\d{6,}/g, ':n').slice(0, 120);
const op = (q) => String(typeof q === 'string' ? q : q?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
const r1 = (x) => Math.round(x * 10) / 10;

export function installTrace({ server, db }) {
  if (!FILE) return;
  if (process.env.NODE_ENV === 'production') { console.error('A54_TRACE_FILE is ignored in production: the request-path trace is lab-only'); return; }
  // event-loop lag: how late a 50 ms timer fires; the maximum since a request began is attached to it
  let lagMax = 0, last = performance.now(); const lagLog = [];
  setInterval(() => { const n = performance.now(), l = n - last - 50; last = n; if (l > lagMax) lagMax = l; if (l > 250) lagLog.push({ at: Date.now(), l: Math.round(l) }); }, 50).unref();
  const pool = () => ({ total: db.totalCount, idle: db.idleCount, waiting: db.waitingCount });
  const note = (store, rec, bgKind) => { if (store) store.db.push(rec); else if (rec.ms > 250 || !rec.ok) out({ k: 'bg', kind: bgKind, utc: Date.now(), ...rec }); };
  const timedQuery = (client, args, store) => { const t = performance.now(), o = op(args[0]); return client.query(...args).then((r) => { note(store, { k: 'q', op: o, ms: r1(performance.now() - t), ok: true }, 'query'); return r; }, (e) => { note(store, { k: 'q', op: o, ms: r1(performance.now() - t), ok: false, err: String(e.code || e.name) }, 'query'); throw e; }); };
  const origConnect = db.connect.bind(db);
  db.connect = async (...a) => {
    if (a.length) return origConnect(...a);                                                            // callback style is not used by Meet
    const store = als.getStore(), t = performance.now(), before = pool();
    let c; try { c = await origConnect(); } catch (e) { note(store, { k: 'acq', ms: r1(performance.now() - t), ok: false, err: String(e.code || e.name), pool: before }, 'acquire'); throw e; }
    note(store, { k: 'acq', ms: r1(performance.now() - t), ok: true, pool: before }, 'acquire');
    if (!c.__a54) { c.__a54 = true; const cq = c.query.bind(c); c.query = (...args) => { if (typeof args[args.length - 1] === 'function') return cq(...args); return timedQuery({ query: cq }, args, als.getStore() ?? store); }; }
    return c;
  };
  db.query = async (...args) => { const c = await db.connect(); try { return await c.query(...args); } finally { c.release(); } };    // = pool.query, with acquisition and SQL timed separately
  server.prependListener('request', (req, res) => {
    const trace = String(req.headers['x-qorlla-trace'] || '').slice(0, 16) || null, t0 = performance.now(), arrive = Date.now(), store = { trace, db: [] }, lag0 = lagMax; lagMax = 0;
    als.enterWith(store); let endAt = null; const end = res.end.bind(res); res.end = (...a) => { if (endAt === null) endAt = performance.now(); return end(...a); };
    const poolAtArrival = pool(); let done = false;
    const fin = (how) => { if (done) return; done = true; const t1 = performance.now(); out({ k: 'req', trace, method: req.method, path: mask(req.originalUrl || req.url), arriveUtc: arrive, status: res.statusCode, how, totalMs: r1(t1 - t0), handlerEndToFinishMs: endAt === null ? null : r1(t1 - endAt), lagMaxMs: r1(Math.max(lag0, lagMax)), poolAtArrival, db: store.db }); };
    res.on('finish', () => fin('finish')); res.on('close', () => fin('close'));
  });
  process.on('exit', () => { out({ k: 'lag', events: lagLog.slice(-50) }); });
}
