// Opt-in Meet admission contract. Does NOT create a fake participant or peer.
// A real A4->WebRTC media peer executor is a mandatory integration dependency.
import crypto from 'node:crypto';
const uuid=s=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
const isEnabled=()=>process.env.A49_MEET_CONTROLS_ENABLED==='true';
const validSecret=x=>typeof x==='string'&&Buffer.byteLength(x)>=32;
function secureEquals(a,b){return validSecret(b)&&typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));}
export function registerA49Meet({app,db,auth,member,executeMediaCommand=null,emitEvent=()=>{}}) {
 const serviceAuth=(req,res,next)=>{
   if(!isEnabled())return res.status(503).json({code:'A49_MEET_DISABLED'});
   if(!secureEquals((req.get('authorization')||'').replace(/^Bearer /,''),process.env.A49_MEET_CONTROL_SECRET))return res.status(401).json({code:'A49_SERVICE_UNAUTHORIZED'});
   next();
 };
 // Authenticated trusted gateway/control plane creates a waiting-room entry.
 app.post('/api/integrations/a49/waiting',serviceAuth,async(req,res)=>{
   const {callId,meetingId}=req.body||{};
   if(!uuid(callId)||!uuid(meetingId))return res.status(422).json({code:'INVALID_CALL'});
   try {
     const m=(await db.query('SELECT ended_at,locked FROM meetings WHERE id=$1',[meetingId])).rows[0];
     if(!m||m.ended_at||m.locked)return res.status(403).json({code:'MEETING_NOT_JOINABLE'});
     const r=await db.query(`INSERT INTO a49_waiting_calls(call_id,meeting_id) VALUES($1,$2)
       ON CONFLICT(call_id) DO UPDATE SET call_id=a49_waiting_calls.call_id WHERE a49_waiting_calls.meeting_id=EXCLUDED.meeting_id RETURNING call_id`,[callId,meetingId]);
     if(!r.rowCount)return res.status(409).json({code:'CALL_MEETING_CONFLICT'});
     emitEvent(meetingId,'a49-telephone-waiting',{callId});
     return res.status(202).json({accepted:true,callId});
   }catch{return res.status(503).json({code:'WAITING_UNAVAILABLE'});}
 });
 // Host actions must come from an authenticated host participant, never a gateway.
 app.post('/api/meetings/:id/telephone/:callId/decision',auth,member,async(req,res)=>{
   if(!isEnabled())return res.status(503).json({code:'A49_MEET_DISABLED'});
   if(req.user.role!=='host')return res.status(403).json({code:'HOST_REQUIRED'});
   const action=req.body?.decision;
   if(!uuid(req.params.id)||!uuid(req.params.callId)||!['approved','denied'].includes(action))return res.status(422).json({code:'INVALID_DECISION'});
   try {
     const r=await db.query(`UPDATE a49_waiting_calls SET decision=$3,host_participant_id=$4,decided_at=now()
       WHERE meeting_id=$1 AND call_id=$2 AND decision='pending' RETURNING call_id`,
       [req.params.id,req.params.callId,action,req.user.participantId]);
     if(!r.rowCount)return res.status(409).json({code:'DECISION_ALREADY_RECORDED'});
     emitEvent(req.params.id,'a49-telephone-decision',{callId:req.params.callId,decision:action});
     return res.json({accepted:true,decision:action});
   }catch{return res.status(503).json({code:'DECISION_UNAVAILABLE'});}
 });
 // Worker can request execution, but approval is checked again from Meet's own DB.
 app.post('/api/integrations/a49/commands',serviceAuth,async(req,res)=>{
   const {commandId,callId,meetingId,action}=req.body||{};
   if(!uuid(commandId)||!uuid(callId)||!uuid(meetingId)||!['admit','deny','mute','remove','end'].includes(action))
     return res.status(422).json({code:'INVALID_COMMAND'});
   try {
     const seen=await db.query('SELECT action,status,media_peer_joined FROM a49_command_receipts WHERE command_id=$1',[commandId]);
     if(seen.rowCount)return seen.rows[0].action===action&&seen.rows[0].status==='applied'
       ?res.json({accepted:true,commandId,mediaPeerJoined:seen.rows[0].media_peer_joined})
       :res.status(409).json({code:'COMMAND_ALREADY_USED'});
     const approval=(await db.query(`SELECT w.decision,m.ended_at FROM a49_waiting_calls w JOIN meetings m ON m.id=w.meeting_id
       WHERE w.call_id=$1 AND w.meeting_id=$2`,[callId,meetingId])).rows[0];
     if(!approval||approval.ended_at)return res.status(403).json({code:'MEETING_NOT_AVAILABLE'});
     if(action==='admit'&&approval.decision!=='approved')return res.status(403).json({code:'HOST_APPROVAL_REQUIRED'});
     if(action==='deny'&&approval.decision!=='denied')return res.status(403).json({code:'HOST_DENIAL_REQUIRED'});
     if(!['admit','deny'].includes(action))return res.status(503).json({code:'MEDIA_CONTROLS_UNIMPLEMENTED'});
     // Hard blocker: until the live WebRTC/Shield bridge is injected, never pretend
     // that a command acknowledgement actually added or removed a media participant.
     if(typeof executeMediaCommand!=='function')return res.status(503).json({code:'A4_MEDIA_BRIDGE_UNAVAILABLE'});
     const applied=await executeMediaCommand({commandId,callId,meetingId,action});
     if(applied?.applied!==true|| (action==='admit'&&applied.mediaPeerJoined!==true))return res.status(503).json({code:'MEDIA_COMMAND_NOT_CONFIRMED'});
     await db.query(`INSERT INTO a49_command_receipts(command_id,call_id,meeting_id,action,status,media_peer_joined)
       VALUES($1,$2,$3,$4,'applied',$5) ON CONFLICT(command_id) DO NOTHING`,[commandId,callId,meetingId,action,action==='admit']);
     return res.json({accepted:true,commandId,mediaPeerJoined:action==='admit'});
   }catch{return res.status(503).json({code:'MEET_COMMAND_UNAVAILABLE'});}
 });
}

// Portal may poll a Meet-authoritative decision; receipt is not a media admission.
// Control-plane reads require the same dedicated credential, never the chat-export secret.
export function registerA49DecisionReader({app,db}){
  app.get('/api/integrations/a49/decisions/:callId',(req,res,next)=>{
    if(!isEnabled())return res.status(503).json({code:'A49_MEET_DISABLED'});
    if(!secureEquals((req.get('authorization')||'').replace(/^Bearer /,''),process.env.A49_MEET_CONTROL_SECRET))
      return res.status(401).json({code:'A49_SERVICE_UNAUTHORIZED'});
    next();
  },async(req,res)=>{
    if(!uuid(req.params.callId))return res.status(422).json({code:'INVALID_CALL'});
    try{
      const q=await db.query('SELECT call_id,meeting_id,decision,host_participant_id FROM a49_waiting_calls WHERE call_id=$1',[req.params.callId]);
      if(!q.rowCount)return res.status(404).json({code:'WAITING_NOT_FOUND'});
      const x=q.rows[0];
      return res.set('Cache-Control','no-store').json({callId:x.call_id,meetingId:x.meeting_id,
        decision:x.decision,hostParticipantId:x.host_participant_id});
    }catch{return res.status(503).json({code:'MEET_DECISION_UNAVAILABLE'});}
  });
}
