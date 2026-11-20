// Diagnosis for the Phone / Meet browser suites: collects what both pages saw (console, failed requests, the voice WebSocket frames) and, when a test fails, writes it together with the
// client state, the call rows and events from PostgreSQL, the engine log and the Meet log, so an intermittent failure is explained by evidence instead of retried.
const fs = require('node:fs');
const path = require('node:path');
function watch(page, tag, log, t0) {
  const at = () => Date.now() - t0;
  page.on('console', (m) => { if (!/DevTools|ERR_CONNECTION_REFUSED/.test(m.text())) log.push([at(), tag, 'console.' + m.type(), m.text().slice(0, 240)]); });
  page.on('close', () => log.push([at(), tag, 'page.closed', ''])); page.on('framenavigated', (f) => { if (f === page.mainFrame()) log.push([at(), tag, 'nav', f.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 110)]); });
  page.on('pageerror', (e) => log.push([at(), tag, 'pageerror', String(e).slice(0, 300)]));
  page.on('requestfailed', (r) => log.push([at(), tag, 'requestfailed', r.method() + ' ' + r.url().replace(/^https?:\/\/[^/]+/, '') + ' ' + (r.failure() || {}).errorText]));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/socket\.io\//.test(r.url())) { log.push([at(), tag, 'http.' + r.status(), r.request().method() + ' ' + r.url().replace(/^https?:\/\/[^/]+/, '')]); r.text().then((t) => log.push([at(), tag, 'http.body', String(t).slice(0, 220)])).catch(() => {}); } });
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) log.push([at(), tag, 'navigated', f.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 100)]); });
  page.on('websocket', (ws) => { if (!/\/v1\/voice\/ws/.test(ws.url())) return; log.push([at(), tag, 'ws.open', '']); ws.on('framereceived', (f) => log.push([at(), tag, 'ws.recv', String(f.payload).slice(0, 160)])); ws.on('framesent', (f) => log.push([at(), tag, 'ws.sent', String(f.payload).slice(0, 160)])); ws.on('close', () => log.push([at(), tag, 'ws.close', ''])); });
}
const clientState = (p) => p.evaluate(() => { const c = window.qorllaVoice; if (!c) return null; const g = (id) => document.getElementById(id); return { ws: c.ws && c.ws.readyState, callId: c.callId, role: c.role, ringing: [...c.ringing], pc: c.pc && c.pc.connectionState, ice: c.pc && c.pc.iceConnectionState, ctl: c.ctl && c.ctl.readyState, peerCaps: c.peerCaps, muted: c.muted, cursor: c.log && c.log.cursor, status: (g('vbStatus') || {}).textContent, bar: g('voiceBar') && !g('voiceBar').classList.contains('hidden'), incoming: g('voiceIncoming') && g('voiceIncoming').open, ask: g('voiceAsk') && g('voiceAsk').open, moveBar: g('voiceMoveBar') && !g('voiceMoveBar').classList.contains('hidden'), moveText: (g('vmbText') || {}).textContent }; }).catch((e) => ({ error: String(e).slice(0, 100) }));
async function dump({ dir, name, log, pages, pool, stack, meetLog }) {
  fs.mkdirSync(dir, { recursive: true });
  const calls = pool ? await pool.query('SELECT id, caller_id, callee_id, status, end_reason, created_at, answered_at, ended_at FROM voice_calls ORDER BY created_at DESC LIMIT 3').then((r) => r.rows).catch(() => []) : [];
  const events = pool && calls.length ? await pool.query('SELECT * FROM voice_call_events WHERE call_id = ANY($1) ORDER BY 1', [calls.map((c) => c.id)]).then((r) => r.rows).catch(() => []) : [];
  const handoffs = pool ? await pool.query('SELECT call_id, status, closed_reason, created_at, accepted_at, init_ready_at, recip_ready_at, init_session, recip_session, init_first, init_last, recip_first, recip_last, now() AS db_now FROM voice_handoffs ORDER BY created_at DESC LIMIT 3').then((r) => r.rows).catch(() => []) : [];
  const states = {}; for (const [k, p] of Object.entries(pages || {})) states[k] = p && !p.isClosed() ? await clientState(p) : 'closed';
  let meet = ''; try { meet = fs.readFileSync(meetLog, 'utf8').slice(-1500); } catch (e) { /* no log */ }
  const activity = pool ? await pool.query("SELECT state, wait_event_type, wait_event, now()-query_start AS age, left(query,90) AS q FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()").then((r) => r.rows).catch(() => []) : [];
  fs.writeFileSync(path.join(dir, name.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60) + '-' + Date.now() + '.json'), JSON.stringify({ name, states, calls, events, handoffs, activity, mainLog: stack && stack.main && stack.main.log ? stack.main.log.join('').slice(-2500) : '', log, engine: stack ? stack.log.join('').slice(-6000) : '', meet }, null, 2));
}
module.exports = { watch, clientState, dump };
