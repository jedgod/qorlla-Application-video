'use strict';
// Turns raw container logs into a SAFE diagnostic summary for a public Actions log. Raw `docker compose logs` can carry database credentials, connection strings, authentication headers and tokens.
//   docker compose logs --no-color --tail=200 <service> 2>&1 | node ci/sanitize-diagnostics.cjs --service <name> [--env-file <file>] [--max-lines 40]
// Three layers, in order:
//   1. ALLOWLIST: only error, warning and lifecycle lines are kept at all (failures, "listening", "ready", exits, authentication or connection problems). Every other line is dropped and only counted.
//   2. REDACTION of what is kept: the exact secret values from the ephemeral env file (raw, URL-encoded, base64), connection-string credentials, authorization and cookie headers, tokens and keys, JWTs, e-mail and IP addresses, opaque strings.
//   3. SELF-CHECK: if anything sensitive is still present after redaction, the whole output is replaced by a notice. Fail closed.
// The raw input is never written anywhere.
const fs = require('node:fs');

const KEEP = /\b(ERROR|ERR!?|FATAL|PANIC|CRITICAL|WARN(ING)?|EXCEPTION|UNCAUGHT)\b|listening|ready to accept|ready for start up|init process complete|accepting connections|started|starting|stopping|stopped|exited|exit code|healthy|unhealthy|connection (refused|reset|closed|terminated)|ECONNREFUSED|ECONNRESET|EADDRINUSE|ENOTFOUND|authentication failed|password authentication|does not exist|already exists|out of memory|permission denied|timed? ?out|migrat|database system is|could not|cannot|failed to|unable to/i;
const RULES = [
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\/\s:@]+:[^@\s\/]+@/gi, (m) => m.replace(/\/\/[^@]+@/, '//[redacted]@')],                 // scheme://user:password@host
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)\b\s*[:=]\s*[^\r\n]*/gi, (m, h) => h + ': [redacted]'],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, (m, k) => k + ' [redacted]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, () => '[jwt]'],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, () => '[private key]'],
  [/\b(AKIA[0-9A-Z]{16}|gh[ousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_(live|test)_[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{30,})\b/g, () => '[key]'],
  [/\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|credential|private[_-]?key)[A-Za-z0-9_.-]*)\s*(=|:|=>)\s*("[^"]*"|'[^']*'|[^\s,;&)}\]]+)/gi, (m, k, sep) => `${k}${sep}[redacted]`],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, () => '[email]'],
  [/(?<![\w.-])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w-]|\.\d)/g, (m) => (m === '127.0.0.1' || m === '0.0.0.0' ? m : '[ip]')],
  [/(?<![\w-])[0-9a-f]{24,}(?![\w-])/gi, () => '[hex]'],
  [/(?<![\w-])(?=[A-Za-z0-9+\/_=-]*\d)(?=[A-Za-z0-9+\/_=-]*[A-Za-z])[A-Za-z0-9+\/_=-]{28,}(?![\w-])/g, () => '[opaque]'],
];
/** Exact values of every secret-looking variable in an env file, with the encodings they may appear in. */
function loadSecrets(file) {
  if (!file || !fs.existsSync(file)) return [];
  const out = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line); if (!m || !/PASSWORD|SECRET|KEY|TOKEN/.test(m[1]) || m[2].length < 8) continue;
    const v = m[2]; out.add(v); out.add(encodeURIComponent(v)); out.add(Buffer.from(v).toString('base64')); out.add(Buffer.from(v).toString('base64').replace(/=+$/, '')); out.add(Buffer.from(v).toString('hex'));
  }
  return [...out].filter((v) => v.length >= 8).sort((a, b) => b.length - a.length);
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function redact(line, secrets) {
  let s = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  for (const v of secrets) s = s.split(v).join('[secret]');                                                                    // exact values first: they beat every pattern
  for (const [re, fn] of RULES) s = s.replace(re, fn);
  return s;
}
/** True when something sensitive is still visible after redaction. */
function residual(text, secrets) {
  if (secrets.some((v) => text.includes(v))) return true;
  return /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(text) || /-----BEGIN [A-Z ]*PRIVATE KEY/.test(text) || /\b[a-z][a-z0-9+.-]*:\/\/[^\/\s:@]+:[^@\s\/]+@/i.test(text) || /\b(authorization|cookie)\b\s*:\s*(?!\[redacted\])\S/i.test(text);
}
function sanitize(raw, { service = 'service', secrets = [], maxLines = 40, maxLen = 200 } = {}) {
  const lines = String(raw).split(/\r?\n/).filter((l) => l.trim()); let dropped = 0; const kept = [];
  for (const l of lines) { const body = l.replace(/^[\w.-]+\s+\|\s?/, ''); if (!KEEP.test(redact(body, secrets))) { dropped++; continue; } kept.push(redact(body, secrets).trim().slice(0, maxLen)); }
  const shown = kept.slice(-maxLines), head = `=== ${service}: ${shown.length} line(s) shown of ${lines.length} (${dropped} dropped: only error, warning and lifecycle lines are shown, with secrets, addresses and tokens redacted)`;
  const out = [head, ...shown.map((l) => '  ' + l)].join('\n');
  return residual(out, secrets) ? `=== ${service}: output suppressed: the sanitizer's self-check found residual sensitive content` : out;
}
function main(argv) {
  const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const raw = fs.readFileSync(0, 'utf8'); console.log(sanitize(raw, { service: arg('--service', 'service'), secrets: loadSecrets(arg('--env-file')), maxLines: Number(arg('--max-lines', 40)) })); return 0;
}
module.exports = { sanitize, redact, loadSecrets, residual, KEEP };
if (require.main === module) process.exit(main(process.argv.slice(2)));
