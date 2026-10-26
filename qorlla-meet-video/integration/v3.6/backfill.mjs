#!/usr/bin/env node
// Input: JSONL export from MAIN's actual schedules table. Dry-run by default.
import fs from 'node:fs';
import pg from 'pg';
import {enqueue} from './sync-queue.mjs';
const file=process.argv.find(a=>a.endsWith('.jsonl'));
const apply=process.argv.includes('--apply');
if(!file){console.error('Usage: node integration/backfill.mjs schedules.jsonl [--apply]');process.exit(2);}
const lines=fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean);
const jobs=[];const codes=new Set();let bad=0;
for(const [i,line] of lines.entries()){
 try {
  const x=JSON.parse(line); const sourceId=String(x.sourceId||'');const legacyCode=String(x.legacyCode||'').replace(/[\s-]/g,'');
  if(!/^[a-zA-Z0-9:_-]{1,128}$/.test(sourceId)||!/^\d{10,12}$/.test(legacyCode)||!String(x.title||'').trim()||!String(x.ownerName||'').trim()||codes.has(legacyCode))throw Error('Invalid or duplicate schedule');
  if(x.scheduledAt && Number.isNaN(Date.parse(x.scheduledAt)))throw Error('Invalid date');
  codes.add(legacyCode);jobs.push({sourceId,legacyCode,title:x.title,ownerName:x.ownerName,scheduledAt:x.scheduledAt||null});
 }catch(e){bad++;console.error(`line ${i+1}: ${e.message}`);}
}
console.log(JSON.stringify({mode:apply?'apply':'dry-run',valid:jobs.length,invalid:bad}));
if(!apply||bad){if(bad)process.exitCode=1;process.exit();}
if(!process.env.DATABASE_URL)throw Error('MAIN DATABASE_URL required');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
try {for(const job of jobs)await enqueue(pool,job.sourceId,'upsert',job);console.log(`Enqueued ${jobs.length} schedules; no join links published until sync completes.`);}finally{await pool.end();}
