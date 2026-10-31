'use strict';
// ci/cluster.sh with a stubbed `docker`: what it passes, what it prints, and that teardown always happens.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const SCRIPT = path.join(__dirname, '..', 'cluster.sh');
const hasBash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout.trim() === 'ok', skip = hasBash ? false : 'bash is not available';

/** A fake `docker` that records every call and prints canned output. Where real compose would print resolved configuration or logs it deliberately prints a secret, so a leak is visible. */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clu-')), bin = path.join(dir, 'bin'), log = path.join(dir, 'calls.log'), runner = path.join(dir, 'runner'); fs.mkdirSync(bin); fs.mkdirSync(runner);
  // `node` as the script sees it is exactly the Node running THIS test, however Node was installed or launched (an npx-installed Node on Windows leaves an extensionless placeholder that bash would pick first)
  fs.writeFileSync(path.join(bin, 'node'), `#!/usr/bin/env bash\nexec "${process.execPath.replace(/\\/g, '/')}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash
echo "docker $*" >> "${log.replace(/\\/g, '/')}"
envf=""; prev=""; for a in "$@"; do [ "$prev" = "--env-file" ] && envf="$a"; prev="$a"; done
secret=""; [ -n "$envf" ] && [ -f "$envf" ] && secret="$(grep '^MAIN_DB_PASSWORD=' "$envf" | cut -d= -f2-)"
case " $* " in
  *" config --quiet "*) [ -n "$FAKE_MISSING" ] && { echo "error while interpolating: required variable X is missing a value" >&2; exit 1; } ;;
  *" config --services "*) printf 'main-db\\nworkspace-signaling-engine\\n' ;;
  *" config "*) echo "MAIN_DB_PASSWORD: $secret" ;;                       # a non-quiet config would leak: the script must never ask for it
  *" ps "*) echo "main-db: exited (Exited (1) 3 seconds ago)"; echo "workspace-signaling-engine: running (Up 5 seconds)" ;;
  *" logs "*) echo "main-db-1  | FATAL: password authentication failed for user qorlla_main password=$secret"; echo "main-db-1  | debug: dumping env MAIN_DB_PASSWORD=$secret"; echo "workspace-signaling-engine-1  | listening on :5000" ;;
  *" down "*) [ -n "$FAKE_DOWN_FAILS" ] && exit 1 ;;
esac
exit 0
`, { mode: 0o755 });
  // PATH: the stub docker first, then THE node running this test (the script calls `node`, however Node was launched)
  const env = (extra = {}) => ({ ...process.env, PATH: bin + path.delimiter + path.dirname(process.execPath) + path.delimiter + process.env.PATH, RUNNER_TEMP: runner, GITHUB_ENV: path.join(dir, 'github_env'), ...extra });
  const sh = (args, extra = {}) => spawnSync('bash', [SCRIPT.replace(/\\/g, '/'), ...args], { encoding: 'utf8', env: env(extra) });
  return { dir, runner, log, sh, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []), envFile: path.join(runner, 'qorlla-ci.env'), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const secretOf = (file) => fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('MAIN_DB_PASSWORD=')).split('=')[1];

test('prepare: creates the environment outside the repository, masks it, exports only the PATH, and prints no value', { skip }, () => {
  const s = sandbox(); try {
    const r = s.sh(['prepare']); assert.equal(r.status, 0, r.stderr); assert.ok(fs.existsSync(s.envFile)); const pw = secretOf(s.envFile);
    const outside = (r.stdout + r.stderr).split('\n').filter((l) => !l.startsWith('::add-mask::')).join('\n'); assert.ok(!outside.includes(pw), 'a value was printed outside ::add-mask::'); assert.match(r.stdout, /::add-mask::/);
    const ghenv = fs.readFileSync(path.join(s.dir, 'github_env'), 'utf8'); assert.match(ghenv, /^QORLLA_CI_ENV_FILE=.*qorlla-ci\.env$/m); assert.ok(!ghenv.includes(pw), 'a value was exported to later steps');
    assert.ok(!path.resolve(s.envFile).startsWith(path.resolve(__dirname, '..', '..') + path.sep), 'the file is not in the repository');
  } finally { s.done(); }
});
test('check: validates with --quiet (never prints the resolved configuration) and every compose call carries the ephemeral --env-file', { skip }, () => {
  const s = sandbox(); try {
    s.sh(['prepare']); const pw = secretOf(s.envFile), r = s.sh(['check']); assert.equal(r.status, 0, r.stderr); assert.ok(!(r.stdout + r.stderr).includes(pw), 'the configuration was printed');
    const calls = s.calls(); assert.ok(calls.some((c) => /config --quiet/.test(c)), 'validated with --quiet'); assert.ok(!calls.some((c) => / config$| config /.test(c) && !/--quiet|--services/.test(c)), 'a non-quiet config call was made');
    assert.ok(calls.every((c) => /--env-file \S*qorlla-ci\.env/.test(c)), 'every call uses the ephemeral environment: ' + calls.join(' | '));
  } finally { s.done(); }
});
test('check fails when a required variable is missing: authentication is not weakened and the failure is visible', { skip }, () => {
  const s = sandbox(); try { s.sh(['prepare']); const r = s.sh(['check'], { FAKE_MISSING: '1' }); assert.notEqual(r.status, 0); assert.match(r.stderr, /required variable/); } finally { s.done(); }
});
test('diagnostics: states and logs go only through the sanitizer; the planted secret and the debug line never appear', { skip }, () => {
  const s = sandbox(); try {
    s.sh(['prepare']); const pw = secretOf(s.envFile), r = s.sh(['diagnostics']); assert.equal(r.status, 0, r.stderr); const out = r.stdout + r.stderr;
    assert.ok(!out.includes(pw), 'a secret reached the output'); assert.ok(!/debug: dumping env/.test(out), 'a non-allowlisted log line was shown'); assert.match(out, /FATAL: password authentication failed/); assert.match(out, /listening on :5000/); assert.match(out, /=== main-db:/); assert.match(out, /=== workspace-signaling-engine:/);
    assert.ok(!/MAIN_DB_PASSWORD/.test(out), 'the secret variable name next to a value must not be echoed');
  } finally { s.done(); }
});
test('down: tears everything down (volumes included), deletes the environment file, and works even if prepare never ran or compose down fails', { skip }, () => {
  const s = sandbox(); try {
    s.sh(['prepare']); let r = s.sh(['down']); assert.equal(r.status, 0, r.stderr); assert.ok(s.calls().some((c) => /down --volumes --remove-orphans/.test(c)), 'volumes and orphans are removed'); assert.ok(!fs.existsSync(s.envFile), 'the environment file was deleted');
    r = s.sh(['down']); assert.equal(r.status, 0, 'teardown with no prior prepare: ' + r.stderr); assert.ok(s.calls().filter((c) => /down --volumes/.test(c)).length >= 2, 'it still ran, with a freshly generated environment (compose would otherwise refuse the missing required variables)');
    r = s.sh(['down'], { FAKE_DOWN_FAILS: '1' }); assert.equal(r.status, 0, 'a failing compose down must not abort the step: ' + r.stderr); assert.ok(!fs.existsSync(s.envFile));
  } finally { s.done(); }
});
test('an unknown subcommand is refused', { skip }, () => { const s = sandbox(); try { assert.equal(s.sh(['nope']).status, 2); assert.equal(s.sh([]).status, 2); } finally { s.done(); } });
