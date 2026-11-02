export const DEVICE_SCOPES=Object.freeze(['meetings:join','calls:receive','notifications:receive']);
export function validateDeepLink(url){try{const u=new URL(url);if(u.protocol!=='qorlla:'||u.hostname!=='join')return null;const id=u.searchParams.get('meeting');if(!id||!/^[0-9]{11}$/.test(id))return null;return {meetingId:id};}catch{return null}}
export function safeNotificationPayload(p){if(!p||typeof p!=='object')return null;if(!['incoming_call','ticket_update','meeting_invite'].includes(p.type))return null;return {type:p.type,reference:String(p.reference||'').slice(0,80)};}
