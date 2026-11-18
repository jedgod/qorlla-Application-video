// Isolated coturn relay test. Loopback only, ephemeral credentials, no production relay changes.
const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const logs=path.resolve('artifacts/internal-phone-validation');fs.mkdirSync(logs,{recursive:true});
const name='qorlla-internal-turn-'+crypto.randomBytes(4).toString('hex'),pass=crypto.randomBytes(24).toString('hex');
const run=(args,env=process.env)=>cp.execFileSync('docker',args,{encoding:'utf8',env,timeout:60000,stdio:['ignore','pipe','pipe']});
(async()=>{
 let started=false;const report={container:name,isolated:true,production:false,allocationAndRelay:false,badCredentialRejected:false};
 try{
 run(['run','-d','--name',name,'--label','qorlla.scope=internal-phone-validation','-p','127.0.0.1::3478/udp','coturn/coturn:latest','-n','--no-cli','--no-tls','--no-dtls','--fingerprint','--lt-cred-mech','--realm=internal.validation','--user=internaltest:'+pass,'--allow-loopback-peers','--no-multicast-peers','--min-port=49540','--max-port=49559']);started=true;
 await new Promise(r=>setTimeout(r,2000));
 const args=['exec','-e','TURN_TEST_PASSWORD',name,'sh','-c','exec turnutils_uclient -v -u internaltest -w "$TURN_TEST_PASSWORD" -p 3478 -y -n 10 127.0.0.1'];
 const output=run(args,{...process.env,TURN_TEST_PASSWORD:pass});
 fs.writeFileSync(path.join(logs,'turn-relay.log'),output.replaceAll(pass,'[redacted]'));
 report.allocationAndRelay=/tot_recv_msgs=\s*[1-9]/.test(output) && !/tot_lost_packets=\s*[1-9]/.test(output);
 try{run(args,{...process.env,TURN_TEST_PASSWORD:'deliberately-wrong-test-credential'});}catch{report.badCredentialRejected=true;}
 }catch(e){report.error='TURN relay validation failed; inspect isolated container logs.';fs.writeFileSync(path.join(logs,'turn-error.log'),String(e.stderr||e.stdout||e.message).replaceAll(pass,'[redacted]'));}finally{
 if(started)try{run(['stop','--time','5',name]);}catch{}
 fs.writeFileSync(path.join(logs,'turn-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!report.allocationAndRelay||!report.badCredentialRejected)process.exitCode=1;
 }
})();
