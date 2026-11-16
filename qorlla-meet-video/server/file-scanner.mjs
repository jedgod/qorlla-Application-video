// Content inspection for shared files (v4.34). Two independent checks, both must pass, and any failure to run either one REJECTS (never "clean by default"):
//   1. an anti-malware scan of the exact bytes by clamd (INSTREAM over TCP), and
//   2. a content-type check from the bytes themselves (never the file name or the browser's claim) against a narrow allowlist, with active content refused (PDF scripts/launch/embedded files, Office macros).
import net from 'node:net';

export const ALLOWED_TYPES = Object.freeze(['application/pdf', 'text/plain', 'image/png', 'image/jpeg', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** what the bytes ARE, or null. Returns { type } or { type: null } for anything outside the allowlist. */
export function detectType(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';          // the header must be the first bytes: a polyglot that merely contains it is not a PDF
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5)) { const s = buf.toString('latin1'); if (s.includes('[Content_Types].xml') && s.includes('word/')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; return null; }
  if (buf.includes(0)) return null;
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return 'text/plain'; } catch { return null; }
}
/** active content that a shared document must not carry */
export function activeContent(buf, type) {
  const s = buf.toString('latin1');
  if (type === 'application/pdf') {
    if (/\/[A-Za-z]*#[0-9A-Fa-f]{2}/.test(s)) return 'name_escape';          // /J#61vaScript: a spelling trick that defeats a plain search
    for (const k of ['/JavaScript', '/JS', '/Launch', '/EmbeddedFile', '/OpenAction', '/AA', '/RichMedia', '/ObjStm', '/Encrypt', '/GoToR', '/SubmitForm', '/URI', '/XFA']) if (new RegExp(k.replace('/', '\\/') + '(?![A-Za-z])').test(s)) return k.replace('/', '').toLowerCase();          // /ObjStm hides keys inside compressed streams, /Encrypt hides everything: neither can be inspected, so both are refused
  }
  if (type.startsWith('application/vnd.openxmlformats') && (s.includes('vbaProject.bin') || s.includes('macroEnabled') || s.includes('oleObject'))) return 'macro_or_ole';
  return null;
}

/** clamd INSTREAM client: resolves 'OK' or the signature name; rejects on any error or timeout (so the caller fails closed) */
export function clamdScan(buf, { host, port, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port }); let out = ''; const timer = setTimeout(() => { sock.destroy(); reject(new Error('clamd timeout')); }, timeoutMs);
    const done = (fn, v) => { clearTimeout(timer); sock.destroy(); fn(v); };
    sock.on('error', (e) => done(reject, e)); sock.on('data', (d) => { out += d.toString('latin1'); });
    sock.on('end', () => { const r = out.replace(/\0/g, '').trim(); const m = /^stream:\s*(.+?)\s+(OK|FOUND|ERROR)$/.exec(r) || /^stream:\s*(OK)$/.exec(r); if (!m) return done(reject, new Error('clamd gave no verdict: ' + r.slice(0, 60))); if (m[2] === 'OK' || m[1] === 'OK') return done(resolve, 'OK'); if (m[2] === 'FOUND') return done(resolve, m[1]); done(reject, new Error('clamd error')); });
    sock.on('connect', () => { sock.write('zINSTREAM\0'); for (let i = 0; i < buf.length; i += 65536) { const part = buf.subarray(i, i + 65536), len = Buffer.alloc(4); len.writeUInt32BE(part.length); sock.write(len); sock.write(part); } sock.write(Buffer.alloc(4)); });
  });
}

export function createScanner({ env = process.env, scan = null } = {}) {
  const host = env.CLAMD_HOST, port = Number(env.CLAMD_PORT || 3310);
  const engine = scan || (host ? (buf) => clamdScan(buf, { host, port, timeoutMs: Number(env.CLAMD_TIMEOUT_MS || 15000) }) : null);
  return {
    ready: !!engine, reason: engine ? null : 'CLAMD_HOST is not set (no anti-malware scanner)',
    /** @returns {{clean:boolean, reason:string, detectedType:string|null}} ; THROWS when a check could not run (the caller must not treat that as clean) */
    async inspect(buf, declaredType) {
      if (!engine) throw new Error('scanner_unavailable');
      const detectedType = detectType(buf); if (!detectedType) return { clean: false, reason: 'type_not_allowed', detectedType: null };
      if (detectedType !== declaredType) return { clean: false, reason: 'type_mismatch', detectedType };
      const active = activeContent(buf, detectedType); if (active) return { clean: false, reason: 'active_content:' + active, detectedType };
      const verdict = await engine(buf); if (verdict !== 'OK') return { clean: false, reason: 'malware:' + String(verdict).slice(0, 60), detectedType };
      return { clean: true, reason: 'ok', detectedType };
    },
  };
}
