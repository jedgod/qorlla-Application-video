import {listRecent,detail} from './history.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Pass your EXISTING authenticated middleware. Never trust account_id from query/body.
export function mountGroupHistory(app,{pool,requireAuth,base='/v1/voice/history'}){
 if(!pool||typeof requireAuth!=='function')throw Error('pool and requireAuth required');
 app.get(base,requireAuth,async(req,res,next)=>{try{const id=req.auth?.accountId;if(typeof id!=='string'||!id)return res.status(401).json({error:'unauthorized'});res.set('Cache-Control','private, no-store');res.json(await listRecent(pool,id,{limit:req.query.limit,cursor:req.query.cursor}));}catch(e){next(e);}});
 app.get(`${base}/:callId`,requireAuth,async(req,res,next)=>{try{const id=req.auth?.accountId;if(typeof id!=='string'||!id)return res.status(401).json({error:'unauthorized'});if(!UUID.test(req.params.callId))return res.status(400).json({error:'invalid_call_id'});const item=await detail(pool,id,req.params.callId);res.set('Cache-Control','private, no-store');if(!item)return res.status(404).json({error:'not_found'});res.json(item);}catch(e){next(e);}});
}
