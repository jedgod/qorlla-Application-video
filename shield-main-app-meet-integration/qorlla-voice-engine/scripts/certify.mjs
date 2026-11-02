// Unit and integration tests are a prerequisite only. The distributed and physical-device gates (docs/VOICE_CERTIFICATION.md) need independently recorded evidence: this script never certifies by itself.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const tests = readdirSync(new URL('../test/', import.meta.url)).filter((f) => f.endsWith('.test.mjs')).map((f) => 'test/' + f);
const r = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status || 1);
const required = ['DR01_TRANSACTIONAL_OUTBOX', 'DR02_REDIS_OUTAGE', 'DR03_REPLAY', 'DR04_DEDUP', 'DR05_FENCING', 'DR06_TWO_REPLICAS', 'DR07_BACKPRESSURE', 'DR08_FAILOVER', 'DR09_REAL_AUDIO', 'DR10_OPERATIONS'];
const missing = required.filter((x) => process.env[x] !== 'PASS');
if (missing.length) { console.error('NOT CERTIFIED: missing independent evidence for ' + missing.join(', ')); process.exit(3); }
console.log('Evidence flags were provided. Review the signed artifacts before approving a release: flags alone are not certification.');
process.exit(3);
