import {Router,raw} from 'express';
export function createLiveAudioRouter({gateway,readToken}){
 const router=Router();
 router.post('/:occ/transcripts/:id/audio',raw({type:['audio/webm','audio/mp4','audio/ogg'],limit:'2mb'}),async(req,res)=>{
  try {const token=await readToken(req);if(!token)return res.status(401).json({error:'unauthorized'});
   const result=await gateway.ingest({token,occ:req.params.occ,sessionId:req.params.id,epoch:Number(req.headers['x-consent-epoch']),chunkId:req.headers['x-chunk-id'],chunkStartMs:Number(req.headers['x-chunk-start-ms']),audio:req.body,contentType:req.headers['content-type']?.split(';')[0]});
   res.json(result);
  }catch(e){const known=/unauthorized|consent_required|not_active_or_stale/.test(e.message);res.status(known?403:400).json({error:known?'not_authorized':'audio_rejected'});}
 });return router;
}
