// Only creates isolated test infrastructure; never changes or restarts existing services.
const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const dir=path.resolve('.worktrees/internal-phone'),state=path.join(dir,process.argv[2]==='media'?'test-state-media.json':'test-state.json');
const run=(args,env=process.env)=>cp.execFileSync('docker',args,{encoding:'utf8',env,timeout:90000});
(async()=>{
 if(fs.existsSync(state))throw Error('Test state already exists; inspect it before creating another environment.');
 const name='qorlla-internal-validation-'+crypto.randomBytes(4).toString('hex'),password=crypto.randomBytes(24).toString('hex');
 run(['run','-d','--name',name,'--label','qorlla.scope=internal-phone-validation','-e','POSTGRES_PASSWORD','-p','127.0.0.1::5432','postgres:16-alpine'],{...process.env,POSTGRES_PASSWORD:password});
 let ready=false;for(let i=0;i<60;i++){try{run(['exec',name,'pg_isready','-U','postgres']);ready=true;break;}catch{}await new Promise(r=>setTimeout(r,500));}if(!ready)throw Error('Isolated database did not become ready');
 const info=JSON.parse(run(['inspect',name]))[0],port=info.NetworkSettings.Ports['5432/tcp'][0].HostPort;
 fs.writeFileSync(state,JSON.stringify({container:name,databaseUrl:'postgres://postgres:'+password+'@127.0.0.1:'+port+'/postgres'},null,2));
 console.log('Isolated test database ready:',name,'on loopback port',port,'(credentials kept in ignored test state).');
})().catch(()=>{console.error('Isolated database setup failed. Existing services were not modified.');process.exitCode=1;});
