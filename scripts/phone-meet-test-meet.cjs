// TEST HELPER (never used in production): starts Qorlla Meet on :3310 WITH a Shield workload credential that points at the test Voice Engine (127.0.0.1:5344),
// and writes the JWKS the engine will serve on :5345 (tests/phone-meet-handoff.spec.js).
//  - The signing key is kept in the temp folder (QORLLA_TEST_MEET_KEY, default <tmp>/meet-workload-key.json) so that Meet can be RESTARTED by the Meet-outage test and keep verifying
//    against the same JWKS. It is a throw-away test key; it is never printed and never committed.
//  - The process id is written to <tmp>/meet3310.pid so a test can stop Meet to simulate an outage.
//  - QORLLA_TEST_MEET_DATABASE_URL selects Meet's database; the log is appended to QORLLA_TEST_MEET_LOG (default <tmp>/meet3310.log).
const crypto = require('crypto'), fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process');
const root = path.resolve(__dirname, '..'), tmp = os.tmpdir();
const s = require(path.join(root, '.dev-stack', 'secrets.json'));
const keyFile = process.env.QORLLA_TEST_MEET_KEY || path.join(tmp, 'meet-workload-key.json'), jwksFile = process.env.QORLLA_TEST_MEET_JWKS || path.join(tmp, 'meet-jwks.json');
let pair;
try { pair = JSON.parse(fs.readFileSync(keyFile, 'utf8')); } catch (e) { pair = null; }
if (!pair || !pair.pem || !pair.jwk) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  pair = { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), jwk: { ...publicKey.export({ format: 'jwk' }), kid: 'w1', alg: 'ES256', use: 'sig' } };
  fs.writeFileSync(keyFile, JSON.stringify(pair), { mode: 0o600 });
}
fs.writeFileSync(jwksFile, JSON.stringify({ keys: [pair.jwk] }));
const env = { ...process.env, PORT: '3310', DATABASE_URL: process.env.QORLLA_TEST_MEET_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:25690/meet_pm22', JWT_SECRET: s.jwt, QORLLA_BRIDGE_SECRET: s.bridge, RECOVERY_ESCROW_KEY: s.escrow, NODE_ENV: 'development', MEET_ALLOW_ANONYMOUS_START: 'false',
  SHIELD_URL: 'http://127.0.0.1:5344', SHIELD_MEET_KEY_PEM: pair.pem, SHIELD_WORKLOAD_ISSUER: 'qorlla-workload', SHIELD_WORKLOAD_KID: 'w1' };
const log = fs.openSync(process.env.QORLLA_TEST_MEET_LOG || path.join(tmp, 'meet3310.log'), 'a');
const c = spawn(process.execPath, ['server/index.js'], { cwd: path.join(root, 'qorlla-meet-video'), detached: true, stdio: ['ignore', log, log], env });
c.unref(); fs.writeFileSync(path.join(tmp, 'meet3310.pid'), String(c.pid)); console.log('pid', c.pid);
