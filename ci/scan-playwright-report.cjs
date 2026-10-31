'use strict';
// Fail-closed pre-upload scan of a Playwright report directory (the artifact the CI pipeline may upload from a PUBLIC repository).
//   node ci/scan-playwright-report.cjs <report dir> [--allowlist <file>]
// Exit 0: nothing sensitive found AND everything was understood. Exit 1: findings. Exit 2: usage or I/O problem (also a failure: nothing is uploaded).
// "Fail-closed" means anything the scanner cannot read, classify or bound is a FINDING, not a pass: unknown binary files, videos, encrypted or oversized or corrupt archives, archives nested too deep,
// path-traversal names, symlinks, payloads it does not understand, screenshots when the run is not attested as synthetic-only, an empty directory.
// It looks inside trace archives and any archive nested in them, base64-embedded archives in the HTML report, and the printable strings of screenshots. It NEVER prints a matched value: only the file, the rule and a count.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const LIMITS = { files: 5000, totalBytes: 250 * 1024 * 1024, entryBytes: 100 * 1024 * 1024, depth: 4, ratio: 250, imageBytes: 8 * 1024 * 1024, images: 300, embeddedBase64: 80 * 1024 * 1024 };
const TEXT_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json', '.md', '.txt', '.svg', '.webmanifest', '.map', '.network', '.trace', '.stacks', '.yml', '.yaml', '.xml']);
const STRUCTURED_EXT = new Set(['.network', '.trace', '.json', '.stacks', '.txt']);   // request/response captures and data: where a "password" key means a value, not JavaScript source
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg']);
const FONT_EXT = new Set(['.ttf', '.woff', '.woff2', '.ico']);
const VIDEO_EXT = new Set(['.webm', '.mp4', '.mov', '.mkv', '.avi', '.gif', '.wav', '.mp3', '.ogg']);
const MAGIC = { png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff], ttf: [0x00, 0x01, 0x00, 0x00], woff: [0x77, 0x4f, 0x46, 0x46], woff2: [0x77, 0x4f, 0x46, 0x32], ico: [0x00, 0x00, 0x01, 0x00], zip: [0x50, 0x4b, 0x03, 0x04] };
const DEFAULT_ALLOW = { emailDomains: ['example.com', 'example.org', 'example.net'], hosts: ['localhost', '127.0.0.1'], ips: ['127.0.0.1'], passwords: [] };
const IMG_TLD = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'css', 'js', 'json', 'zip', 'html', 'map']);
const startsWith = (buf, sig) => sig.every((b, i) => buf[i] === b);

// ---------------------------------------------------------------- zip reading (strict: anything unusual is refused)
function readZip(buf) {
  const entries = [], fail = (m) => { throw new Error(m); };
  let eocd = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) fail('not a readable zip (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) fail('zip64 archives are not supported (refused)');
  if (count > LIMITS.files) fail('too many entries in one archive'); let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail('corrupt central directory');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24), nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8'); p += 46 + nlen + elen + clen;
    if (flags & 1) fail('encrypted entry (cannot be inspected)'); if (method !== 0 && method !== 8) fail('unsupported compression method ' + method);
    if (csize === 0xffffffff || usize === 0xffffffff) fail('zip64 entry (refused)');
    if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) fail('unsafe entry name (path traversal)');
    if (usize > LIMITS.entryBytes) fail('entry larger than the limit'); if (csize > 0 && usize / csize > LIMITS.ratio) fail('compression ratio too high (possible zip bomb)');
    entries.push({ name, method, csize, usize, lho, dir: name.endsWith('/') });
  }
  return entries.filter((e) => !e.dir).map((e) => {
    const q = e.lho; if (q + 30 > buf.length || buf.readUInt32LE(q) !== 0x04034b50) fail('corrupt local header'); const start = q + 30 + buf.readUInt16LE(q + 26) + buf.readUInt16LE(q + 28), raw = buf.subarray(start, start + e.csize);
    if (raw.length !== e.csize) fail('truncated entry');
    let data; try { data = e.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: LIMITS.entryBytes + 1 }); } catch { fail('entry cannot be decompressed'); }
    if (data.length !== e.usize) fail('entry size does not match its header'); return { name: e.name, data };
  });
}

