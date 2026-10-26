import fs from 'node:fs';
const path=process.argv[2];if(!path)throw Error('Usage: node apply-worker-recovery.mjs path/to/worker.mjs');
let s=fs.readFileSync(path,'utf8');if(s.includes('v3.8 host recovery'))throw Error('Already patched');
const old="if(result.hostSecret)await saveHostSecret(db,j.source_id,result.hostSecret);";
if(!s.includes(old))throw Error('Expected v3.7 worker not found');
s=s.replace(old,`// v3.8 host recovery: if registration committed remotely but response was lost,
  // GET returns mapping without the one-time host secret. Rotate and vault it.
  const vault=(await db.query('SELECT 1 FROM qorlla_host_vault WHERE source_id=$1',[j.source_id])).rowCount;
  if(result.hostSecret)await saveHostSecret(db,j.source_id,result.hostSecret);
  else if(!vault){
   if(typeof bridge.rotateHost !== 'function')throw Error('Host recovery bridge method unavailable');
   const recovered=await bridge.rotateHost(j.source_id);
   if(!recovered.hostSecret)throw Error('Host recovery returned no credential');
   await saveHostSecret(db,j.source_id,recovered.hostSecret);
  }`);
fs.writeFileSync(path,s);console.log('Patched',path);
