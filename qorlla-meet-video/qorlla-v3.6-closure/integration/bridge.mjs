// Server-only bridge for Qorlla main (Node >=20). Never import into browser bundles.
const base = () => new URL(process.env.MEET_BASE_URL || 'http://127.0.0.1:3000');
export async function meetBridge(path, method='GET', body) {
 const secret=process.env.QORLLA_BRIDGE_SECRET;
 if(!secret||secret.length<32)throw new Error('Missing QORLLA_BRIDGE_SECRET');
 const url=new URL(path,base());
 const response=await fetch(url,{method,headers:{'content-type':'application/json','x-qorlla-bridge-secret':secret},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
 const data=await response.json().catch(()=>({error:'Invalid Meet response'}));
 if(!response.ok){const err=new Error(`Meet bridge ${response.status}: ${data.error||'Request failed'}`);err.status=response.status;throw err;}
 return data;
}
export const registerSchedule = data => meetBridge('/api/integrations/scheduled-meetings','POST',data);
export const getSchedule = sourceId => meetBridge(`/api/integrations/scheduled-meetings/${encodeURIComponent(sourceId)}`);
export const updateSchedule = (sourceId,data) => meetBridge(`/api/integrations/scheduled-meetings/${encodeURIComponent(sourceId)}`,'PATCH',data);
export const cancelSchedule = sourceId => meetBridge(`/api/integrations/scheduled-meetings/${encodeURIComponent(sourceId)}/cancel`,'POST');
// Integration sequence: create schedule in MAIN DB with durable sourceId and pending_sync;
// registerSchedule; atomically save returned meetingId/meetingCode and encrypted hostSecret;
// mark synced; retry pending_sync with same sourceId on failures. Do not publish an unregistered join link.
