import { PolicyError } from './core.mjs';
// Mount behind Qorlla's existing authenticated Meet router. Never trust roles, plans or meeting IDs from JSON bodies.
export function makeShareHandler({service,resolvePrincipal,resolveMeeting}) {
  return async (req,res) => {
    try {
      const actor=await resolvePrincipal(req); // validated portal session + Shield role
      if (!actor) throw new PolicyError('Authentication required',401);
      const meetingId=req.params.meetingId;
      const meeting=await resolveMeeting(meetingId,actor);
      if (!meeting) throw new PolicyError('Meeting not found',404);
      const result=req.method==='DELETE'
        ? await service.stop({meetingId,actor,shareId:req.params.shareId})
        : await service.start({meetingId,actor,kind:req.body?.kind,mode:req.body?.mode,clientRequestId:req.body?.clientRequestId});
      res.status(req.method==='DELETE'?200:201).json(result);
    } catch(err) {
      const status=err instanceof PolicyError?err.status:500;
      res.status(status).json({error:status===500?'Internal error':err.message});
    }
  };
}
