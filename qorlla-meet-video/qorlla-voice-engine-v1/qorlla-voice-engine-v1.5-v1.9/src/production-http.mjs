import {mountReliability} from './reliability-http.mjs';
import {outboxLag,checkDatabase} from './operations.mjs';
export function mountProduction(app,auth,{bus}){
 mountReliability(app,auth);
 app.get('/v1/voice/operational/readiness',async(_req,res)=>{
  try{
   await checkDatabase();
   const lag=await outboxLag();
   const ok=bus.ready&&bus.publisher?.isReady&&bus.subscriber?.isReady&&lag.oldest_seconds<60;
   res.status(ok?200:503).json({ready:!!ok,db:true,redis:!!bus.ready,outbox:lag});
  }catch{res.status(503).json({ready:false})}
 });
}
