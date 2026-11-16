import {randomUUID} from 'node:crypto';
export async function runOutboxBatch({integration,deliver,workerId=randomUUID(),limit=20}){
 const rows=await integration.leaseOutbox({workerId,limit});let delivered=0,failed=0;
 for(const row of rows){try{await deliver({id:row.id,topic:row.topic,payload:row.payload,callId:row.call_id});await integration.finishOutbox({id:row.id,workerId,ok:true});delivered++;}catch(error){await integration.finishOutbox({id:row.id,workerId,ok:false,error:error?.message||'delivery failed'});failed++;}}
 return {delivered,failed};
}
