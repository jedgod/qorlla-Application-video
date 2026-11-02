import fs from 'node:fs';
const path=process.argv[2];if(!path)throw Error('Usage: node apply-meet-recovery.mjs path/to/server/index.js');
let src=fs.readFileSync(path,'utf8');const marker='// v3.8: trusted host credential rotation';if(src.includes(marker))throw Error('Already patched');
const anchor="app.get('/api/integrations/scheduled-meetings/:sourceId',bridgeAuth";
if(!src.includes(anchor))throw Error('Unsupported Meet server: v3 integration route missing');
const code=`${marker}
// Call only from the main backend, never the browser. Rotate after crash/loss.
// The caller must verify its local schedule identity and host authorization before calling.
app.post('/api/integrations/scheduled-meetings/:sourceId/rotate-host',bridgeAuth,async(req,res)=>{
 if(!validSource(req.params.sourceId))return fail(res,400,'Invalid source ID');
 const client=await db.connect().catch(()=>null);if(!client)return fail(res,503,'Database unavailable');
 try{
  await client.query('BEGIN');
  const {rows}=await client.query(\`SELECT m.id,m.ended_at FROM external_meeting_links e JOIN meetings m ON m.id=e.meeting_id WHERE e.source_system=$1 AND e.source_id=$2 FOR UPDATE OF m\`,['qorlla-main',req.params.sourceId]);
  if(!rows.length||rows[0].ended_at){await client.query('ROLLBACK');return fail(res,404,'Active scheduled meeting not found');}
  const secret=randomUUID()+randomUUID();
  await client.query('UPDATE meetings SET host_secret_hash=$1 WHERE id=$2',[await bcrypt.hash(secret,10),rows[0].id]);
  await client.query('INSERT INTO audit_events(meeting_id,participant_id,event_type,detail) VALUES($1,NULL,$2,$3)',[rows[0].id,'host.credential_rotated',JSON.stringify({source:'qorlla-main'})]);
  await client.query('COMMIT');return res.json({meetingId:rows[0].id,hostSecret:secret});
 }catch(e){await client.query('ROLLBACK').catch(()=>{});console.error('Host rotation failed');return fail(res,503,'Host rotation unavailable');}
 finally{client.release()}
});
`;
src=src.replace(anchor,code+anchor);fs.writeFileSync(path,src);console.log('Patched',path);
