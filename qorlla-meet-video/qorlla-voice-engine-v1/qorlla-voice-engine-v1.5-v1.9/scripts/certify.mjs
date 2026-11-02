import {spawnSync} from 'node:child_process';
// Unit checks are a prerequisite only. Real distributed/physical gates require evidence.
const r=spawnSync(process.execPath,['--test','test/*.test.mjs'],{shell:true,stdio:'inherit'});
if(r.status!==0)process.exit(r.status||1);
const required=['DR01_TRANSACTIONAL_OUTBOX','DR02_REDIS_OUTAGE','DR03_REPLAY','DR04_DEDUP','DR05_FENCING','DR06_TWO_REPLICAS','DR07_BACKPRESSURE','DR08_FAILOVER','DR09_REAL_AUDIO','DR10_OPERATIONS'];
const missing=required.filter(x=>process.env[x]!=='PASS');
if(missing.length){console.error('NOT CERTIFIED: missing independent evidence for '+missing.join(', '));process.exit(3)}
console.log('Evidence flags provided; review signed artifacts before release approval. Flags alone do not constitute certification.');
process.exit(3);
