import {randomUUID} from 'node:crypto';

/** Mount under authenticated Meet routing. Audio is never persisted by this gateway. */
export function liveAudioGateway({pool,authority,transcripts,engineUrl,engineToken,fetchImpl=fetch,maxBytes=2_000_000}) {
 if(!pool||!authority||!transcripts||!engineUrl||!engineToken||engineToken.length<32) throw Error('invalid_gateway_configuration');
 const inflight=new Set();
 async function check(c,token,occ,sessionId,epoch){
  const actor=await authority.verify(token,occ);
  if(!actor||!actor.participantId||!actor.tenantId||actor.occurrenceId!==occ)throw Error('unauthorized');
  const r=await c.query(`SELECT * FROM meet_collab.transcript_sessions WHERE id=$1 AND tenant_id=$2 AND occurrence_id=$3 FOR UPDATE`,[sessionId,actor.tenantId,occ]);
  const s=r.rows[0];
  if(!s||s.status!=='active'||Number(s.consent_epoch)!==epoch)throw Error('not_active_or_stale');
  const current=(await authority.listActiveRoomMembers(c,actor.tenantId,occ,s.room_id)).map(x=>x.participantId);
  const consent=(await c.query(`SELECT participant_id FROM meet_collab.transcript_participants WHERE session_id=$1 AND consent=true`,[sessionId])).rows.map(x=>x.participant_id);
  if(!current.length||current.length!==consent.length||!current.every(id=>consent.includes(id))||!current.includes(actor.participantId))throw Error('consent_required');
  return {speakerId:actor.participantId,language:s.language};
 }
 async function verify(token,occ,sessionId,epoch){
  const c=await pool.connect();try{await c.query('BEGIN');const v=await check(c,token,occ,sessionId,epoch);await c.query('COMMIT');return v;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release()}
 }
 async function ingest({token,occ,sessionId,epoch,chunkId,chunkStartMs,audio,contentType}){
  if(!/^[0-9a-f-]{36}$/i.test(sessionId)||!Number.isSafeInteger(epoch)||epoch<1||!Number.isSafeInteger(chunkStartMs)||chunkStartMs<0)throw Error('invalid_parameters');
  if(!/^[0-9a-f-]{36}$/i.test(chunkId))throw Error('invalid_chunk_id');
  if(!Buffer.isBuffer(audio)||audio.length<100||audio.length>maxBytes)throw Error('invalid_audio_size');
  if(!['audio/webm','audio/mp4','audio/ogg'].includes(contentType))throw Error('unsupported_audio_type');
  const v=await verify(token,occ,sessionId,epoch);
  const c=await pool.connect();let claimed=false;
  try {await c.query('BEGIN');await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[sessionId+chunkId]);
   const r=await c.query(`INSERT INTO meet_collab.audio_chunks(session_id,chunk_id,speaker_id,epoch,status) VALUES($1,$2,$3,$4,'processing') ON CONFLICT DO NOTHING RETURNING chunk_id`,[sessionId,chunkId,v.speakerId,epoch]);
   claimed=!!r.rowCount;await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  if(!claimed)return {accepted:true,duplicate:true};
  const controller=new AbortController();inflight.add(controller);
  try {
   const resp=await fetchImpl(new URL('/internal/transcribe',engineUrl),{method:'POST',headers:{'content-type':contentType,'x-internal-token':engineToken,'x-language':v.language},body:audio,signal:controller.signal});
   if(!resp.ok)throw Error('stt_engine_unavailable');
   const result=await resp.json();if(!Array.isArray(result.segments)||result.segments.length>100)throw Error('invalid_engine_response');
   // Revalidate after inference. Revoked/changed epochs reject all late results.
   await verify(token,occ,sessionId,epoch);
   for(const seg of result.segments){if(typeof seg.text!=='string'||seg.text.length>10000||!Number.isSafeInteger(seg.startMs)||!Number.isSafeInteger(seg.endMs))throw Error('invalid_segment');
    await transcripts.ingestFromTrustedWorker({sessionId,epoch,speakerId:v.speakerId,startMs:chunkStartMs+seg.startMs,endMs:chunkStartMs+seg.endMs,text:seg.text});}
   await pool.query(`UPDATE meet_collab.audio_chunks SET status='done',completed_at=now() WHERE session_id=$1 AND chunk_id=$2`,[sessionId,chunkId]);
   return {accepted:true,segments:result.segments.length};
  }catch(e){await pool.query(`UPDATE meet_collab.audio_chunks SET status='failed',completed_at=now() WHERE session_id=$1 AND chunk_id=$2`,[sessionId,chunkId]).catch(()=>{});throw e}
  finally{inflight.delete(controller)}
 }
 return {ingest,verify,abortLocal:()=>{for(const c of inflight)c.abort()}};
}