// ---------------------------------------------------------------- the rules (they report rule ids and counts, never values)
const LINE = (text, idx) => text.slice(0, idx).split('\n').length;
function findAll(re, text) { const out = []; re.lastIndex = 0; let m; while ((m = re.exec(text)) !== null) { out.push(m); if (m.index === re.lastIndex) re.lastIndex++; if (out.length > 200) break; } return out; }
const RE = {
  privateKey: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
  jwt: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  serviceKey: /AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[ousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{30,}/g,
  credHeaderPair: /\\?"name\\?"\s*:\s*\\?"(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)\\?"\s*,\s*\\?"value\\?"\s*:\s*\\?"([^"\\]+)/gi,
  credHeaderKey: /\\?"(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)\\?"\s*:\s*\\?"([^"\\]{3,})/gi,
  urlCredential: /[?&](access_token|id_token|refresh_token|token|api[_-]?key|apikey|auth|session|sid|secret|key|password)=([^&"'\s\\]{8,})/gi,
  basicAuthUrl: /https?:\/\/[^\/\s:@"']+:[^@\s"']+@/g,
  passwordJson: /\\?"(password|passwd|pwd|passphrase|client_secret|secret)\\?"\s*:\s*\\?"([^"\\]+)/gi,
  passwordForm: /(?:^|[?&\s"\\])(password|passwd|pwd)=([^&"'\s\\]+)/gi,
  email: /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g,
  ipv4: /(?<![\w.-])((?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d))(?![\w-]|\.\d)/g,
  host: /https?:\/\/([A-Za-z0-9.-]+)(?::\d+)?/g,
  opaque: /"([A-Za-z0-9+\/_=-]{32,})"/g,
  dataUrl: /data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+\/=]{200,})/g,
};
/** A value that was explicitly redacted (the report is sanitized): a marker, not a secret. */
const isRedacted = (v) => /^[\[<(]?(redacted|removed|masked|filtered)[\]>)]?$/i.test(String(v).trim()) || /^\*{3,}$/.test(String(v).trim());
const hostAllowed = (h, allow) => allow.hosts.some((a) => (a.startsWith('*.') ? h === a.slice(2) || h.endsWith(a.slice(1)) : h === a));
function scanText(file, ext, text, allow, add) {
  const structured = STRUCTURED_EXT.has(ext), isNetwork = ext === '.network';
  for (const [re, rule] of [[RE.privateKey, 'private-key'], [RE.jwt, 'jwt-token'], [RE.serviceKey, 'service-credential']]) for (const m of findAll(re, text)) add(rule, file, LINE(text, m.index));
  if (structured) {
    for (const m of findAll(RE.credHeaderPair, text)) if (!isRedacted(m[2])) add('credential-header', file, LINE(text, m.index));
    for (const m of findAll(RE.credHeaderKey, text)) if (!isRedacted(m[2])) add('credential-header', file, LINE(text, m.index));
    for (const m of findAll(RE.passwordJson, text)) if (!allow.passwords.includes(m[2]) && !isRedacted(m[2])) add('password-value', file, LINE(text, m.index));
    for (const m of findAll(RE.passwordForm, text)) if (!allow.passwords.includes(m[2]) && !isRedacted(m[2])) add('password-value', file, LINE(text, m.index));
    for (const m of findAll(RE.host, text)) if (!hostAllowed(m[1].toLowerCase(), allow)) add('unexpected-host', file, LINE(text, m.index));
  }
  for (const m of findAll(RE.urlCredential, text)) if (!isRedacted(m[2]) && (structured || /https?:\/\//.test(text.slice(Math.max(0, m.index - 200), m.index)))) add('url-credential', file, LINE(text, m.index));
  for (const m of findAll(RE.basicAuthUrl, text)) add('url-credential', file, LINE(text, m.index));
  for (const m of findAll(RE.email, text)) { const d = m[1].toLowerCase(), tld = d.split('.').pop(); if (IMG_TLD.has(tld)) continue; if (!allow.emailDomains.includes(d)) add('real-or-unknown-email', file, LINE(text, m.index)); }
  for (const m of findAll(RE.ipv4, text)) if (!allow.ips.includes(m[1])) add('ip-address', file, LINE(text, m.index));
  if (isNetwork) { const cleaned = text.replace(/\\?"_?sha1\\?"\s*:\s*\\?"[0-9a-f]{40}\\?"/gi, '').replace(/\\?"(etag|integrity)\\?"\s*:\s*\\?"[^"\\]*\\?"/gi, ''); for (const m of findAll(RE.opaque, cleaned)) if (/\d/.test(m[1]) && /[A-Za-z]/.test(m[1])) add('opaque-secret-like-value', file, LINE(cleaned, m.index)); }
}
/** Printable ASCII runs (>= 8 characters) of a binary file: where a screenshot's metadata could carry an address, a path or a token. */
const strings = (buf) => (buf.toString('latin1').match(/[\x20-\x7e]{8,}/g) || []).join('\n');

// ---------------------------------------------------------------- walking
function scan(root, { allow = DEFAULT_ALLOW, attested = false } = {}) {
  const findings = [], stats = { files: 0, bytes: 0, archives: 0, images: 0, maxDepth: 0 }, a = { ...DEFAULT_ALLOW, ...allow };
  const add = (rule, file, line) => findings.push({ rule, file, line: line || null }), fail = (rule, file, why) => findings.push({ rule, file, line: null, why });
  const account = (file, size) => { stats.files++; stats.bytes += size; if (stats.files > LIMITS.files) throw Object.assign(new Error('too many files'), { limit: true }); if (stats.bytes > LIMITS.totalBytes) throw Object.assign(new Error('total size over the limit'), { limit: true }); };
  function handle(file, name, buf, depth) {
    stats.maxDepth = Math.max(stats.maxDepth, depth); const ext = path.extname(name).toLowerCase(); account(file, buf.length);
    if (VIDEO_EXT.has(ext)) return fail('unscannable-media', file, 'video, audio and animated formats cannot be inspected and are never uploaded');
    if (ext === '.zip' || (ext === '' && startsWith(buf, MAGIC.zip))) {
      if (!startsWith(buf, MAGIC.zip)) return fail('archive-unreadable', file, 'named .zip but is not a zip');
      if (depth >= LIMITS.depth) return fail('archive-too-deep', file, 'nested more than ' + LIMITS.depth + ' levels'); stats.archives++;
      let entries; try { entries = readZip(buf); } catch (e) { return fail('archive-unreadable', file, e.message); }
      for (const e of entries) handle(file + '!/' + e.name, e.name, e.data, depth + 1); return undefined;
    }
    if (IMAGE_EXT.has(ext)) {
      const sig = ext === '.png' ? MAGIC.png : MAGIC.jpeg; if (!startsWith(buf, sig)) return fail('image-type-mismatch', file, 'content does not match its extension');
      stats.images++; if (stats.images > LIMITS.images || buf.length > LIMITS.imageBytes) return fail('image-limit', file, 'too many or too large screenshots');
      if (!attested) fail('screenshot-not-attested', file, 'screenshots may only be uploaded when the run is attested synthetic-only (QORLLA_CI_SYNTHETIC_DATA=1)');
      scanText(file + ' (image metadata)', '.txt', strings(buf), a, add); return undefined;
    }
    if (FONT_EXT.has(ext)) { const ok = Object.values(MAGIC).some((s) => startsWith(buf, s)) || ext === '.ttf'; return ok ? undefined : fail('font-type-mismatch', file, 'content does not match its extension'); }
    let text = null;
    if (TEXT_EXT.has(ext) || ext === '') { if (!buf.includes(0)) { try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = null; } } }
    if (text === null) return fail('unknown-binary', file, 'a file type the scanner does not understand (refused, not skipped)');
    scanText(file, TEXT_EXT.has(ext) ? ext : '.txt', text, a, add);
    for (const m of findAll(RE.dataUrl, text)) {                            // an archive or image embedded in the HTML report as base64
      const mime = m[1].toLowerCase(), payload = m[2]; if (payload.length > LIMITS.embeddedBase64) { fail('embedded-payload-too-large', file, 'embedded base64 payload over the limit'); continue; }
      let bin; try { bin = Buffer.from(payload, 'base64'); } catch { fail('embedded-payload-unreadable', file, 'embedded payload is not valid base64'); continue; }
      if (mime === 'application/zip' || mime === 'application/x-zip-compressed') handle(file + '#embedded.zip', 'embedded.zip', bin, depth + 1);
      else if (mime === 'image/png') handle(file + '#embedded.png', 'embedded.png', bin, depth + 1); else if (mime === 'image/jpeg') handle(file + '#embedded.jpeg', 'embedded.jpeg', bin, depth + 1);
      else if (!/^(font\/|application\/font|application\/x-font|image\/svg|image\/x-icon|image\/vnd\.microsoft\.icon|image\/webp)/.test(mime)) fail('embedded-payload-unknown', file, 'embedded payload of an unexpected type: ' + mime);
    }
    return undefined;
  }
  function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name), shown = rel ? rel + '/' + e.name : e.name, st = fs.lstatSync(full);
      if (st.isSymbolicLink()) { fail('symlink', shown, 'symbolic links are refused'); continue; }
      if (st.isDirectory()) { walk(full, shown); continue; }
      if (!st.isFile()) { fail('special-file', shown, 'not a regular file'); continue; }
      if (st.size > LIMITS.entryBytes) { fail('file-too-large', shown, 'over the limit'); continue; }
      handle(shown, e.name, fs.readFileSync(full), 0);
    }
  }
  try { walk(root, ''); } catch (e) { if (e.limit) fail('limit-exceeded', '(report)', e.message); else throw e; }
  if (stats.files === 0) fail('empty-report', '(report)', 'nothing was scanned: an empty or missing report is never reported as clean');
  return { findings, stats };
}

