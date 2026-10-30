'use strict';
// The pure parts of the Linux launch smoke test (the launch itself needs a Linux machine with a display; CI runs it).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { parseStat, descendants, field } = require('./linux-launch-smoke.cjs');

test('/proc stat parsing survives command names with spaces and parentheses', () => {
  assert.deepEqual(parseStat('1234 (qorlla) S 1 1234 1234 0 -1'), { pid: 1234, ppid: 1 });
  assert.deepEqual(parseStat('77 (Web Content (x)) S 55 77 77 0 -1'), { pid: 77, ppid: 55 });
  assert.equal(parseStat('garbage'), null);
});
test('the process tree contains the root and only its descendants', () => {
  const table = [{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }, { pid: 20, ppid: 1 }, { pid: 21, ppid: 20 }];
  assert.deepEqual(descendants(10, table).sort(), [10, 11, 12]); assert.deepEqual(descendants(99, table), [99]);
});
test('status fields are read by name', () => { const s = 'Name:\tqorlla\nSeccomp:\t2\nNoNewPrivs:\t1\nUid:\t1001\t1001\t1001\t1001\n'; assert.equal(field(s, 'Seccomp'), '2'); assert.equal(field(s, 'NoNewPrivs'), '1'); assert.equal(field(s, 'Uid').split(/\s+/)[0], '1001'); assert.equal(field(s, 'Nope'), null); });
test('on a platform that is not Linux the script refuses to claim anything (exit 2)', { skip: process.platform === 'linux' }, () => {
  assert.equal(spawnSync(process.execPath, [path.join(__dirname, 'linux-launch-smoke.cjs'), '/opt/Qorlla/qorlla'], { encoding: 'utf8' }).status, 2);
});
