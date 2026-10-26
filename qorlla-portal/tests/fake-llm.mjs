// TEST DOUBLES ONLY (not a model, not Meet). Deterministic stand-ins so the job pipeline, consent gating, idempotency, accounting and
// failure handling can be tested offline. They prove OUR logic; they say nothing about answer quality from a real model, and a passing
// run is NOT evidence that the real Anthropic / Meet integrations work.
import http from 'node:http';

const readBody = async (req) => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c).toString(); };
const listen = (server, port = 0, host = '127.0.0.1') => new Promise((r) => server.listen(port, host, r));

export async function startFakeLlm({ port = 0, host = '127.0.0.1' } = {}) {
  const st = { requests: [], mode: 'ok', calls: 0, failTimes: 0, delayMs: 0 };
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req); const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith('/__control/')) { if (req.url === '/__control/reset') { Object.assign(st, { mode: 'ok', calls: 0, failTimes: 0, delayMs: 0 }); st.requests.length = 0; } else if (req.url === '/__control/set') Object.assign(st, JSON.parse(raw || '{}')); else if (req.url === '/__control/requests') return send(200, st.requests); return send(200, { ok: true }); }
    if (req.method !== 'POST' || req.url !== '/v1/messages') return send(404, { error: 'unknown' });
    st.calls++; const body = JSON.parse(raw); st.requests.push({ headers: { key: req.headers['x-api-key'], version: req.headers['anthropic-version'] }, body });
    if (st.delayMs) await new Promise((r) => setTimeout(r, st.delayMs));
    if (req.headers['x-api-key'] !== 'test-llm-key') return send(401, { error: { message: 'bad key' } });
    if (st.mode === 'overloaded' || st.failTimes-- > 0) return send(529, { error: { message: 'overloaded' } });
    if (st.mode === 'reject') return send(400, { error: { message: 'bad request' } });
    const text = body.messages[0].content; const transcript = (/<transcript>\n([\s\S]*?)\n<\/transcript>/.exec(text) || [])[1] || '';
    if (st.mode === 'badjson') return send(200, { model: body.model, content: [{ type: 'text', text: 'Sorry, here is a poem instead.' }], usage: { input_tokens: 10, output_tokens: 5 } });
    const lines = transcript.split('\n').filter(Boolean);
    const decisions = lines.filter((l) => /\b(decided|decision)\b/i.test(l)).map((l) => l.replace(/^[^:]+:\s*/, '').slice(0, 200));
    const items = lines.map((l) => /ACTION:\s*([A-Za-z]+)\s+to\s+(.+?)(?:\s+by\s+([A-Za-z0-9 ]+))?\.?$/i.exec(l)).filter(Boolean).map((m) => ({ title: m[2].trim(), owner_hint: m[1], due_hint: m[3] ? m[3].trim() : null }));
    const speakers = [...new Set(lines.map((l) => (/^([^:]{1,60}):/.exec(l) || [])[1]).filter(Boolean))];
    const out = { summary: `TEST-DOUBLE SUMMARY of ${lines.length} lines from ${speakers.length} speaker(s): ${speakers.join(', ') || 'unknown'}.`, decisions, topics: speakers.length ? ['Discussion'] : [], action_items: items };
    send(200, { id: 'msg_test', model: body.model, content: [{ type: 'text', text: st.mode === 'fenced' ? '```json\n' + JSON.stringify(out) + '\n```' : JSON.stringify(out) }], usage: { input_tokens: Math.ceil(text.length / 4), output_tokens: Math.ceil(JSON.stringify(out).length / 4) } });
  });
  await listen(server, port, host);
  return { st, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

export const READ_SECRET = 'r'.repeat(40);
export async function startFakeMeet({ port = 0, host = '127.0.0.1' } = {}) {
  const st = { meetings: new Map(), requests: [], down: false, delayMs: 0 };
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req); const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith('/__control/')) { if (req.url === '/__control/put') { const b = JSON.parse(raw); st.meetings.set(b.id, b); } else if (req.url === '/__control/set') Object.assign(st, JSON.parse(raw || '{}')); else if (req.url === '/__control/requests') return send(200, st.requests); return send(200, { ok: true }); }
    const m = /^\/api\/integrations\/meetings\/([0-9a-f-]{36})\/chat$/.exec(req.url || '');
    st.requests.push({ url: req.url, secret: req.headers['x-qorlla-readonly-secret'] });
    if (!m) return send(404, { error: 'unknown' });
    if (st.delayMs) await new Promise((r) => setTimeout(r, st.delayMs));
    if (st.down) return send(503, { error: 'down' });
    if (req.headers['x-qorlla-readonly-secret'] !== READ_SECRET) return send(401, { error: 'Read authentication required' });
    const mt = st.meetings.get(m[1]); if (!mt) return send(404, { error: 'Meeting unavailable' });
    send(200, { meetingId: m[1], title: mt.title, messages: mt.messages });
  });
  await listen(server, port, host);
  return { st, url: `http://127.0.0.1:${server.address().port}`, put: (id, title, messages) => st.meetings.set(id, { id, title, messages }), close: () => new Promise((r) => server.close(r)) };
}
if (process.argv[1] && /[\\/]tests[\\/]fake-llm\.mjs$/.test(String(process.argv[1]))) {   // stand-alone for the browser E2E harness
  const l = await startFakeLlm({ port: Number(process.argv[2] || 19600), host: '0.0.0.0' }); const m = await startFakeMeet({ port: Number(process.argv[3] || 19601), host: '0.0.0.0' });
  console.log('fake llm (TEST DOUBLE) on ' + l.url + ' ; fake meet chat (TEST DOUBLE) on ' + m.url);
}
