import crypto from 'node:crypto';
import {transaction,TelephonyError} from './core.mjs';

export function createOutbox({pool,deliver,now=Date.now}) {
  if(typeof deliver!=='function') throw new Error('Idempotent, authenticated delivery callback required');
  return {
    async lease(workerId=crypto.randomUUID(),limit=20,topics=['meet.command','meet.waiting','gateway.originate']) {
      if(!Number.isInteger(limit)||limit<1||limit>100) throw new RangeError('bad lease limit');
      return transaction(pool,async c=>{
        const q=await c.query(`SELECT id,event_id,topic,payload,attempts FROM portal.a49_outbox
          WHERE delivered_at IS NULL AND dead_lettered_at IS NULL
          AND next_attempt_at<=now() AND topic=ANY($2::text[]) AND (lease_until IS NULL OR lease_until<now())
          AND (topic <> 'gateway.originate' OR NOT EXISTS (
            SELECT 1 FROM portal.a49_outbox prior WHERE prior.call_id=a49_outbox.call_id
              AND prior.topic='meet.waiting' AND prior.delivered_at IS NULL))
          ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1`,[limit,topics]);
        const leased=[];
        for(const r of q.rows){
          const token=crypto.randomUUID();
          await c.query(`UPDATE portal.a49_outbox SET lease_owner=$2,lease_token=$3,lease_until=now()+interval '30 seconds'
            WHERE id=$1`,[r.id,workerId,token]);
          leased.push({...r,leaseToken:token,workerId});
        }
        return leased;
      });
    },
    async finish(r,ok,error='',receipt=null) {
      return transaction(pool,async c=>{
        const q=await c.query('SELECT attempts,delivered_at,lease_owner,lease_token,lease_until FROM portal.a49_outbox WHERE id=$1 FOR UPDATE',[r.id]);
        const current=q.rows[0];
        if(!current || current.delivered_at || current.lease_owner!==r.workerId || current.lease_token!==r.leaseToken ||
          !current.lease_until || new Date(current.lease_until).getTime()<=now()) throw new TelephonyError('LEASE_LOST');
        if(ok && r.topic==='meet.command') {
          const p=r.payload;
          if(receipt?.accepted!==true || receipt?.commandId!==p?.commandId ||
             (p.action==='admit' && receipt.mediaPeerJoined!==true))throw new TelephonyError('MEET_RECEIPT_NOT_VERIFIED');
          const command=await c.query('SELECT call_id,meeting_id,action FROM portal.a49_meet_commands WHERE command_id=$1 FOR UPDATE',[p.commandId]);
          if(command.rows[0]?.call_id!==p.callId || command.rows[0]?.meeting_id!==p.meetingId || command.rows[0]?.action!==p.action)
            throw new TelephonyError('COMMAND_BINDING_MISMATCH');
          await c.query("UPDATE portal.a49_meet_commands SET status='applied',completed_at=now() WHERE command_id=$1 AND status='pending'",[p.commandId]);
          if(p.action==='admit')await c.query("UPDATE portal.a49_calls SET admitted=true WHERE id=$1 AND meeting_id=$2 AND state NOT IN ('ended','failed')",[p.callId,p.meetingId]);
        }
        const attempts=Number(current.attempts)+1;
        const backoff=Math.min(3600,2**Math.min(10,attempts));
        await c.query(`UPDATE portal.a49_outbox SET attempts=$2,delivered_at=CASE WHEN $3 THEN now() ELSE NULL END,
          next_attempt_at=now()+($4::integer * interval '1 second'),
          dead_lettered_at=CASE WHEN NOT $3 AND $2>=12 THEN now() ELSE NULL END,
          last_error=$5,lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1`,
          [r.id,attempts,ok,backoff,String(error).slice(0,400)]);
      });
    },
    async runOnce(workerId=crypto.randomUUID(),topics=['meet.command','meet.waiting','gateway.originate']) {
      const jobs=await this.lease(workerId,20,topics);
      for(const r of jobs){
        try {const receipt=await deliver({topic:r.topic,eventId:r.event_id,payload:r.payload,idempotencyKey:r.event_id});await this.finish(r,true,'',receipt);}
        catch(e){await this.finish(r,false,e?.message).catch(()=>{});}
      }
      return jobs.length;
    }
  };
}