function main(argv) {
  const dir = argv[0], i = argv.indexOf('--allowlist');
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { console.error('usage: scan-playwright-report.cjs <report dir> [--allowlist <file>]  (the directory must exist)'); return 2; }
  let allow = DEFAULT_ALLOW; if (i >= 0) { try { allow = { ...DEFAULT_ALLOW, ...JSON.parse(fs.readFileSync(argv[i + 1], 'utf8')) }; } catch (e) { console.error('cannot read the allowlist: ' + e.message); return 2; } }
  let r; try { r = scan(dir, { allow, attested: process.env.QORLLA_CI_SYNTHETIC_DATA === '1' }); } catch (e) { console.error('scan failed (nothing may be uploaded): ' + e.message); return 2; }
  console.log(`scanned ${r.stats.files} files (${r.stats.archives} archives, ${r.stats.images} screenshots, nesting depth ${r.stats.maxDepth}, ${(r.stats.bytes / 1048576).toFixed(1)} MB); synthetic-data attestation: ${process.env.QORLLA_CI_SYNTHETIC_DATA === '1' ? 'yes' : 'no'}`);
  if (!r.findings.length) { console.log('PLAYWRIGHT REPORT SCAN PASSED: nothing sensitive found and every file was understood'); return 0; }
  const by = {}; for (const f of r.findings) by[f.rule] = (by[f.rule] || 0) + 1;
  console.log('PLAYWRIGHT REPORT SCAN FAILED: ' + r.findings.length + ' finding(s). Matched values are never printed.'); for (const [k, n] of Object.entries(by)) console.log(`  ${String(n).padStart(4)} x ${k}`);
  for (const f of r.findings.slice(0, 40)) console.log(`  - ${f.rule}: ${f.file}${f.line ? ':' + f.line : ''}${f.why ? ' (' + f.why + ')' : ''}`); if (r.findings.length > 40) console.log(`  ... and ${r.findings.length - 40} more`);
  console.log('Nothing will be uploaded.'); return 1;
}
module.exports = { scan, readZip, LIMITS, DEFAULT_ALLOW };
if (require.main === module) process.exit(main(process.argv.slice(2)));
