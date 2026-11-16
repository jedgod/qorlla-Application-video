/**
 * A bounded SIP message codec (RFC 3261 subset: what an INVITE / ACK / BYE / CANCEL / OPTIONS dialogue needs). Anything outside the limits or malformed is REFUSED (returns null), never repaired: this is the first thing
 * untrusted network input reaches. No state, no I/O.
 */
export const LIMITS = { maxBytes: 8192, maxHeaders: 64, maxHeaderValue: 1024, maxBody: 4096 } as const;
export type Header = [name: string, value: string];
type Base = { headers: Header[]; body: string };
export type SipRequest = Base & { kind: 'request'; method: string; uri: string };
export type SipResponse = Base & { kind: 'response'; status: number; reason: string };
export type SipMessage = SipRequest | SipResponse;

const COMPACT: Record<string, string> = { v: 'via', f: 'from', t: 'to', i: 'call-id', m: 'contact', l: 'content-length', c: 'content-type', k: 'supported' };
const CANON: Record<string, string> = { via: 'Via', from: 'From', to: 'To', 'call-id': 'Call-ID', cseq: 'CSeq', contact: 'Contact', 'content-type': 'Content-Type', 'content-length': 'Content-Length', 'max-forwards': 'Max-Forwards', 'www-authenticate': 'WWW-Authenticate', authorization: 'Authorization', allow: 'Allow', supported: 'Supported', 'user-agent': 'User-Agent', 'retry-after': 'Retry-After', 'record-route': 'Record-Route', route: 'Route', reason: 'Reason' };
export const canonName = (n: string) => { const l = n.trim().toLowerCase(), full = COMPACT[l] ?? l; return CANON[full] ?? full.replace(/(^|-)([a-z])/g, (_, a, b) => a + b.toUpperCase()); };
const TOKEN = /^[A-Za-z0-9!%*_+`'~.-]+$/;

export function parse(raw: Buffer | string): SipMessage | null {
  const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw; if (buf.length === 0 || buf.length > LIMITS.maxBytes) return null;
  const text = buf.toString('utf8'); const split = text.indexOf('\r\n\r\n'); if (split < 0) return null;
  const head = text.slice(0, split).split('\r\n'), rest = text.slice(split + 4); if (head.length < 2 || head.length - 1 > LIMITS.maxHeaders) return null;
  const headers: Header[] = [];
  for (const line of head.slice(1)) {
    if (/^[ \t]/.test(line)) return null;                                                              // folded headers are not accepted (a classic parser-differential vector)
    const i = line.indexOf(':'); if (i < 1) return null; const name = line.slice(0, i).trim(), value = line.slice(i + 1).trim();
    if (!TOKEN.test(name) || value.length > LIMITS.maxHeaderValue || /[\0\r\n]/.test(value)) return null;
    headers.push([canonName(name), value]);
  }
  const lengths = headers.filter(([n]) => n === 'Content-Length'); if (lengths.length > 1) return null;
  let body = rest; if (lengths.length === 1) { if (!/^\d{1,5}$/.test(lengths[0][1])) return null; const n = Number(lengths[0][1]); if (Buffer.byteLength(rest) < n) return null; body = Buffer.from(rest).subarray(0, n).toString('utf8'); }
  if (Buffer.byteLength(body) > LIMITS.maxBody) return null;
  const first = head[0];
  const resp = /^SIP\/2\.0 (\d{3}) ?(.{0,128})$/.exec(first);
  if (resp) { const status = Number(resp[1]); if (status < 100 || status > 699) return null; return { kind: 'response', status, reason: resp[2], headers, body }; }
  const req = /^([A-Z]{2,16}) (\S{1,512}) SIP\/2\.0$/.exec(first); if (!req) return null;
  return { kind: 'request', method: req[1], uri: req[2], headers, body };
}

export function serialize(m: SipMessage): Buffer {
  const lines = [m.kind === 'request' ? `${m.method} ${m.uri} SIP/2.0` : `SIP/2.0 ${m.status} ${m.reason}`];
  for (const [n, v] of m.headers) if (n !== 'Content-Length') lines.push(`${n}: ${v}`);
  lines.push(`Content-Length: ${Buffer.byteLength(m.body)}`);
  return Buffer.from(lines.join('\r\n') + '\r\n\r\n' + m.body, 'utf8');
}

export const header = (m: SipMessage, name: string): string | undefined => m.headers.find(([n]) => n === canonName(name))?.[1];
export const headers = (m: SipMessage, name: string): string[] => m.headers.filter(([n]) => n === canonName(name)).map(([, v]) => v);
/** "Via: SIP/2.0/UDP host:port;branch=z9hG4bK..." -> the pieces that identify a transaction. Only the TOP Via counts. */
export function topVia(m: SipMessage): { transport: string; sentBy: string; branch: string; received?: string; rport?: string } | null {
  const v = header(m, 'Via'); if (!v) return null; const x = /^SIP\/2\.0\/(UDP|TCP|TLS)\s+([^;,\s]+)((?:;[^,]*)?)/i.exec(v); if (!x) return null;
  const params = Object.fromEntries(x[3].split(';').filter(Boolean).map((p) => { const [k, ...r] = p.split('='); return [k.trim().toLowerCase(), r.join('=').trim()]; }));
  if (!params.branch || !params.branch.startsWith('z9hG4bK') || params.branch.length < 12 || params.branch.length > 80) return null;   // RFC 3261 magic cookie; anything else is a pre-3261 stack we do not serve
  return { transport: x[1].toUpperCase(), sentBy: x[2], branch: params.branch, received: params.received, rport: params.rport };
}
export function cseq(m: SipMessage): { n: number; method: string } | null { const c = /^(\d{1,10}) ([A-Z]{2,16})$/.exec(header(m, 'CSeq') ?? ''); return c ? { n: Number(c[1]), method: c[2] } : null; }
/** The tag parameter of a From/To header, if any. */
export const tagOf = (v: string | undefined): string | undefined => /;\s*tag=([^;\s>]+)/i.exec(v ?? '')?.[1];
/** The user part and host of the first sip:/sips: URI in a header ("Name" <sip:user@host>;tag=x). */
export function uriOf(v: string | undefined): { user: string; host: string } | null { const x = /sips?:(?:([^@;>\s]+)@)?([^;>:\s]+)/i.exec(v ?? ''); return x ? { user: x[1] ?? '', host: x[2] } : null; }

/** Builds a response to `req` (copies Via, From, To, Call-ID, CSeq as RFC 3261 requires; adds a To tag for dialog-forming answers). */
export function respond(req: SipRequest, status: number, reason: string, o: { toTag?: string; extra?: Header[]; body?: string; contentType?: string } = {}): SipResponse {
  const hs: Header[] = [];
  for (const [n, v] of req.headers) if (n === 'Via' || n === 'From' || n === 'Call-ID' || n === 'CSeq') hs.push([n, v]);
  const to = header(req, 'To') ?? ''; hs.push(['To', o.toTag && !tagOf(to) ? `${to};tag=${o.toTag}` : to]);
  for (const h of o.extra ?? []) hs.push(h);
  if (o.body) hs.push(['Content-Type', o.contentType ?? 'application/sdp']);
  return { kind: 'response', status, reason, headers: hs, body: o.body ?? '' };
}
