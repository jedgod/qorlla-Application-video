// Run from the repository root after npm ci && npm run build in qorlla-phone-join.
// Secrets are read from operator-owned files and are never printed.
import fs from 'node:fs';
import pg from 'pg';
import { createGatewayRuntime } from '../dist/src/runtime.js';
import { reloadableTransport } from '../../qorlla-meet-video/server/telephony/workload-transport.mjs';
const need=n=>{const v=process.env[n];if(!v)throw new Error('Missing '+n);return v;};
let runtime,db;
try {
  const cfg=JSON.parse(fs.readFileSync(need('GATEWAY_CONFIG_FILE'),'utf8'));
  const cert=fs.readFileSync(cfg.tls.certFile,'utf8'),key=fs.readFileSync(cfg.tls.keyFile,'utf8'),ca=fs.readFileSync(cfg.tls.caFile,'utf8');
  const transport=reloadableTransport({certFile:cfg.tls.certFile,keyFile:cfg.tls.keyFile,caFile:cfg.tls.caFile});
  const digest=JSON.parse(fs.readFileSync(cfg.sip.digestFile,'utf8'));
  db=new pg.Pool({connectionString:need('GATEWAY_DATABASE_URL'),max:10});
  runtime=createGatewayRuntime({instance:cfg.instance,db,signalingTls:{cert,key,ca},sip:{...cfg.sip,digest:{...digest,secret:Buffer.from(digest.secretBase64,'base64')}},
    meet:{baseUrl:cfg.meetUrl,fetchImpl:transport.fetchImpl,auth:{kind:'workload',issuer:cfg.issuer,subject:cfg.subject,kid:cfg.kid,privateKeyPem:fs.readFileSync(cfg.signingKeyFile,'utf8'),get cnfThumbprint(){return transport.thumbprint;}}}});
  await runtime.start();console.log(JSON.stringify({event:'gateway_started',dialInEnabled:false,readiness:'Meet-authoritative'}));
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await runtime.stop().catch(()=>undefined);await db.end();};
  process.once('SIGTERM',()=>{void stop();});process.once('SIGINT',()=>{void stop();});
} catch {
  // Error objects may contain request details or database URLs. Keep process logs non-sensitive.
  console.error(JSON.stringify({event:'gateway_start_failed',detail:'Check configuration, migrations, TLS identity and Meet reachability.'}));
  await runtime?.stop().catch(()=>undefined);await db?.end().catch(()=>undefined);process.exitCode=1;
}
