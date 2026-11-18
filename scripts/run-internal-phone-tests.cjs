const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const base=path.resolve('.worktrees/internal-phone'),state=JSON.parse(fs.readFileSync(path.join(base,process.argv[2]==='internal'?'test-state-media.json':'test-state.json'),'utf8'));
const logs=path.resolve('artifacts/internal-phone-validation');fs.mkdirSync(logs,{recursive:true});
const env={...process.env,PHONE_TEST_DATABASE_URL:state.databaseUrl,PHONE_JOIN_TEST_DATABASE_URL:state.databaseUrl,VOICE_TEST_DATABASE_URL:state.databaseUrl,MEET_SERVER_DIR:path.join(base,'qorlla-meet-video'),SHIELD_ENGINE_DIR:path.join(base,'qorlla-voice-engine')};
const group=process.argv[2]||'unit';
if(group==='internal'){env.A5_E2E='1';env.A5_EVIDENCE_DIR=logs;}
const groups={
 unit:['qorlla-phone-join',['dist/test/internal-admission.test.js','dist/test/admission.test.js','dist/test/gateway-auth.test.js','dist/test/sip-gateway-config.test.js','dist/test/sip-ingress.test.js','dist/test/telephone-flow.test.js','dist/test/mesh-peer.test.js','dist/test/runtime.test.js','dist/test/meet-signaling.test.js']],
 meet:['qorlla-meet-video',['tests/internal-phone.test.mjs','tests/phone-server.pg.test.mjs','tests/phone-lifecycle.pg.test.mjs','tests/phone-peer.pg.test.mjs']],
 voice:['qorlla-voice-engine',fs.readdirSync(path.join(base,'qorlla-voice-engine/test')).filter(n=>n.endsWith('.test.mjs')&&!['distributed.redis.test.mjs','redis-tls.test.mjs'].includes(n)).map(n=>'test/'+n)],
 regression:['qorlla-meet-video',fs.readdirSync(path.join(base,'qorlla-meet-video/tests')).filter(n=>n.endsWith('.test.mjs')&&!n.startsWith('phone')&&!n.startsWith('internal')).map(n=>'tests/'+n)],
 internal:['qorlla-phone-join',['dist/test/internal-media.e2e.test.js']]
 ,'voice-focused':['qorlla-voice-engine',['test/core.test.mjs','test/internal-provider.pg.test.mjs','test/internal-security.pg.test.mjs','test/store.pg.test.mjs']]
 ,'regression-focused':['qorlla-meet-video',['tests/chat-markup.test.mjs','tests/bridge-contract.test.mjs','tests/consent-lock.test.mjs']]
 ,'targeted':['qorlla-phone-join',['dist/test/internal-admission.test.js','dist/test/media-setup-budget.test.js','dist/test/telnyx-call-control.test.js','test/telnyx-webhook.test.mjs','../qorlla-meet-video/tests/internal-phone.test.mjs']]
};
if(!groups[group])throw Error('Unknown test group');const[cwd,files]=groups[group];
const child=cp.spawn(process.execPath,['--test','--test-concurrency=1',...files],{cwd:path.join(base,cwd),env,stdio:['ignore','pipe','pipe']});
const logName=group+(process.env.INTERNAL_TEST_RUN_SUFFIX||'')+'.tap';
const out=fs.createWriteStream(path.join(logs,logName));child.stdout.pipe(out);child.stderr.pipe(out);
child.on('exit',code=>{console.log(group+' test exit: '+code+'; evidence: artifacts/internal-phone-validation/'+logName);process.exitCode=code||0;});
