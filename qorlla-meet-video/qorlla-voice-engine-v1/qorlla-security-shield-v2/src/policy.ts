export const ACTIONS=['voice.internal','voice.pstn.outbound','voice.number.assign','meeting.join','meeting.create','meeting.invite','message.send','guest.join','admin.read','admin.mutate','organization.manage'] as const;
export type Action=typeof ACTIONS[number];
export type Context={action:Action;verified:boolean;mfa:boolean;trustedDevice:boolean;suspended:boolean;orgSuspended:boolean;isGuest:boolean;scopes:string[];risk:number;pstnEnabled:boolean;internationalEnabled:boolean;international:boolean;externalInvite:boolean;destinationAllowed:boolean;};
export type Decision={allow:boolean;reason:string;stepUp:boolean};
export function evaluate(c:Context):Decision {
 const deny=(reason:string,stepUp=false):Decision=>({allow:false,reason,stepUp});
 if(c.suspended||c.orgSuspended)return deny('SUSPENDED');
 if(c.risk>=80)return deny('HIGH_RISK');
 if(c.risk>=50)return deny('REVIEW_REQUIRED');
 if(c.isGuest && !['guest.join','meeting.join'].includes(c.action))return deny('GUEST_RESTRICTED');
 if(c.action==='guest.join')return c.scopes.includes('meeting:guest:admitted')?{allow:true,reason:'ALLOW',stepUp:false}:deny('ADMISSION_REQUIRED');
 if(!c.verified && !['meeting.join'].includes(c.action))return deny('IDENTITY_UNVERIFIED');
 if(['voice.pstn.outbound','voice.number.assign','admin.mutate','organization.manage'].includes(c.action)){
  if(!c.mfa)return deny('MFA_REQUIRED',true);
  if(!c.trustedDevice)return deny('DEVICE_UNTRUSTED',true);
 }
 if(c.action.startsWith('admin.')&&!c.scopes.includes(c.action==='admin.read'?'shield:admin:read':'shield:admin:write'))return deny('SCOPE_MISSING');
 if(c.action==='organization.manage'&&!c.scopes.includes('org:manage'))return deny('SCOPE_MISSING');
 if(c.action==='voice.pstn.outbound'){
  if(!c.pstnEnabled)return deny('PSTN_DISABLED');
  if(c.international&&!c.internationalEnabled)return deny('INTERNATIONAL_DISABLED');
  if(!c.destinationAllowed)return deny('DESTINATION_BLOCKED');
 }
 if(c.action==='meeting.invite'&&c.externalInvite&&!c.scopes.includes('meeting:invite:external'))return deny('EXTERNAL_INVITE_DISABLED');
 return {allow:true,reason:'ALLOW',stepUp:false};
}
