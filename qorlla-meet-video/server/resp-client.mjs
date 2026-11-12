// A minimal Redis (RESP2) client: ONE command per short-lived connection, with a hard timeout. It exists so that Meet needs no new dependency for the handful of commands the relay
// authority uses (PING, SET ... EX, DEL, GET, EXISTS, FLUSHALL in tests). Every failure rejects: callers decide what "unavailable" means (the authority fails CLOSED).
import net from 'node:net';

const CRLF = Buffer.from('\r\n');
const encode = (args) => Buffer.concat([Buffer.from('*' + args.length + '\r\n'), ...args.flatMap((a) => { const b = Buffer.from(String(a)); return [Buffer.from('$' + b.length + '\r\n'), b, CRLF]; })]);

/** Parses ONE reply from the start of buf. Returns { value, rest } or null when more bytes are needed. Errors are returned as { error }. */
export function parseReply(buf) {
  const eol = buf.indexOf('\r\n'); if (eol < 0) return null;
  const type = String.fromCharCode(buf[0]), line = buf.toString('utf8', 1, eol), after = buf.subarray(eol + 2);
  if (type === '+') return { value: line, rest: after };
  if (type === '-') return { error: line, rest: after };
  if (type === ':') return { value: Number(line), rest: after };
  if (type === '$') {
    const len = Number(line); if (len < 0) return { value: null, rest: after };
    if (after.length < len + 2) return null; return { value: after.toString('utf8', 0, len), rest: after.subarray(len + 2) };
  }
  if (type === '*') {
    const n = Number(line); let rest = after; const items = [];
    for (let i = 0; i < n; i++) { const r = parseReply(rest); if (!r) return null; if (r.error) return r; items.push(r.value); rest = r.rest; }
    return { value: items, rest };
  }
  return { error: 'unsupported reply type ' + type, rest: after };
}

/** One command. Resolves with the reply, rejects on error reply / network failure / timeout. */
export function respCommand(args, { host = '127.0.0.1', port = 6379, password = null, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host); let buf = Buffer.alloc(0), need = password ? 2 : 1, last, done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch { /* closed */ } err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(val); };
    const timer = setTimeout(() => finish(new Error('redis_timeout')), timeoutMs);
    sock.on('error', (e) => finish(e)); sock.on('close', () => finish(new Error('redis_closed')));
    sock.on('connect', () => { if (password) sock.write(encode(['AUTH', password])); sock.write(encode(args)); });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (need > 0) { const r = parseReply(buf); if (!r) return; buf = r.rest; need--; if (r.error) return finish(new Error('redis_error: ' + r.error)); last = r.value; }
      finish(null, last);
    });
  });
}
