// Child process used by the lockout tests: hammers one shared lockout directory with wrong-passcode attempts and reports how many were actually verified.
const { createFileLockoutStore, createLockoutService } = require('../../lockout');
const [dir, attempts] = [process.argv[2], Number(process.argv[3] || 5)];
(async () => {
  const service = createLockoutService({ store: createFileLockoutStore({ dir, lockWaitMs: 20000 }), perClientMax: 1000, log: { error() {} } });
  let verified = 0; const statuses = {};
  await Promise.all(Array.from({ length: attempts }, async () => {
    const r = await service.verify({ meetingId: 'M-SHARED', clientKey: 'worker-' + process.pid, check: async () => { verified++; return false; } });
    statuses[r.status] = (statuses[r.status] || 0) + 1;
  }));
  process.stdout.write(JSON.stringify({ verified, statuses }));
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(2); });
