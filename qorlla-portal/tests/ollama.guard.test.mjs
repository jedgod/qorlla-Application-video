import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isPrivateAddress, createGuardedFetch, createOllamaAdapter } from '../server/ai/ollama.mjs';

test('address classes: loopback, private and overlay allowed; link-local (metadata), public, unspecified refused', () => {
  for (const ok of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.5', '100.64.0.1', '::1', 'fd12:3456::1', '::ffff:10.0.0.4']) assert.equal(isPrivateAddress(ok), true, ok);
  for (const bad of ['169.254.169.254', '8.8.8.8', '172.32.0.1', '172.15.0.1', '100.128.0.1', '0.0.0.0', 'fe80::1', '2606:4700::1111', '::ffff:169.254.169.254', 'not-an-ip']) assert.equal(isPrivateAddress(bad), false, bad);
});

function fakeServer() { return new Promise((resolve) => { const s = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }); s.listen(0, '127.0.0.1', () => resolve({ port: s.address().port, close: () => new Promise((r) => { s.close(r); s.closeAllConnections?.(); }) })); }); }

test('guarded fetch connects to a name that resolves to a private address, and refuses one that resolves to a public or metadata address', async () => {
  const srv = await fakeServer();
  try {
    const okFetch = createGuardedFetch({ lookup: (h, o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]) });
    const r = await okFetch(`http://ollama.internal:${srv.port}/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
    for (const address of ['169.254.169.254', '8.8.8.8']) {
      const bad = createGuardedFetch({ lookup: (h, o, cb) => cb(null, [{ address, family: 4 }]) });
      await assert.rejects(bad(`http://ollama.internal:${srv.port}/x`, { method: 'POST', body: '{}' }), (e) => (e.code || e.cause?.code) === 'llm_endpoint_refused', address);
    }
    const mixed = createGuardedFetch({ lookup: (h, o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }, { address: '8.8.8.8', family: 4 }]) });
    await assert.rejects(mixed(`http://ollama.internal:${srv.port}/x`, { method: 'POST', body: '{}' }), 'one public answer among private ones is refused');
  } finally { await srv.close(); }
});

test('rebinding: a name that is private at first and public later is refused at the moment of the second connection', async () => {
  const srv = await fakeServer(); let n = 0;
  try {
    const f = createGuardedFetch({ lookup: (h, o, cb) => cb(null, [{ address: n++ === 0 ? '127.0.0.1' : '169.254.169.254', family: 4 }]) });
    assert.equal((await f(`http://rebind.test:${srv.port}/`, { method: 'GET', headers: { connection: 'close' } })).status, 200);
    await assert.rejects(f(`http://rebind.test:${srv.port}/`, { method: 'GET' }), (e) => (e.code || e.cause?.code) === 'llm_endpoint_refused');
  } finally { await srv.close(); }
});

test('the adapter reports a refused endpoint as a non-retryable rejection with no address in the message', async () => {
  const a = createOllamaAdapter({ baseUrl: 'http://ollama:11434/v1', model: 'm', fetchImpl: createGuardedFetch({ lookup: (h, o, cb) => cb(null, [{ address: '169.254.169.254', family: 4 }]) }) });
  await assert.rejects(a.call({ system: 's', user: 'u' }), (e) => e.code === 'llm_rejected' && e.retryable === false && !/169\.254/.test(e.message));
});
