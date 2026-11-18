// Reuse the existing real-browser test fixtures, without its lab readiness stub.
const fs=require('fs'),path=require('path'),b=path.resolve('.worktrees/internal-phone/qorlla-phone-join');
let helper=fs.readFileSync(path.join(b,'test/helpers/shield-lab.ts'),'utf8');
helper=helper.replace("const idp = await identityProvider(), h = harness({ db, idp });","const directorySecret=crypto.randomBytes(32).toString('hex');\n  const idp = await identityProvider(), h = harness({ db, idp });");
helper=helper.replace("SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true',","VOICE_INTERNAL_GATEWAY_SECRET:directorySecret, VOICE_PSTN_ENABLED:'false', VOICE_NUMBERS_ENABLED:'false', SHIELD_ENABLED: 'true', SHIELD_ENFORCE: 'true',");
helper=helper.replace('    url,',`    url,
    voiceEnv: { PHONE_INTERNAL_VOICE_URL: engine.base, PHONE_INTERNAL_VOICE_SECRET: directorySecret },
    provisionExtension: async (extension:string) => {
      const account='internal-'+extension;
      await db.pool.query('INSERT INTO voice_identities(account_id,extension) VALUES($1,$2) ON CONFLICT DO NOTHING',[account,extension]);
      await db.pool.query('INSERT INTO shield_principals(account_id,verified) VALUES($1,true) ON CONFLICT (account_id) DO UPDATE SET verified=true',[account]);
    },`);
