import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
const eq=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)};
/** Passcode verifier must be supplied by existing meeting service (Argon2id/scrypt). */
export async function requestGuestAdmission({meetingId,passcode,displayName,lookupMeeting,verifyPasscode,rateLimit,store}) {
 if(typeof meetingId!=='string'||!/^[-\w]{6,128}$/.test(meetingId)||typeof passcode!=='string'||passcode.length>256||typeof displayName!=='string'||displayName.trim().length<1||displayName.length>80) return {ok:false,reason:'INVALID_REQUEST'};
 if(!await rateLimit(meetingId)) return {ok:false,reason:'RATE_LIMITED'};
 const meeting=await lookupMeeting(meetingId);
 if(!meeting || meeting.status!=='active' || meeting.guestsAllowed!==true || !await verifyPasscode(passcode,meeting.passcodeHash)) return {ok:false,reason:'INVALID_MEETING_CREDENTIALS'};
 const id=randomUUID();
 await store.createPending({id,meetingId,displayName:displayName.trim(),expiresAt:new Date(Date.now()+300000)});
 return {ok:true,admissionId:id,status:'PENDING_HOST_APPROVAL'};
}
export async function approveGuest({admissionId,host,store,media}) {
 if(!host?.verified || !host?.recentMfa || !host?.canManageMeeting) return {ok:false,reason:'HOST_UNAUTHORIZED'};
 const record=await store.approvePendingAtomically(admissionId,host.meetingId,host.id);
 if(!record) return {ok:false,reason:'NOT_PENDING'};
 // Media gateway MUST independently verify approved admission against DB before issuing credentials.
 return {ok:true,admissionId:record.id,status:'APPROVED',mediaAdmissionRef:await media.registerApproved(record.id,record.meetingId)};
}
/** HMAC event verification, timestamp bound; durable event-id uniqueness is additionally mandatory. */
export function verifyProviderEvent({body,timestamp,signature,secret,now=Date.now()}) {
 if(!Buffer.isBuffer(body)||typeof timestamp!=='string'||!/^\d{10,13}$/.test(timestamp)||!signature||!secret)return false;
 const n=Number(timestamp),ms=timestamp.length===10?n*1000:n;
 if(!Number.isSafeInteger(ms)||Math.abs(now-ms)>300000)return false;
 const expected=createHmac('sha256',secret).update(timestamp).update('.').update(body).digest('hex');
 return /^[a-f0-9]{64}$/i.test(signature)&&eq(expected,signature.toLowerCase());
}
