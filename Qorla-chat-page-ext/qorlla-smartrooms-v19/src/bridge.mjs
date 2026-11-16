import {signBody} from './security.mjs';
export class PortalBridge {
 constructor({url,secret,fetcher=fetch,timeoutMs=8000}){
  if(!url?.startsWith('https://') || !secret || secret.length<32)throw new Error('HTTPS Portal URL and 32+ character secret required');
  this.url=url.replace(/\/$/,'');this.secret=secret;this.fetcher=fetcher;this.timeoutMs=timeoutMs;
 }
 async submitRoomReport({occurrenceId,roomId,jobId,consentEvidence,actorId}){
  if(!consentEvidence?.allConsented || !consentEvidence?.participants?.length)throw new Error('Room consent missing');
  const payload={occurrenceId,roomId,jobId,actorId,consentEvidence,kind:'room-summary'};
  const body=JSON.stringify(payload),timestamp=String(Date.now());
  const response=await this.fetcher(`${this.url}/internal/meet/room-reports`,{
   method:'POST',signal:AbortSignal.timeout(this.timeoutMs),
   headers:{'content-type':'application/json','x-qorlla-timestamp':timestamp,
    'x-qorlla-signature':signBody(this.secret,timestamp,body),'idempotency-key':jobId},body
  });
  if(!response.ok)throw new Error(`Portal gateway rejected job: HTTP ${response.status}`);
  const result=await response.json();
  if(!result?.jobId || !['accepted','completed'].includes(result.status))throw new Error('Invalid Portal gateway response');
  return result;
 }
}
