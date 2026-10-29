import test from 'node:test';
import assert from 'node:assert/strict';
import { hashTicket, originAllowed, issueTicket, consumeTicket, ticketFromRequest, PROTOCOL } from '../src/tickets.mjs';

const origin = 'https://app.qorlla.test';
// ---- the five checks shipped with v1.1
test('origin allowlist uses exact match', () => { assert.equal(originAllowed(origin, origin), true); assert.equal(originAllowed('https://app.qorlla.test.evil', origin), false); });
test('ticket hash is deterministic but not the token', () => { assert.equal(hashTicket('abc'), hashTicket('abc')); assert.notEqual(hashTicket('abc'), 'abc'); });
test('ticket is random and DB receives hash only', async () => {
  const seen = []; const db = { query: async (sql, p) => { seen.push({ sql, p }); return { rows: [{ n: 0 }] }; } };
  const { ticket, expiresIn } = await issueTicket('alice', origin, db, origin);
  assert.equal(expiresIn, 45); assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  const insert = seen.find((s) => /INSERT INTO voice_ws_tickets/.test(s.sql)); assert.equal(insert.p[0], hashTicket(ticket)); assert.equal(insert.p[1], 'alice'); assert.ok(!JSON.stringify(seen).includes(ticket));
});
test('consume rejects malformed and mismatched origin before DB', async () => {
  const db = { query: async () => { throw Error('must not query'); } };
  assert.equal(await consumeTicket('bad', origin, db, origin), null); assert.equal(await consumeTicket('A'.repeat(43), 'https://evil.test', db, origin), null);
});
test('atomic consume returns account only when DB returns one row', async () => {
  const db = { query: async (sql, params) => { assert.match(sql, /consumed_at IS NULL/); assert.match(sql, /expires_at > now\(\)/); assert.equal(params[1], origin); return { rows: [{ account_id: 'alice' }] }; } };
  assert.equal(await consumeTicket('A'.repeat(43), origin, db, origin), 'alice');
});

// ---- additions
test('a ticket is refused for a disallowed origin before anything is stored', async () => { const db = { query: async () => { throw Error('must not query'); } }; await assert.rejects(issueTicket('alice', 'https://evil.test', db, origin), /invalid_origin/); });
test('too many open tickets are refused', async () => { const db = { query: async () => ({ rows: [{ n: 10 }] }) }; await assert.rejects(issueTicket('alice', origin, db, origin), /too_many_tickets/); });
test('two tickets are never equal', async () => { const db = { query: async () => ({ rows: [{ n: 0 }] }) }; const a = await issueTicket('a', origin, db, origin), b = await issueTicket('a', origin, db, origin); assert.notEqual(a.ticket, b.ticket); });
test('the ticket is read from the WebSocket subprotocol first, then (unless disabled) the query string', () => {
  const t = 'A'.repeat(43);
  assert.deepEqual(ticketFromRequest({ headers: { 'sec-websocket-protocol': `${PROTOCOL}, ticket.${t}` }, url: '/v1/voice/ws' }), { token: t, via: 'protocol' });
  assert.deepEqual(ticketFromRequest({ headers: {}, url: '/v1/voice/ws?ticket=' + t }, {}), { token: t, via: 'query' });
  assert.deepEqual(ticketFromRequest({ headers: {}, url: '/v1/voice/ws?ticket=' + t }, { VOICE_WS_QUERY_TICKET: 'off' }), { token: null, via: null });
  assert.deepEqual(ticketFromRequest({ headers: { 'sec-websocket-protocol': `ticket.${t}` }, url: '/v1/voice/ws' }, { VOICE_WS_QUERY_TICKET: 'off' }), { token: null, via: null });   // the ticket subprotocol alone, without the protocol name, is not accepted
});
