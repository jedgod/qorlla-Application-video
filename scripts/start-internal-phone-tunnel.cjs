// Publish only the isolated, signature-protected staging boundary. Never tunnels MAIN/Meet.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const dir=path.resolve('.worktrees/internal-phone'),logFile=path.join(dir,'ngrok-private.log'),pidFile=path.join(dir,'ngrok.pid');
(async()=>{
 const health=await fetch('http://127.0.0.1:5081/healthz',{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
 if(health.service!=='qorlla-telnyx-staging'||health.production!==false||health.callAdmission!==false)throw Error('Refusing to tunnel an unexpected service');
 try{await fetch('http://127.0.0.1:4040/api/tunnels',{signal:AbortSignal.timeout(1000)});throw Error('An ngrok agent already exists; inspect it before starting another');}catch(e){if(e.message.startsWith('An ngrok'))throw e;}
 const log=fs.openSync(logFile,'a'),exe=path.join(process.env.LOCALAPPDATA,'Microsoft/WindowsApps/ngrok.exe');
 const child=cp.spawn(exe,['http','http://127.0.0.1:5081','--log=stdout','--log-format=json'],{windowsHide:true,detached:true,stdio:['ignore',log,log]});
 fs.closeSync(log);fs.writeFileSync(pidFile,String(child.pid));child.unref();
 for(let i=0;i<20;i++){
  await new Promise(r=>setTimeout(r,1000));
  try{const j=await fetch('http://127.0.0.1:4040/api/tunnels',{signal:AbortSignal.timeout(1000)}).then(r=>r.json());const tunnel=j.tunnels?.find(t=>t.proto==='https'&&['http://127.0.0.1:5081','127.0.0.1:5081'].includes(t.config?.addr));if(tunnel){const webhook=tunnel.public_url+'/api/telephony/telnyx/webhook';fs.writeFileSync(path.join(dir,'ngrok-public.json'),JSON.stringify({webhook,pid:child.pid,callAdmission:false},null,2));console.log('Staging webhook URL:',webhook);return;}}catch{}
  const raw=fs.readFileSync(logFile,'utf8'),codes=[...new Set(raw.match(/ERR_NGROK_\d+/g)||[])];if(codes.length){console.log('ngrok did not start:',codes.join(', '));process.exitCode=1;return;}
 }
 console.log('ngrok did not expose a staging endpoint within 20 seconds. Inspect its local configuration.');process.exitCode=1;
})().catch(e=>{console.error(e.message);process.exitCode=1;});
