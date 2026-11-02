import crypto from 'node:crypto';
/**
 * Main-side orchestrator. Persist requestId BEFORE calling Meet; retry same requestId.
 * vaultPut MUST durably commit secret + generation + requestId atomically on main DB.
 * ack is best-effort and may be retried independently. Never log returned hostSecret.
 */
export async function recoverHost({sourceId,loadOrCreateRequest,meetIssue,vaultPut,meetAck,verifyHost}) {
  const requestId=await loadOrCreateRequest(sourceId,()=>crypto.randomUUID());
  const result=await meetIssue(sourceId,requestId);
  await vaultPut(sourceId,{secret:result.hostSecret,generation:result.generation,requestId});
  if (!(await verifyHost(sourceId,result.hostSecret))) throw new Error('Host credential verification failed');
  try {await meetAck(sourceId,requestId,result.generation);} catch {return {status:'ack_pending',generation:result.generation};}
  return {status:'recovered',generation:result.generation};
}
