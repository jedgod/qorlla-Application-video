import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { meetSignaling } from '../src/media/meet-signaling.js';
import { eventually, sleep } from './support.js';

/**
 * The socket.io binding against a server that follows Qorlla Meet's relay contract as read from server/index.js (auth token in the handshake, a `roster` event on connect, `signal` relayed to ONE online participant
 * with an ack, `participant-offline`, only offer/answer/candidate accepted). It is NOT the real Meet: running it against the real server needs the Meet-side credential for the verification phase (open design point).
 */
const jwt = (payload: object) => ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');
const GOOD = jwt({ meetingId: 'm1', participantId: 'p-gateway', role: 'phone' });
async function fakeMeet() {
  const server = http.createServer(), srv = new Server(server), online = new Map<string, string>(), log: string[] = [];
  srv.use((socket, next) => { const t = String(socket.handshake.auth?.token ?? ''); if (t === GOOD) { socket.data.pid = 'p-gateway'; return next(); } if (t === 'browser-token') { socket.data.pid = 'p-browser'; return next(); } next(new Error('Unauthorized')); });
  srv.on('connection', (socket) => {
    const pid = socket.data.pid as string; online.set(pid, socket.id); socket.emit('roster', [...online.keys()].filter((x) => x !== pid).concat(pid === 'p-gateway' ? ['p-browser'] : []));
    socket.on('signal', ({ to, data }: { to?: string; data?: { type?: string } } = {}, ack?: (r: unknown) => void) => {
      if (typeof to !== 'string' || !data || !['offer', 'answer', 'candidate'].includes(String(data.type))) { log.push('rejected:' + data?.type); return ack?.({ ok: false }); }
      const target = online.get(to); if (!target) return ack?.({ ok: false }); srv.to(target).emit('signal', { from: pid, data }); ack?.({ ok: true });
    });
    socket.on('disconnect', () => { online.delete(pid); socket.broadcast.emit('participant-offline', { participantId: pid }); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  return { url, srv, online, log, close: () => new Promise<void>((r) => { void srv.close(() => r()); }) };
}
const live: (() => Promise<void> | void)[] = []; test.afterEach(async () => { for (const l of live.splice(0).reverse()) await l(); });
const args = (signal = new AbortController().signal) => ({ callId: 'sip_x', meetingSessionId: 's', mediaToken: 't', signal });

test('joins with the Meet-issued participant token, learns its own id from it, and receives the roster', async () => {
  const m = await fakeMeet(); live.push(m.close); const port = await meetSignaling({ baseUrl: m.url, token: async () => GOOD })(args()); live.push(() => port.close());
  assert.equal(port.selfId, 'p-gateway'); assert.deepEqual(port.roster(), ['p-browser'], 'the roster never includes ourselves'); assert.ok(m.online.has('p-gateway'));
});
test('signals flow both ways in Meet\'s wire format; a leaving participant is reported; closing releases the socket and the roster entry', async () => {
  const m = await fakeMeet(); live.push(m.close); const port = await meetSignaling({ baseUrl: m.url, token: async () => GOOD })(args()); const got: unknown[] = [], left: string[] = []; let closed = 0;
  port.onSignal((f, d) => got.push([f, d])); port.onPeerLeft((id) => left.push(id)); port.onClosed(() => closed++);
  const browser = connect(m.url, { auth: { token: 'browser-token' }, transports: ['websocket'], reconnection: false }); live.push(() => { browser.disconnect(); }); const inbound: unknown[] = []; browser.on('signal', (x) => inbound.push(x)); await eventually(() => browser.connected);
  browser.emit('signal', { to: 'p-gateway', data: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0' }, epoch: 'e1' } }); await eventually(() => got.length === 1); assert.deepEqual(got[0], ['p-browser', { type: 'offer', sdp: { type: 'offer', sdp: 'v=0' }, epoch: 'e1' }]);
  port.send('p-browser', { type: 'answer', sdp: { type: 'answer', sdp: 'v=0' }, epoch: 'e1' }); await eventually(() => inbound.length === 1); assert.deepEqual(inbound[0], { from: 'p-gateway', data: { type: 'answer', sdp: { type: 'answer', sdp: 'v=0' }, epoch: 'e1' } });
  port.send('p-nobody', { type: 'candidate', candidate: {}, epoch: 'e1' }); browser.disconnect(); await eventually(() => left.includes('p-browser'));
  port.close(); port.close(); await eventually(() => !m.online.has('p-gateway')); assert.equal(closed, 1, 'closed once'); port.send('p-browser', { type: 'offer', sdp: { type: 'offer', sdp: 'v=0' }, epoch: 'e2' });
});
test('a refused token, an unreachable server, a token without a participant id and a cancelled join all fail fast and leave nothing connected', async () => {
  const m = await fakeMeet(); live.push(m.close);
  await assert.rejects(meetSignaling({ baseUrl: m.url, token: async () => jwt({ participantId: 'p-gateway' }) + 'x' })(args()), /refused: Unauthorized/); await assert.rejects(meetSignaling({ baseUrl: m.url, token: async () => 'garbage' })(args()), /no participant id/);
  await assert.rejects(meetSignaling({ baseUrl: 'http://127.0.0.1:9', token: async () => GOOD, connectTimeoutMs: 1500 })(args()), /refused|timed out/);
  const ctl = new AbortController(); const joining = meetSignaling({ baseUrl: m.url, token: async () => { await sleep(50); ctl.abort(); return GOOD; } })(args(ctl.signal)); await assert.rejects(joining, /cancelled|refused/); await sleep(150); assert.equal(m.online.size, 0);
});
test('the server dropping the connection ends the session (the call is torn down, never silently re-joined)', async () => {
  const m = await fakeMeet(); live.push(m.close); const port = await meetSignaling({ baseUrl: m.url, token: async () => GOOD })(args()); let why = ''; port.onClosed((r) => { why = r; });
  m.srv.disconnectSockets(true); await eventually(() => why !== ''); assert.match(why, /^signaling_/); port.send('p-browser', { type: 'offer', sdp: { type: 'offer', sdp: 'v=0' }, epoch: 'x' });
});
