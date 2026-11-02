// Parameterized, account-scoped history reads. Attach after existing bearer auth.
const uuid = (x) => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const invalid = (res) => res.status(400).json({error:'invalid_input'});
const asyncRoute = (fn) => async (req,res) => { try { await fn(req,res); } catch(e) { console.error('group history query failed',e?.code); res.status(503).json({error:'history_unavailable'}); } };
export function mountRoomHistory(app, db, auth) {
 app.get('/v1/voice/history/rooms',auth,asyncRoute(async(req,res)=>{
   const n = req.query.limit === undefined ? 30 : Number(req.query.limit);
   let before=null;
   if(req.query.before!==undefined) { try { before=JSON.parse(Buffer.from(String(req.query.before),'base64url').toString('utf8')); } catch { return invalid(res); } }
   if(!Number.isInteger(n)||n<1||n>100||(before && (!uuid(before.id)||!Number.isFinite(Date.parse(before.at))))) return invalid(res);
   const {rows}=await db.query(`SELECT r.id,r.title,r.status,r.created_at,r.ended_at,r.end_reason,m.status AS my_status,m.invited_at,m.joined_at,m.left_at,
    (SELECT COALESCE(sum(EXTRACT(EPOCH FROM (COALESCE(s.left_at,now())-s.joined_at))),0)::bigint FROM voice_room_participation_segments s WHERE s.room_id=r.id AND s.account_id=$1) AS my_seconds,
    (SELECT count(*)::int FROM voice_room_participation_segments s WHERE s.room_id=r.id AND s.account_id=$1) AS my_join_count
    FROM voice_room_members m JOIN voice_rooms r ON r.id=m.room_id
    WHERE m.account_id=$1 AND ($2::timestamptz IS NULL OR (r.created_at,r.id) < ($2::timestamptz,$3::uuid))
    ORDER BY r.created_at DESC,r.id DESC LIMIT $4`,[req.account,before?.at??null,before?.id??null,n+1]);
   const items=rows.slice(0,n),last=items.at(-1);
   const nextCursor=rows.length>n&&last?Buffer.from(JSON.stringify({at:last.created_at,id:last.id})).toString('base64url'):null;
   res.set('Cache-Control','no-store').json({items,nextCursor,hasMore:rows.length>n});
 }));
 app.get('/v1/voice/history/rooms/:id',auth,asyncRoute(async(req,res)=>{
   if(!uuid(req.params.id)) return invalid(res);
   const id=req.params.id, account=req.account;
   const {rows: rooms}=await db.query(`SELECT r.id,r.title,r.status,r.created_at,r.ended_at,r.end_reason,m.status AS my_status FROM voice_rooms r JOIN voice_room_members m ON m.room_id=r.id AND m.account_id=$2 WHERE r.id=$1`,[id,account]);
   if(!rooms.length) return res.status(404).json({error:'not_found'});
   const [segments,audit]=await Promise.all([
     db.query(`SELECT id,joined_at,left_at,exit_status,start_generation FROM voice_room_participation_segments WHERE room_id=$1 AND account_id=$2 ORDER BY id`,[id,account]),
     db.query(`SELECT id,kind,occurred_at,account_id,previous_status,new_status,previous_host_id,new_host_id,room_version FROM voice_room_audit_events WHERE room_id=$1 AND (account_id=$2 OR account_id IS NULL) ORDER BY id LIMIT 501`,[id,account])
   ]);
   res.set('Cache-Control','no-store').json({room:rooms[0],mySegments:segments.rows,audit:audit.rows.slice(0,500),auditHasMore:audit.rows.length>500});
 }));
}
