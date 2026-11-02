import {replay,acknowledge,safeCursor} from './reliability.mjs';
import {validDeviceId} from './device-leases.mjs';
// Mount after the existing auth middleware. A reconnect always reconciles from PostgreSQL.
export function mountReliability(app,auth){
 app.get('/v1/voice/events',auth,async(req,res)=>{
 const after=Number(req.query.after??0);if(!safeCursor(after))return res.status(400).json({error:'invalid_cursor'});
 try{res.set('Cache-Control','no-store').json(await replay(req.account,after));}
 catch{res.status(503).json({error:'replay_unavailable'});}
 });
 app.post('/v1/voice/events/ack',auth,async(req,res)=>{
 const {deviceId,cursor}=req.body||{};
 if(!validDeviceId(deviceId)||!safeCursor(cursor))return res.status(400).json({error:'invalid_input'});
 try{res.set('Cache-Control','no-store').json({cursor:await acknowledge(req.account,deviceId,cursor)});}
 catch{res.status(409).json({error:'invalid_cursor'});}
 });
}
