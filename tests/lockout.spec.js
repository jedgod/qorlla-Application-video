const { test, expect } = require('@playwright/test');
const fs = require('fs'); const os = require('os'); const path = require('path'); const { execFile } = require('child_process');
const { createFileLockoutStore, createLockoutService, MAX_FAILURES, LOCK_MS } = require('../lockout');

// Lockout policy against the standalone (encrypted-file-capable) adapter: restart persistence, atomic budget, cross-process safety, fail-closed.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qorlla-lockout-'));
const quiet = { error() {} };
function make(dir, clock) {
  const now = () => clock.t;
  const store = createFileLockoutStore({ dir, now, lockWaitMs: 300 });
  return createLockoutService({ store, now, perClientMax: 1000, log: quiet });
}
const wrong = async (svc, id = 'M1', ip = '1.1.1.1') => svc.verify({ meetingId: id, clientKey: ip, check: async () => false });
const right = async (svc, id = 'M1', ip = '1.1.1.1') => svc.verify({ meetingId: id, clientKey: ip, check: async () => true });

test.describe('lockout policy (file adapter)', () => {
  test('four failures survive a restart; the fifth locks for ten minutes; the lock expires on the clock', async () => {
    const dir = tmp(); const clock = { t: Date.parse('2030-01-01T00:00:00Z') };
    let svc = make(dir, clock);
    for (let i = 0; i < 4; i++) expect((await wrong(svc)).status).toBe('wrong');
    svc = make(dir, clock);                                                     // "restart": new process state, same directory
    expect((await wrong(svc)).status).toBe('locked');                            // 5th failure activates the lock
    expect((await svc.status('M1')).locked).toBe(true);
    clock.t += LOCK_MS - 1000; expect((await wrong(svc)).status).toBe('locked');
    clock.t += 2000; expect((await wrong(svc)).status).toBe('wrong');            // expired: fresh budget
  });

  test('a restart cannot clear an active lock, and a correct passcode does not lift it', async () => {
    const dir = tmp(); const clock = { t: Date.parse('2030-01-01T00:00:00Z') };
    let svc = make(dir, clock); for (let i = 0; i < 5; i++) await wrong(svc);
    for (let restart = 0; restart < 3; restart++) { svc = make(dir, clock); expect((await right(svc)).status).toBe('locked'); }
    expect((await svc.status('M1')).locked).toBe(true);
  });

  test('success resets the failure counter (documented policy); the budget starts again at five', async () => {
    const dir = tmp(); const clock = { t: 1_900_000_000_000 }; const svc = make(dir, clock);
    for (let i = 0; i < 3; i++) await wrong(svc);
    expect((await right(svc)).status).toBe('ok');
    for (let i = 0; i < 4; i++) expect((await wrong(svc)).status).toBe('wrong');
    expect((await wrong(svc)).status).toBe('locked');
  });

  test('concurrent attempts cannot exceed the verification budget (single process)', async () => {
    const dir = tmp(); const svc = make(dir, { t: Date.now() }); let verified = 0;
    const results = await Promise.all(Array.from({ length: 60 }, () => svc.verify({ meetingId: 'M2', clientKey: 'x', check: async () => { verified++; await new Promise((r) => setTimeout(r, 5)); return false; } })));
    expect(verified).toBeLessThanOrEqual(MAX_FAILURES);
    expect(results.every((r) => ['wrong', 'locked', 'busy'].includes(r.status))).toBe(true);
  });

  test('concurrent attempts across SEVERAL PROCESSES share one budget (exclusive lock)', async () => {
    test.setTimeout(60000);
    const dir = tmp(); const worker = path.join(__dirname, 'support', 'lockout-worker.js');
    const outs = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => execFile(process.execPath, [worker, dir, '8'], { timeout: 50000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(JSON.parse(stdout)))))));
    const verified = outs.reduce((n, o) => n + o.verified, 0);
    expect(verified).toBeLessThanOrEqual(MAX_FAILURES);
    expect(verified).toBeGreaterThan(0);
    const svc = make(dir, { t: Date.now() }); expect((await svc.status('M-SHARED')).locked).toBe(true);
  });

  test('a success that finishes after the lock became active is refused (lockout is not bypassed by in-flight attempts)', async () => {
    const dir = tmp(); const clock = { t: 1_900_000_000_000 }; const store = createFileLockoutStore({ dir, now: () => clock.t });
    expect((await store.reserve('M3')).allowed).toBe(true);                         // attempt A, still verifying
    for (let i = 0; i < 4; i++) { await store.reserve('M3'); await store.settleFailure('M3', 'c'); }
    expect((await store.status('M3')).locked).toBe(true);
    const s = await store.settleSuccess('M3'); expect(s.ok).toBe(false); expect(s.locked).toBe(true);
  });

  test('storage faults fail closed: corrupt state, unobtainable lock; the passcode check never runs', async () => {
    let called = 0; const check = async () => { called++; return true; };
    const corrupt = tmp(); const svcA = make(corrupt, { t: Date.now() }); await wrong(svcA);
    fs.writeFileSync(path.join(corrupt, 'passcode-lockout.json'), '{ this is not json');
    expect((await svcA.verify({ meetingId: 'M1', clientKey: 'c', check })).status).toBe('unavailable');
    const shape = tmp(); fs.writeFileSync(path.join(shape, 'passcode-lockout.json'), JSON.stringify({ nope: 1 }));
    expect((await make(shape, { t: Date.now() }).verify({ meetingId: 'M1', clientKey: 'c', check })).status).toBe('unavailable');
    const busy = tmp(); fs.mkdirSync(path.join(busy, 'passcode-lockout.lock'));       // a live holder (fresh lock directory)
    expect((await make(busy, { t: Date.now() }).verify({ meetingId: 'M1', clientKey: 'c', check })).status).toBe('unavailable');
    expect(called).toBe(0);
  });

  test('a stale lock left by a crashed process is taken over; the host can clear a lock without any passcode involved; events are recorded', async () => {
    const dir = tmp(); const clock = { t: Date.now() };
    const stale = path.join(dir, 'passcode-lockout.lock'); fs.mkdirSync(stale); const old = new Date(Date.now() - 60_000); fs.utimesSync(stale, old, old);
    const svc = make(dir, clock); for (let i = 0; i < 5; i++) await wrong(svc, 'M4', '9.9.9.9');
    let st = await svc.status('M4'); expect(st.locked).toBe(true); expect(st.events[0].kind).toBe('locked'); expect(JSON.stringify(st)).not.toContain('9.9.9.9');
    const out = await svc.clearLock('M4', 'u_host'); expect(out).toEqual({ cleared: true, wasLocked: true });
    st = await svc.status('M4'); expect(st.locked).toBe(false); expect(st.events.map((e) => e.kind)).toEqual(['cleared_by_host', 'locked']);
    expect(JSON.stringify(st)).not.toContain('u_host');
  });

  test('the per-client brake refuses a noisy client before it can spend the meeting budget', async () => {
    const dir = tmp(); const store = createFileLockoutStore({ dir }); const svc = createLockoutService({ store, perClientMax: 3, log: quiet });
    const out = []; for (let i = 0; i < 5; i++) out.push((await wrong(svc, 'M5', '8.8.8.8')).status);
    expect(out).toEqual(['wrong', 'wrong', 'wrong', 'rate_limited', 'rate_limited']);
    expect((await wrong(svc, 'M5', '7.7.7.7')).status).toBe('wrong');            // another client still has its own allowance
  });
});
