// Keep a handle to this run's disposable server so teardown does not depend on
// Windows taskkill process-tree discovery. Production never uses this launcher.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const pidFile = process.env.QORLLA_TEST_PID_FILE;
if (!pidFile || process.env.NODE_ENV !== 'test') throw new Error('Disposable test configuration required.');
fs.mkdirSync(path.dirname(pidFile), { recursive: true });
const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: process.env, stdio: 'inherit' });
fs.writeFileSync(pidFile, String(child.pid));
child.once('error', () => process.exit(1));
child.once('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill());
