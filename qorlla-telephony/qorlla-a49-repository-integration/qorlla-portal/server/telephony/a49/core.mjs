import crypto from 'node:crypto';

export class TelephonyError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
const allowed = new Map([
  ['authorized', ['ringing','ended','failed']],
  ['ringing', ['answered','ended','failed']],
  ['answered', ['media_verifying','ended','failed']],
  ['media_verifying', ['connected','ended','failed']],
  ['connected', ['ended','failed']],
  ['ended', []], ['failed', []]
]);
export const EVENT_STATES = Object.freeze({RINGING:'ringing',ANSWERED:'answered',MEDIA_VERIFYING:'media_verifying',MEDIA_VERIFIED:'connected',HANGUP:'ended',FAILED:'failed'});
export const stableHash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const uuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
export const eventSchema = x => {
  if (!x || !uuid(x.eventId) || !uuid(x.callId) || typeof x.gatewayId !== 'string' || !/^[a-zA-Z0-9_-]{3,100}$/.test(x.gatewayId) ||
      typeof x.gatewaySessionId !== 'string' || x.gatewaySessionId.length < 8 || x.gatewaySessionId.length > 128 ||
      !Number.isSafeInteger(x.sequence) || x.sequence < 0 || !Object.hasOwn(EVENT_STATES,x.type) ||
      (x.meetingId !== null && x.meetingId !== undefined && !uuid(x.meetingId))) throw new TelephonyError('INVALID_EVENT',422);
  if (x.type === 'MEDIA_VERIFIED') {
    const e=x.evidence;
    if (!e || e.encrypted !== true || e.inboundAudio !== true || e.outboundAudio !== true || e.gatewayVerified !== true ||
        !Number.isSafeInteger(e.sampleWindowMs) || e.sampleWindowMs < 1000 || e.sampleWindowMs > 30000)
      throw new TelephonyError('MEDIA_NOT_VERIFIED',409);
  }
  return EVENT_STATES[x.type];
};
export function transition(from,to,event,admitted) {
  if (!allowed.get(from)?.includes(to)) throw new TelephonyError('INVALID_TRANSITION');
  if (to==='connected' && event.meetingId && admitted !== true) throw new TelephonyError('ADMISSION_NOT_CONFIRMED',403);
  return to;
}
export function verifyHmac({body,signature,timestamp,nonce,secret,method='POST',path='/api/v1/a49/gateway/events',now=Date.now()}) {
  if (!Buffer.isBuffer(body) || body.length > 65536 || !Number.isSafeInteger(timestamp) || Math.abs(now-timestamp)>60000 ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(nonce ?? '') || !/^[a-f\d]{64}$/i.test(signature ?? '') ||
      typeof secret!=='string' || Buffer.byteLength(secret)<32) throw new TelephonyError('INVALID_GATEWAY_AUTH',401);
  const actual=crypto.createHmac('sha256',secret).update(`${method.toUpperCase()}\n${path}\n${timestamp}.${nonce}.`).update(body).digest();
  if(!crypto.timingSafeEqual(actual,Buffer.from(signature,'hex'))) throw new TelephonyError('INVALID_GATEWAY_AUTH',401);
  return true;
}
export async function transaction(pool,fn) {
  const c=await pool.connect();
  try {await c.query('BEGIN'); const result=await fn(c); await c.query('COMMIT'); return result;}
  catch(e){await c.query('ROLLBACK').catch(()=>{}); throw e;} finally{c.release();}
}

// The callback does not trust requests or caller-provided 'approved' fields. It is
// configured with a Shield service client, and MUST fail closed on errors/outages.
export function createGatewayService({pool,secretFor,shieldAuthorize,clock=Date.now,allowStaging=false}) {
  if(typeof secretFor!=='function' || typeof shieldAuthorize!=='function') throw new Error('Gateway secret resolver and Shield policy are mandatory');
  return {
    async receive({principalId,body,signature,timestamp,nonce}) {
      const secret=await secretFor(principalId);
      verifyHmac({body,signature,timestamp,nonce,secret,now:clock()});
      let event;
      try {event=JSON.parse(body.toString('utf8'));} catch {throw new TelephonyError('INVALID_JSON',400);}
      const to=eventSchema(event);
      if(event.gatewayId!==principalId) throw new TelephonyError('IDENTITY_MISMATCH',403);
      const policy=await shieldAuthorize({principalId,callId:event.callId,meetingId:event.meetingId??null,eventType:event.type});
      if(policy !== true) throw new TelephonyError('SHIELD_DENIED',403);
      return transaction(pool,async c=>{
        const principal=await c.query('SELECT active FROM portal.a49_gateway_principals WHERE id=$1 FOR SHARE',[principalId]);
        if(principal.rowCount!==1 || principal.rows[0].active!==true) throw new TelephonyError('GATEWAY_DISABLED',403);
        const nonceResult=await c.query(`INSERT INTO portal.a49_gateway_nonces(gateway_id,nonce,expires_at) VALUES($1,$2,now()+interval '2 minutes') ON CONFLICT DO NOTHING RETURNING nonce`,[principalId,nonce]);
        if(nonceResult.rowCount!==1) throw new TelephonyError('REPLAY_DETECTED',409);
        const callResult=await c.query('SELECT * FROM portal.a49_calls WHERE id=$1 FOR UPDATE',[event.callId]);
        const call=callResult.rows[0];
        if(!call || call.gateway_id!==principalId || call.gateway_session_id!==event.gatewaySessionId ||
           (call.meeting_id??null)!==(event.meetingId??null)) throw new TelephonyError('UNBOUND_GATEWAY',403);
        const gate=await c.query('SELECT enabled FROM portal.a49_gates WHERE kind=$1 FOR SHARE',[call.kind]);
        if(gate.rows[0]?.enabled!==true && !['ended','failed'].includes(to)) throw new TelephonyError('CALLING_DISABLED',503);
        const existing=await c.query('SELECT payload_sha256 FROM portal.a49_events WHERE event_id=$1',[event.eventId]);
        const bodyHash=stableHash(body);
        if(existing.rowCount) {
          if(existing.rows[0].payload_sha256!==bodyHash) throw new TelephonyError('EVENT_CONFLICT',409);
          return {replayed:true,state:call.state};
        }
        if(event.sequence<=Number(call.sequence_no)) throw new TelephonyError('OUT_OF_ORDER',409);
        transition(call.state,to,event,call.admitted);
        await c.query('INSERT INTO portal.a49_events(event_id,call_id,gateway_id,sequence_no,event_type,payload_sha256) VALUES($1,$2,$3,$4,$5,$6)',
          [event.eventId,event.callId,principalId,event.sequence,event.type,bodyHash]);
        await c.query(`UPDATE portal.a49_calls SET state=$2,sequence_no=$3,version=version+1,
          connected_at=CASE WHEN $2='connected' THEN now() ELSE connected_at END,
          ended_at=CASE WHEN $2 IN ('ended','failed') THEN now() ELSE ended_at END WHERE id=$1`,[event.callId,to,event.sequence]);
        await c.query('INSERT INTO portal.a49_outbox(event_id,call_id,topic,payload) VALUES($1,$2,$3,$4::jsonb)',
          [event.eventId,event.callId,`call.${to}`,JSON.stringify({callId:event.callId,state:to,version:Number(call.version)+1})]);
        return {replayed:false,state:to};
      });
    }
  };
}
