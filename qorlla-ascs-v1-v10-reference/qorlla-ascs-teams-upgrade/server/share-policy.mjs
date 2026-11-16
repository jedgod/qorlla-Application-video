/** Pure security checks; adapters MUST fetch actor, meeting and grants from trusted server state. */
export class ShareDenied extends Error {constructor(message,status=403){super(message);this.status=status;}}
export function authorizeShare({actor,meeting,grant,action,ownerId}){
  if(!actor?.id||!meeting?.id||meeting.ended)throw new ShareDenied('Meeting unavailable',404);
  if(actor.tenantId!==meeting.tenantId)throw new ShareDenied('Tenant mismatch');
  if(!meeting.members?.some(m=>m.userId===actor.id&&m.admitted&&!m.removed))throw new ShareDenied('Not an admitted participant');
  const host=meeting.hostId===actor.id||meeting.cohostIds?.includes(actor.id);
  if(action==='start'){
    if(!grant?.canPresent||actor.isGuest&&!grant.guestApproved)throw new ShareDenied('Presenter approval required');
    if(meeting.activePresenterId&&meeting.activePresenterId!==actor.id)throw new ShareDenied('Another presenter is active',409);
  }else if(action==='stop'||action==='revoke'){
    if(!host&&actor.id!==ownerId)throw new ShareDenied('Only owner or host may stop sharing');
  }else throw new ShareDenied('Unknown action',400);
  return {host};
}
