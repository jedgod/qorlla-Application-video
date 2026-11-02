import {replay,acknowledge,safeCursor} from './reliability.mjs';
export async function handleResume({account,deviceId,message,send}){
 if(message?.type==='resume'&&safeCursor(message.after)){
 const page=await replay(account,message.after);
 send({type:'resume_batch',...page});return true;
 }
 if(message?.type==='ack'&&safeCursor(message.cursor)){
 const cursor=await acknowledge(account,deviceId,message.cursor);
 send({type:'ack_ok',cursor});return true;
 }
 return false;
}
export {EventDeduplicator} from './event-dedupe.mjs';
