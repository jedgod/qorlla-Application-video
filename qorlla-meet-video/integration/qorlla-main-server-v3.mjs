// Import from the MAIN Node server only. Requires Node >=20.
// Set MEET_BASE_URL and QORLLA_BRIDGE_SECRET in the main server environment.
export async function reconcileScheduledMeeting({sourceId,title,ownerName,legacyCode,scheduledAt}) {
 const base=process.env.MEET_BASE_URL||'http://127.0.0.1:3000';
 const secret=process.env.QORLLA_BRIDGE_SECRET;
 if(!secret||secret.length<32)throw Error('Missing QORLLA_BRIDGE_SECRET');
 const url=new URL('/api/integrations/scheduled-meetings',base);
 const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-qorlla-bridge-secret':secret},body:JSON.stringify({sourceId,title,ownerName,legacyCode,scheduledAt}),signal:AbortSignal.timeout(10000)});
 const data=await response.json();
 if(!response.ok)throw Error(`Meet reconciliation ${response.status}: ${data.error}`);
 // Persist meetingId and meetingCode in the main app database before publishing schedule.
 // hostSecret (if created) is a credential: store encrypted server-side; never in URLs/logs.
 return data;
}
