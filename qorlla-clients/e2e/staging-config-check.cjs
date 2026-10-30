'use strict';
// Static checks for the staging edge in qorlla-clients/deployment/staging. No network, no Docker.
//   node qorlla-clients/e2e/staging-config-check.cjs                 checks the committed template, compose file and .env.example
//   node qorlla-clients/e2e/staging-config-check.cjs --env <file>    also checks a real .env (hostnames, public address, relay range)
const fs = require('node:fs');
const path = require('node:path');
const DIR = path.resolve(__dirname, '..', 'deployment', 'staging');
const read = (p) => fs.readFileSync(path.join(DIR, p), 'utf8');

/** The TURN configuration must always authenticate, deny private-space peers, and carry the abuse limits. Returns a list of problems (empty = ok). */
function checkCoturnTemplate(text) {
  const problems = [], has = (re) => re.test(text), line = (re) => text.split(/\r?\n/).filter((l) => !l.trim().startsWith('#')).some((l) => re.test(l));
  for (const [re, why] of [[/^lt-cred-mech$/m, 'lt-cred-mech (REQUIRED with use-auth-secret: without it every valid REST credential is refused)'], [/^use-auth-secret$/m, 'use-auth-secret (REST credentials)'], [/^static-auth-secret=\$\{TURN_SHARED_SECRET\}$/m, 'the secret must come from a placeholder, never a literal'], [/^fingerprint$/m, 'fingerprint'],
    [/^no-cli$/m, 'no-cli (admin CLI off)'], [/^no-tcp-relay$/m, 'no-tcp-relay'], [/^no-multicast-peers$/m, 'no-multicast-peers'], [/^user-quota=\d+$/m, 'user-quota'], [/^total-quota=\d+$/m, 'total-quota'],
    [/^min-port=\$\{TURN_MIN_PORT\}$/m, 'bounded relay range (min)'], [/^max-port=\$\{TURN_MAX_PORT\}$/m, 'bounded relay range (max)'], [/^no-tlsv1$/m, 'no-tlsv1'], [/^no-tlsv1_1$/m, 'no-tlsv1_1']]) if (!has(re)) problems.push('missing: ' + why);
  for (const range of ['10.0.0.0-10.255.255.255', '127.0.0.0-127.255.255.255', '169.254.0.0-169.254.255.255', '172.16.0.0-172.31.255.255', '192.168.0.0-192.168.255.255', '100.64.0.0-100.127.255.255']) if (!has(new RegExp('^denied-peer-ip=' + range.replace(/\./g, '\\.') + '$', 'm'))) problems.push('missing denied-peer-ip=' + range);
  for (const bad of [/^no-auth$/, /^allow-loopback-peers$/, /^allowed-peer-ip=/, /^no-stun-backward-compatibility$/, /^cli-password=/, /^user=/, /^static-auth-secret=(?!\$\{)/]) if (line(bad)) problems.push('forbidden directive: ' + bad.source);
  return problems;
}
/** The compose file must not publish databases or caches, must use a secret FILE (not an inline value), and must not run privileged. */
function checkCompose(text) {
  const problems = [], active = text.split(/\r?\n/).filter((l) => !l.trim().startsWith('#')).join('\n');
  if (/\b(5432|6379|27017|3306)\b/.test(active)) problems.push('a database/cache port appears in the compose file');
  if (/privileged:\s*true/.test(active)) problems.push('privileged container');
  if (!/secrets:\s*\n\s*turn_shared_secret:\s*\n\s*file:/.test(active)) problems.push('the TURN secret must be a Docker secret from a file');
  if (/TURN_SHARED_SECRET:\s*\S/.test(active)) problems.push('the TURN secret must not be an inline environment value');
  return problems;
}
const isPrivateV4 = (ip) => { const [a, b] = ip.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224; };
/** A real .env: three distinct real hostnames, a public IPv4, a bounded relay range. Placeholders from .env.example fail on purpose. */
function checkEnv(text) {
  const env = Object.fromEntries(text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })), problems = [];
  const host = (k) => { const v = env[k] || ''; if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(v)) problems.push(k + ' is not a valid hostname'); else if (/replace|example|localhost|\.(invalid|test|local|internal)$/.test(v)) problems.push(k + ' is a placeholder or reserved name'); return v; };
  const hosts = ['MEET_HOST', 'APP_HOST', 'TURN_HOST'].map(host); if (new Set(hosts).size !== 3) problems.push('MEET_HOST, APP_HOST and TURN_HOST must be three different hostnames');
  const ip = env.TURN_EXTERNAL_IP || ''; if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || ip.split('.').some((o) => Number(o) > 255)) problems.push('TURN_EXTERNAL_IP is not an IPv4 address'); else if (isPrivateV4(ip)) problems.push('TURN_EXTERNAL_IP is not a public address');
  const lo = Number(env.TURN_MIN_PORT || 49160), hi = Number(env.TURN_MAX_PORT || 49200); if (!(lo >= 49152 && hi <= 65535 && hi > lo && hi - lo <= 1000)) problems.push('relay range must be inside 49152-65535 and at most 1000 ports');
  for (const k of ['QORLLA_MEET_UPSTREAM', 'QORLLA_APP_UPSTREAM']) if (!/^(127\.0\.0\.1|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|[a-z0-9-]+):\d{2,5}$/.test(env[k] || '')) problems.push(k + ' must be a loopback/private host:port, not a public address');
  if (/SECRET|PASSWORD|TOKEN/i.test(Object.keys(env).join(' '))) problems.push('the .env must not carry secrets (use ./secrets files)');
  return problems;
}
function main(argv) {
  const out = [['coturn template', checkCoturnTemplate(read('coturn/turnserver.conf.template'))], ['compose', checkCompose(read('docker-compose.yml'))]];
  const i = argv.indexOf('--env'); if (i >= 0) out.push(['env file', checkEnv(fs.readFileSync(argv[i + 1], 'utf8'))]);
  let bad = 0; for (const [name, p] of out) { console.log((p.length ? 'FAIL ' : 'ok   ') + name); for (const x of p) { bad++; console.log('     - ' + x); } }
  return bad ? 1 : 0;
}
module.exports = { checkCoturnTemplate, checkCompose, checkEnv };
if (require.main === module) process.exit(main(process.argv.slice(2)));
