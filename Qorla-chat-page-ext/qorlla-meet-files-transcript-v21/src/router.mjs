import {Router} from 'express';
export function collaborationRouter({files,transcripts,workerAuth}){
 const r=Router();const wrap=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next);
 const token=req=>req.headers.authorization?.replace(/^Bearer /,'');const occ=req=>req.params.occ;
 r.post('/:occ/files',wrap(async(req,res)=>res.status(201).json(await files.create(token(req),occ(req),req.body))));
 r.post('/:occ/files/:id/finalize',wrap(async(req,res)=>res.json(await files.finalize(token(req),occ(req),req.params.id))));
 r.post('/:occ/files/:id/approve',wrap(async(req,res)=>res.json(await files.approve(token(req),occ(req),req.params.id,req.body.approved))));
 r.get('/:occ/files',wrap(async(req,res)=>res.json(await files.list(token(req),occ(req)))));
 r.get('/:occ/files/:id/download',wrap(async(req,res)=>res.json(await files.download(token(req),occ(req),req.params.id))));
 r.delete('/:occ/files/:id',wrap(async(req,res)=>res.json(await files.remove(token(req),occ(req),req.params.id))));
 r.post('/:occ/transcripts',wrap(async(req,res)=>res.status(201).json(await transcripts.create(token(req),occ(req),req.body.roomId,req.body.language))));
 r.post('/:occ/transcripts/:id/consent',wrap(async(req,res)=>res.json(await transcripts.consent(token(req),occ(req),req.params.id,req.body.consent))));
 r.get('/:occ/transcripts/:id',wrap(async(req,res)=>res.json(await transcripts.list(token(req),occ(req),req.params.id))));
 r.post('/:occ/transcripts/:id/stop',wrap(async(req,res)=>res.json(await transcripts.stop(token(req),occ(req),req.params.id))));
 // Never expose worker ingest on participant routes. Bind separately on an mTLS/private interface.
 return r;
}
