import { Router } from 'express';
export function breakoutRouter(service) {
 const r=Router({mergeParams:true});
 const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
 const token=req=>req.headers.authorization?.replace(/^Bearer /i,'');
 r.get('/state',wrap(async(req,res)=>res.json(await service.snapshot(token(req),req.params.occurrenceId,Number(req.query.since??0)))));
 r.post('/rooms',wrap(async(req,res)=>res.status(201).json(await service.createRoom(token(req),req.params.occurrenceId,req.body.name))));
 r.post('/assign',wrap(async(req,res)=>res.json(await service.assign(token(req),req.params.occurrenceId,req.body.participantId,req.body.roomId??null,req.body.role??'member'))));
 r.post('/start',wrap(async(req,res)=>res.json(await service.start(token(req),req.params.occurrenceId,req.body.minutes))));
 r.post('/recall',wrap(async(req,res)=>res.json(await service.recall(token(req),req.params.occurrenceId))));
 r.post('/reconcile',wrap(async(req,res)=>res.json(await service.reconcileMedia(token(req),req.params.occurrenceId,req.body.revision))));
 return r;
}
