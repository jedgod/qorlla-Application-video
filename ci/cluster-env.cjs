'use strict';
// Generates the EPHEMERAL environment file that docker-compose.yml requires, for a disposable CI cluster.
//   node ci/cluster-env.cjs <output file> [--mask]
// - Every secret is cryptographically random and DISTINCT from the others; none is ever empty or defaulted. docker-compose.yml keeps its authentication requirements (`:?` variables): this supplies real values, it does not remove the check.
// - The file is written with mode 0600 and must live OUTSIDE the repository (CI uses $RUNNER_TEMP). Values are never printed. With --mask the values are registered with GitHub Actions' log masking (`::add-mask::`),
//   a workflow command the runner consumes and hides, as defence in depth should any tool echo one later.
// - Passwords are hex, so they are safe inside the postgres:// URLs the compose file builds from them.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
/** name -> generator. Every one is a required (`:?`) variable of docker-compose.yml. */
const SECRETS = {
  MAIN_DB_PASSWORD: () => hex(24), QORLLA_APP_DB_PASSWORD: () => hex(24), PORTAL_DB_PASSWORD: () => hex(24),   // main PostgreSQL: superuser and the two application roles
  MEET_DB_PASSWORD: () => hex(24), MEET_APP_DB_PASSWORD: () => hex(24),                                         // Meet PostgreSQL: superuser and the application role
  MEET_JWT_SECRET: () => hex(32), QORLLA_BRIDGE_SECRET: () => hex(32), PORTAL_INTROSPECTION_SECRET: () => hex(32),   // each must be 32+ characters (64 here)
  RECOVERY_ESCROW_KEY: () => crypto.randomBytes(32).toString('base64'),                                          // "base64 of 32 bytes"
};
/** Not secrets: the address CI uses to reach the proxy. */
const PLAIN = { PUBLIC_ORIGIN: 'http://localhost:8080' };

function generate() {
  const values = {}; for (const [k, make] of Object.entries(SECRETS)) values[k] = make();
  const seen = new Set(Object.values(values)); if (seen.size !== Object.keys(values).length) throw new Error('generated secrets are not distinct');   // astronomically unlikely; fail rather than continue
  for (const [k, v] of Object.entries(values)) if (!v || v.length < 32) throw new Error(k + ' is empty or too short');
  return { secrets: values, plain: { ...PLAIN } };
}
const render = ({ secrets, plain }) => Object.entries({ ...plain, ...secrets }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';

function main(argv) {
  const out = argv[0]; if (!out || out.startsWith('--')) { console.error('usage: cluster-env.cjs <output file> [--mask]'); return 2; }
  const target = path.resolve(out), repo = path.resolve(__dirname, '..');
  if (target === repo || target.startsWith(repo + path.sep)) { console.error('refusing to write secrets inside the repository: ' + target); return 2; }
  const env = generate(); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, render(env), { mode: 0o600 }); try { fs.chmodSync(target, 0o600); } catch { /* not supported on this platform */ }
  if (argv.includes('--mask')) for (const v of Object.values(env.secrets)) console.log('::add-mask::' + v);
  console.log(`prepared an ephemeral environment: ${Object.keys(env.secrets).length} distinct random secrets (${Object.keys(env.secrets).join(', ')}) and ${Object.keys(env.plain).length} plain setting(s); values are never printed`);
  return 0;
}
module.exports = { generate, render, SECRETS, PLAIN };
if (require.main === module) process.exit(main(process.argv.slice(2)));
