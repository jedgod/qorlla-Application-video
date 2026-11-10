import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// trace.mjs reads A54_TRACE_FILE once at import, so each case imports a fresh copy.
let n = 0;
const load = async (env) => {
  const keep = { f: process.env.A54_TRACE_FILE, n: process.env.NODE_ENV };
  for (const k of ['A54_TRACE_FILE', 'NODE_ENV']) delete process.env[k];
  Object.assign(process.env, env);
  try { return await import('../server/trace.mjs?case=' + ++n); }
  finally { for (const [k, v] of [['A54_TRACE_FILE', keep.f], ['NODE_ENV', keep.n]]) v === undefined ? delete process.env[k] : (process.env[k] = v); }
};
const fakeDb = () => { const db = { totalCount: 1, idleCount: 1, waitingCount: 0, connect: async () => ({ query: async () => ({ rows: [] }), release() {} }), query: async () => ({ rows: [] }) }; return db; };

test('inert without A54_TRACE_FILE: nothing is patched and no listener is added', async () => {
  const { installTrace } = await load({});
  const db = fakeDb(), connect = db.connect, query = db.query, server = new EventEmitter();
  installTrace({ server, db });
  assert.equal(db.connect, connect); assert.equal(db.query, query); assert.equal(server.listenerCount('request'), 0);
});

test('refused in production even when A54_TRACE_FILE is set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a54-'));
  try {
    const file = join(dir, 'trace.jsonl');
    const { installTrace } = await load({ A54_TRACE_FILE: file, NODE_ENV: 'production' });
    const db = fakeDb(), connect = db.connect, server = new EventEmitter();
    const warn = console.error; console.error = () => {};
    process.env.NODE_ENV = 'production';
    try { installTrace({ server, db }); } finally { console.error = warn; delete process.env.NODE_ENV; }
    assert.equal(db.connect, connect); assert.equal(server.listenerCount('request'), 0); assert.equal(existsSync(file), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('when enabled it records timings with masked paths and never bodies, query strings or SQL parameters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a54-'));
  try {
    const file = join(dir, 'trace.jsonl');
    const { installTrace } = await load({ A54_TRACE_FILE: file });
    const db = fakeDb(), server = new EventEmitter();
    installTrace({ server, db });
    const req = { method: 'POST', headers: { 'x-qorlla-trace': 'abc123' }, originalUrl: '/api/phone/calls/3f2b1c9e-1111-4222-8333-444455556666/verify?pin=987654&token=secret' };
    const res = new EventEmitter(); res.statusCode = 200; res.end = () => {};
    server.emit('request', req, res);
    await db.query('SELECT * FROM phone_calls WHERE pin=$1', ['987654']);
    res.end(); res.emit('finish');
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)), rec = lines.find(l => l.k === 'req');
    assert.equal(rec.trace, 'abc123'); assert.equal(rec.status, 200); assert.equal(rec.path, '/api/phone/calls/:id/verify');
    assert.ok(rec.db.some(d => d.k === 'q' && d.ok), 'the query is timed');
    const text = readFileSync(file, 'utf8');
    for (const secret of ['987654', 'secret', '3f2b1c9e']) assert.equal(text.includes(secret), false, 'leaked ' + secret);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
