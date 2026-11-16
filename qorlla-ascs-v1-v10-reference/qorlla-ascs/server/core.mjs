import { randomUUID } from 'node:crypto';

export const SHARE_KINDS = Object.freeze(['screen','window','tab','slides','docs','whiteboard','camera']);
export const MODES = Object.freeze(['content','standout','side-by-side','reporter']);
export const ENTITLEMENTS = Object.freeze({
  basic: { screen:true, workspace:false, presenterModes:false, clips:false, ai:false },
  pro: { screen:true, workspace:true, presenterModes:true, clips:true, ai:true },
  business: { screen:true, workspace:true, presenterModes:true, clips:true, ai:true },
  enterprise: { screen:true, workspace:true, presenterModes:true, clips:true, ai:true }
});
export class PolicyError extends Error { constructor(message, status=403){super(message);this.status=status;} }
const premiumKinds = new Set(['slides','docs','whiteboard']);
export function assertSharePermission({actor, meeting, kind, mode='content', entitlements}) {
  if (!actor?.id || !meeting?.id || !meeting.participants?.includes(actor.id)) throw new PolicyError('Not a meeting participant');
  if (!SHARE_KINDS.includes(kind) || !MODES.includes(mode)) throw new PolicyError('Invalid sharing source or mode',400);
  if (meeting.locked || meeting.ended) throw new PolicyError('Meeting cannot be shared');
  if (!['host','cohost','presenter'].includes(actor.role) || actor.guest && !actor.presenterApproved) throw new PolicyError('Presenter permission required');
  if (meeting.activePresenter && meeting.activePresenter !== actor.id) throw new PolicyError('Another presenter is active',409);
  if (!entitlements?.screen) throw new PolicyError('Sharing unavailable for subscription');
  if (premiumKinds.has(kind) && !entitlements.workspace) throw new PolicyError('Workspace sharing entitlement required');
  if (mode !== 'content' && !entitlements.presenterModes) throw new PolicyError('Presenter mode entitlement required');
  return true;
}
export function requireFeature(feature, entitlements) { if (!entitlements?.[feature]) throw new PolicyError(`${feature} entitlement required`); }
export class ShareService {
  constructor({store, authorize, publish, audit}) {Object.assign(this,{store,authorize,publish,audit});}
  async start({meetingId, actor, kind, mode='content', clientRequestId}) {
    if (!clientRequestId || typeof clientRequestId !== 'string' || clientRequestId.length > 128) throw new PolicyError('Client request id required',400);
    return this.store.transaction(meetingId, async meeting => {
      const entitlements = await this.authorize(actor,meeting);
      assertSharePermission({actor,meeting,kind,mode,entitlements});
      if (meeting.activeShare?.requestId === clientRequestId && meeting.activeShare.ownerId === actor.id) return meeting.activeShare;
      if (meeting.activeShare) throw new PolicyError('Share already active',409);
      const share={id:randomUUID(),meetingId,ownerId:actor.id,kind,mode,requestId:clientRequestId,startedAt:new Date().toISOString(),revision:(meeting.revision??0)+1};
      await this.store.saveActive(meetingId,share);
      await this.audit({type:'share.started',meetingId,actorId:actor.id,shareId:share.id,kind});
      await this.publish({type:'share.started',meetingId,share});
      return share;
    });
  }
  async stop({meetingId,actor,shareId}) {
    return this.store.transaction(meetingId,async meeting=>{
      const active=meeting.activeShare;
      if (!active || active.id!==shareId) return {stopped:false};
      if (active.ownerId!==actor.id && actor.role!=='host' && actor.role!=='cohost') throw new PolicyError('Not authorized to stop sharing');
      await this.store.saveActive(meetingId,null);
      await this.audit({type:'share.stopped',meetingId,actorId:actor.id,shareId});
      await this.publish({type:'share.stopped',meetingId,shareId});
      return {stopped:true};
    });
  }
}