fs.writeFileSync(path.join(b,'test/helpers/shield-lab.ts'),helper);
let phone=fs.readFileSync(path.join(b,'test/helpers/synthetic-phone.ts'),'utf8');
phone=phone.replace('number?: string;','number?: string; caller?: string;');phone=phone.replace('sip:+12025550123@127.0.0.1','sip:${this.o.caller ?? \'+12025550123\'}@127.0.0.1');fs.writeFileSync(path.join(b,'test/helpers/synthetic-phone.ts'),phone);
let runner=fs.readFileSync(path.join(b,'scripts/a5-gateway-runner.mjs'),'utf8');
runner=runner.replace("if (process.env.A5_LAB_READINESS !== '1')", "if (process.env.INTERNAL_VALIDATION !== '1')");
runner=runner.replace("const authority = new MeetPhoneAuthority({ baseUrl: MEET, auth: { kind: 'hmac', secret: HMAC },", "const auth=JSON.parse(need('INTERNAL_WORKLOAD_AUTH'));\nconst {MeetReadiness}=await imp('readiness-meet.js');\nconst readiness=new MeetReadiness({baseUrl:MEET,auth,mode:'internal',cacheMs:0});\nconst authority = new MeetPhoneAuthority({ mode:'internal', baseUrl: MEET, auth,");
runner=runner.replace(/const READY = [^\n]+/, '// Readiness comes from Meet, never a static override.');
runner=runner.replace('createSipGateway({ enabled: true, labMode: true,','createSipGateway({ mode:\'internal\',meetingExtension:\'7000\',enabled: true, labMode: true,');
runner=runner.replace('readiness: async () => READY','readiness: () => readiness.get()');
runner=runner.replace("const addr = await gw.start();", "const addr = await gw.start();\nif(!await authority.heartbeat('internal-validation',true,true))throw Error('Heartbeat rejected');\nconst healthTimer=setInterval(()=>authority.heartbeat('internal-validation',true,true).catch(()=>false),10000);healthTimer.unref();");
fs.writeFileSync(path.join(b,'scripts/internal-validation-runner.mjs'),runner);
let source=fs.readFileSync(path.join(b,'test/e2e-chrome.test.ts'),'utf8');source=source.slice(0,source.indexOf("test('REAL CHROMIUM"));
source=source.replace("SIP_USER = 'a5trunk'","SIP_USER = '2041'");
source=source.replace("const ROOT =",`const GW_PAIR=crypto.generateKeyPairSync('ec',{namedCurve:'P-256'});
const GW_AUTH={kind:'workload',issuer:'internal-test',subject:'svc:internal-phone',kid:'it1',privateKeyPem:GW_PAIR.privateKey.export({type:'pkcs8',format:'pem'})};
const GW_ENV={PHONE_JOIN_MODE:'internal',PHONE_GATEWAY_ENABLED:'true',PHONE_GATEWAY_REQUIRE_MTLS:'false',PHONE_INTERNAL_VALIDATION:'true',PHONE_FEATURES:'internal,bridge,turn,security,internal-validation',PHONE_GATEWAY_KEYS_JSON:JSON.stringify({'internal-test':{it1:GW_PAIR.publicKey.export({type:'spki',format:'pem'})}}),PHONE_GATEWAY_SUBJECTS_JSON:JSON.stringify({'svc:internal-phone':['phone.verify','phone.health','phone.readiness','phone.media','phone.peer','phone.decision','phone.end','phone.consent']})};
const ROOT =`);
source=source.replace("PHONE_MEDIA_STALE_MS: '15000', ...extraEnv", "PHONE_MEDIA_STALE_MS: '15000', ...GW_ENV, ...extraEnv");
source=source.replace("A5_LAB_READINESS: '1'", "INTERNAL_VALIDATION:'1', INTERNAL_WORKLOAD_AUTH:JSON.stringify(GW_AUTH)");
source=source.replace("'a5-gateway-runner.mjs'","'internal-validation-runner.mjs'");
source=source.replace("number: '+12025550100'","number: '7000', caller:'2041'");
source+=`
test('INTERNAL: real Voice directory and Shield, real Meet host approval, SIP/SRTP to Chromium two-way audio, ICE restart and cleanup, with zero public numbers', {skip:skipShield,timeout:300000},async()=>{
 const shield=await shieldOf(),owner=await shield.owner();await shield.provisionExtension('2041');
 const meet=await startMeet({...shield.meetEnv(),...shield.voiceEnv});
 const gates=['internal','bridge','turn','security','internal-validation'];
 for(const gate of gates)await admin.query(\`INSERT INTO \${schema}.qphone_gates(gate,evidence_ref,evidence_sha256,certified_by) VALUES($1,'isolated automated fixture', $2,'test-only') ON CONFLICT(gate) DO NOTHING\`,[gate,'a'.repeat(64)]);
 assert.equal((await admin.query(\`SELECT count(*)::int AS n FROM \${schema}.qphone_numbers\`)).rows[0].n,0);
 const gw=await startGateway(meet.base),seeded=await seedMeeting(meet.base,owner);
 const A=await openMeeting(await chrome(1000),meet.base,'Alice',seeded.id);
 const B=await openMeeting(await chrome(1500),meet.base,'Bob',seeded.id);
 const pin=(await seeded.makePin()).pin;const phone=await dial(gw,seeded.code,pin);
 assert(await eventually(async()=>!!(await admin.query(\`SELECT 1 FROM \${schema}.phone_calls WHERE state='AWAITING_HOST'\`)).rowCount,15000),'internal caller waits for host');
 assert.equal((await admin.query(\`SELECT count(*)::int AS n FROM \${schema}.phone_calls WHERE state='MEDIA_CONNECTED'\`)).rows[0].n,0);
 const row=(await admin.query(\`SELECT * FROM \${schema}.phone_calls WHERE state='AWAITING_HOST'\`)).rows[0];
 const h=await fetch(meet.base+'/api/meetings/'+seeded.id+'/admit',{method:'POST',headers:{authorization:'Bearer '+A.token,'content-type':'application/json'},body:JSON.stringify({participantId:row.participant_id,allow:true})});assert.equal(h.status,200);
 assert(await eventually(async()=>(await dbCall(row.provider_call_id))?.state==='MEDIA_CONNECTED',60000),'Meet accepted verified internal media: '+gw.log().slice(-1000));
 assert(await eventually(()=>snr(heard(phone),1000)>30 && snr(heard(phone),1500)>30,15000),'phone hears both meeting peers');
 const gatewayIndex=await A.page.evaluate(()=>(window as any).__peerIndexes().find((p:any)=>p.gateway&&p.state==='connected')?.i);
 assert.notEqual(gatewayIndex,undefined);
 const before=await A.page.evaluate((i)=>(window as any).__stats(i),gatewayIndex);assert(before.inPackets>0);
 await A.page.evaluate((i)=>(window as any).__fail(i),gatewayIndex);
 assert(await eventually(async()=>snr(heard(phone),1000)>30 && (await connectedPeers(A.page)).some((p:any)=>p.gateway&&p.state==='connected'),30000),'ICE recovery restores audio');
 phone.bye();assert(await eventually(async()=>(await dbCall(row.provider_call_id))?.state==='TERMINATED',20000));assert((await cred(row.id)).revoked_at);
 Object.assign(evidence,{mode:'internal',publicNumbers:0,pstn:false,hostApproval:true,phoneHears:{alice:snr(heard(phone),1000),bob:snr(heard(phone),1500)},trail:await trail(row.id)});saveEvidence('internal-media');
});
`;
fs.writeFileSync(path.join(b,'test/internal-media.e2e.test.ts'),source);
console.log('Prepared real internal media test (isolated fixture gates, no production approval).');
