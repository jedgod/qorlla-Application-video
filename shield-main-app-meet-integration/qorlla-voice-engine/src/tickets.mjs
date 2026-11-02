// One-use, short-lived WebSocket tickets. A browser WebSocket cannot send an Authorization header and a reusable token in a URL can end up in logs, so the server issues a
// random ticket (45 s, bound to the account and the browser origin) and stores only its SHA-256 hash. Consuming it is one atomic UPDATE: reuse and expiry both fail.
import { randomBytes, createHash } from 'node:crypto';

export const TICKET_SECONDS = 45, MAX_OUTSTANDING = 10, PROTOCOL = 'qorlla.voice.v1', TICKET_PREFIX = 'ticket.';
async function database(db) { return db || (await import('./store.mjs')).pool; }
export const hashTicket = (value) => createHash('sha256').update(value).digest('hex');
export const originAllowed = (origin, allowed = process.env.VOICE_ALLOWED_ORIGIN || '') => typeof origin === 'string' && allowed.split(',').map((x) => x.trim()).filter(Boolean).includes(origin);
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;

export async function issueTicket(account, origin, db, allowed, deviceId = null) {
  if (!originAllowed(origin, allowed)) throw Error('invalid_origin');
  const pool = await database(db);
  const open = await pool.query('SELECT count(*)::int AS n FROM voice_ws_tickets WHERE account_id=$1 AND consumed_at IS NULL AND expires_at > now()', [account]);
  if ((open.rows?.[0]?.n || 0) >= MAX_OUTSTANDING) throw Error('too_many_tickets');                       // a ticket flood cannot grow the table
  const token = randomBytes(32).toString('base64url');
  await pool.query(`INSERT INTO voice_ws_tickets(token_hash, account_id, origin, device_id, expires_at) VALUES($1,$2,$3,$4, now() + make_interval(secs => ${TICKET_SECONDS}))`, [hashTicket(token), account, origin, deviceId]);
  return { ticket: token, expiresIn: TICKET_SECONDS };
}
/** The device a ticket was issued to travels with it, so a socket can never claim another device's identity. */
export async function consumeTicketFull(token, origin, db, allowed) {
  if (typeof token !== 'string' || !TICKET_RE.test(token) || !originAllowed(origin, allowed)) return null;
  const { rows } = await (await database(db)).query(`UPDATE voice_ws_tickets SET consumed_at=now()
    WHERE token_hash=$1 AND origin=$2 AND consumed_at IS NULL AND expires_at > now() RETURNING account_id, device_id`, [hashTicket(token), origin]);
  return rows[0] ? { account: rows[0].account_id, deviceId: rows[0].device_id } : null;
}
export async function consumeTicket(token, origin, db, allowed) { return (await consumeTicketFull(token, origin, db, allowed))?.account || null; }
export async function pruneTickets(db) { await (await database(db)).query("DELETE FROM voice_ws_tickets WHERE expires_at < now() - interval '1 hour'"); }

/**
 * Where the ticket came from. Preferred: the Sec-WebSocket-Protocol header ("qorlla.voice.v1, ticket.<token>"), which never appears in a URL or an access log.
 * The query string (?ticket=) is accepted unless VOICE_WS_QUERY_TICKET=off, for clients that cannot set subprotocols.
 */
export function ticketFromRequest(req, env = process.env) {
  const protos = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const viaProtocol = protos.find((p) => p.startsWith(TICKET_PREFIX));
  if (viaProtocol && protos.includes(PROTOCOL)) return { token: viaProtocol.slice(TICKET_PREFIX.length), via: 'protocol' };
  if (String(env.VOICE_WS_QUERY_TICKET || 'on').toLowerCase() === 'off') return { token: null, via: null };
  const q = new URL(req.url, 'http://localhost').searchParams.get('ticket');
  return q ? { token: q, via: 'query' } : { token: null, via: null };
}
