#!/usr/bin/env node
// Safe opt-in patch copier for jedgod/qorlla-Application-video, reviewed against main 810e196.
// Does not commit, push, merge, deploy, run migrations, or enable live calling.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const arg=process.argv.indexOf('--repo');
if(arg<0||!process.argv[arg+1])throw Error('Usage: node scripts/apply.mjs --repo /path/to/repository [--apply]');
const root=path.resolve(process.argv[arg+1]);
const actuallyApply=process.argv.includes('--apply');
if(!fs.existsSync(path.join(root,'.git')))throw Error('Not a Git checkout');
// A5 already owns telephone waiting, verification peers and phone_calls; do not install parallel Meet routes onto that branch.
if(fs.existsSync(path.join(root,'qorlla-meet-video/server/phone-peer.mjs')))
  throw Error('A5 telephone-admission branch detected. Reconcile against its authoritative phone_calls lifecycle; do not install duplicate A49 Meet routes. See docs/A5_RECONCILIATION.md');
const anchors=[
  {file:'qorlla-portal/server/app.mjs',old:"import { registerPhone } from './phone.mjs';",neo:"import { registerPhone } from './phone.mjs';\nimport { mountA49 } from './telephony/a49/runtime.mjs';"},
  {file:'qorlla-portal/server/app.mjs',old:'  const { identity, member, roles } = auth;',neo:"  const { identity, member, roles } = auth;\n  mountA49(app, { express, pool, auth, log });"},
  {file:'qorlla-meet-video/server/index.js',old:"import { recoveryService } from './recovery-service.mjs';",neo:"import { recoveryService } from './recovery-service.mjs';\nimport { registerA49Meet, registerA49DecisionReader } from './a49-integration.mjs';"},
  {file:'qorlla-meet-video/server/index.js',old:"const validSource=v=>typeof v==='string'&&/^[a-zA-Z0-9_.:-]{1,120}$/.test(v);",neo:"const validSource=v=>typeof v==='string'&&/^[a-zA-Z0-9_.:-]{1,120}$/.test(v);\nregisterA49Meet({app,db,auth,member,emitEvent:(meetingId,event,payload)=>io.to(room(meetingId)).emit(event,payload)});\nregisterA49DecisionReader({app,db});"}
];
const copies=[
  'qorlla-portal/sql/008_a49_voice.sql',
  'qorlla-meet-video/sql/009_a49_meet_commands.sql',
  'qorlla-meet-video/server/a49-integration.mjs',
  ...fs.readdirSync(path.join(source,'qorlla-portal/server/telephony/a49')).map(x=>'qorlla-portal/server/telephony/a49/'+x),
  ...fs.readdirSync(path.join(source,'qorlla-portal/tests')).map(x=>'qorlla-portal/tests/'+x)
];
const edits=new Map();
for(const a of anchors){
  const filename=path.join(root,a.file);if(!fs.existsSync(filename))throw Error('Missing expected file '+a.file);
  let current=edits.get(a.file)??fs.readFileSync(filename,'utf8');
  if(current.includes(a.neo))continue;
  if(current.split(a.old).length!==2)throw Error('Upstream anchor changed; manual merge required: '+a.file);
  try{const diff=execFileSync('git',['diff','--name-only','HEAD','--',a.file],{cwd:root,encoding:'utf8'}).trim();
    if(diff)throw Error('Target file has uncommitted changes: '+a.file);
  }catch(e){if(/uncommitted changes/.test(e.message))throw e;throw Error('Git diff failed: '+e.message);}
  current=current.replace(a.old,a.neo);edits.set(a.file,current);
}
for(const file of copies){const destination=path.join(root,file);
 if(fs.existsSync(destination)&&fs.readFileSync(destination,'utf8')!==fs.readFileSync(path.join(source,file),'utf8'))
   throw Error('Destination exists with different content: '+file);
}
if(!actuallyApply){console.log('Dry run OK. Would modify:',[...edits.keys()].join(', '));console.log('Would copy '+copies.length+' files. Re-run with --apply.');process.exit(0);}
for(const [file,content] of edits){fs.writeFileSync(path.join(root,file),content);console.log('UPDATED',file);}
for(const file of copies){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.copyFileSync(path.join(source,file),path.join(root,file));console.log('COPIED',file);}
console.log('Applied locally. Nothing committed or deployed. Both call capabilities remain disabled.');
