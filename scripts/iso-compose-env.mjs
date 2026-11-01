// Writes the environment file for the isolated compose project (.dev-stack-iso/compose.env, git-ignored): throwaway secrets, unique host ports, one http://localhost origin.
// Existing secrets are kept, so a restart keeps working. Nothing here is a production value; billing, telephony and AI stay off.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ISO_PROJECT (default qiso), ISO_STATE_DIR (default .dev-stack-iso), ISO_PROXY_PORT (default 3600) let a second isolated project run beside the first with its own secrets, volumes and ports.
// ISO_TLS=1 makes a TLS project: one https://localhost origin on PORT+43 served with a throw-away self-signed certificate (never trusted by anything, never committed), plain HTTP only redirects.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), stateName = process.env.ISO_STATE_DIR || '.dev-stack-iso', dir = path.join(root, stateName), file = path.join(dir, 'compose.env');
fs.mkdirSync(dir, { recursive: true });
if (fs.existsSync(file)) { console.log('kept ' + file); process.exit(0); }
const hex = (n = 24) => crypto.randomBytes(n).toString('hex'), b64 = () => crypto.randomBytes(32).toString('base64');
const PORT = Number(process.env.ISO_PROXY_PORT || 3600), TLS = process.env.ISO_TLS === '1', origin = TLS ? 'https://localhost:' + (PORT + 43) : 'http://localhost:' + PORT;
const lines = {
  COMPOSE_PROJECT_NAME: process.env.ISO_PROJECT || 'qiso', ISO_STATE_DIR: './' + stateName,
  PUBLIC_ORIGIN: origin, PUBLIC_URL: origin, MEET_PUBLIC_URL: origin + '/meet/', MEET_BASE_URL: 'http://meet:3000',
  PROXY_MAIN_PORT: PORT, PROXY_MEET_PORT: PORT + 1, MEET_HOST_PORT: PORT + 2, MAIN_HOST_PORT: PORT + 3, PROXY_MAIN_TLS_PORT: PORT + 43, PROXY_MEET_TLS_PORT: PORT + 44,
  MAIN_DB_PASSWORD: hex(), QORLLA_APP_DB_PASSWORD: hex(), PORTAL_DB_PASSWORD: hex(), MEET_DB_PASSWORD: hex(), MEET_APP_DB_PASSWORD: hex(),
  MEET_JWT_SECRET: hex(32), QORLLA_BRIDGE_SECRET: hex(32), PORTAL_INTROSPECTION_SECRET: hex(32), MEET_READ_SECRET: hex(32), RECOVERY_ESCROW_KEY: b64(), QORLLA_VAULT_KEY: b64(),
  RECORDING_MASTER_KEYS: JSON.stringify({ k1: b64() }), RECORDING_ACTIVE_KEY_ID: 'k1', RECORDING_ADMIN_SECRET: hex(32),
  BILLING_ENABLED: 'false', TELEPHONY_ENABLED: 'false',
  ...(TLS ? { PROXY_TLS_CONF: './deploy/nginx/tls.conf', PROXY_HTTP_CONF: './deploy/nginx/http-redirect.conf', PROXY_CERT_DIR: './' + stateName + '/certs' } : {})
};
if (TLS) {
  const certs = path.join(dir, 'certs'); fs.mkdirSync(certs, { recursive: true });
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', path.join(certs, 'server.key'), '-out', path.join(certs, 'server.pem')], { encoding: 'utf8' });
  if (r.status !== 0) { console.error('openssl failed: ' + r.stderr); process.exit(1); }
}
fs.writeFileSync(file, Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
console.log('wrote ' + file + ' (origin ' + origin + ')');
