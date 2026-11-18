// Review bundle only. Does not apply the patch or deploy any service.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const git='C:/Program Files/Git/cmd/git.exe',base=path.resolve('.worktrees/internal-phone'),out=path.resolve('artifacts/internal-phone-validation');
const commit=cp.execFileSync(git,['rev-parse','feature/qorlla-sip-gateway-integration'],{encoding:'utf8'}).trim();
fs.mkdirSync(out,{recursive:true});const baseline=path.join(base,'.baseline');fs.mkdirSync(baseline,{recursive:true});
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const files=[];function walk(dir){for(const e of fs.readdirSync(path.join(base,dir),{withFileTypes:true})){if(['node_modules','dist','.dev-stack'].includes(e.name))continue;const rel=dir+'/'+e.name;if(e.isDirectory())walk(rel);else if(/\.(mjs|js|ts|sql)$/.test(e.name))files.push(rel);}}
for(const dir of ['qorlla-meet-video/server','qorlla-meet-video/sql','qorlla-meet-video/tests','qorlla-phone-join/src','qorlla-phone-join/test','qorlla-phone-join/scripts','qorlla-voice-engine/src'])walk(dir);
files.push('qorlla-meet-video/public/app.js');
const manifest={baseCommit:commit,isolatedSource:base,deployed:false,files:[]};let patch='';
for(const file of files){const current=fs.readFileSync(path.join(base,file),'utf8').replace(/\r\n/g,'\n');let original='';try{original=cp.execFileSync(git,['show',commit+':'+file],{encoding:'utf8',stdio:['ignore','pipe','ignore']});}catch{}if(current===original.replace(/\r\n/g,'\n'))continue;
 manifest.files.push({path:file,sha256:hash(current),baseSha256:original?hash(original):null});
 const a=path.join(baseline,'old.txt'),b=path.join(baseline,'new.txt');fs.writeFileSync(a,original);fs.writeFileSync(b,current);let diff;try{diff=cp.execFileSync(git,['diff','--no-index','--no-prefix','--',a,b],{encoding:'utf8',stdio:['ignore','pipe','ignore']});}catch(e){if(e.status!==1)throw e;diff=e.stdout;}
 diff=diff.replace(/^diff --git .*$/m,'diff --git a/'+file+' b/'+file).replace(/^--- .*$/m,'--- '+(original?'a/'+file:'/dev/null')).replace(/^\+\+\+ .*$/m,'+++ b/'+file);if(!original)diff=diff.replace('diff --git a/'+file+' b/'+file+'\n','diff --git a/'+file+' b/'+file+'\nnew file mode 100644\n').replace(/^index [^\n]+\n/m,'');patch+=diff;
}
fs.writeFileSync(path.join(out,'integration.patch'),patch);fs.writeFileSync(path.join(out,'source-manifest.json'),JSON.stringify(manifest,null,2));
const list=path.join(out,'source-files.txt');fs.writeFileSync(list,manifest.files.map(f=>f.path).join('\n')+'\n');
cp.execFileSync('tar',['-czf',path.join(out,'internal-phone-source.tar.gz'),'-C',base,'-T',list]);
console.log('Packaged',manifest.files.length,'changed source files for review against',commit.slice(0,12),'; no deployment.');
