// Contract for existing internal Portal AI gateway. No direct Ollama or external AI endpoint.
export function validatePortalBridge(bridge){
 for(const method of ['stageEncryptedSource','generateRoomReport','deleteStagedSource'])
  if(typeof bridge?.[method]!=='function')throw new Error(`Portal bridge missing ${method}`);
 return bridge;
}
// Production adapter requirements:
// 1. mTLS and workload identity bound to Meet service; rotate credentials.
// 2. Audience-limited short-lived tokens; tenant, occurrence, room, job claims.
// 3. No source text in logs, traces, outbox, or URL query parameters.
// 4. Encrypted temporary input with TTL, verified deletion and no third-party forwarding.
// 5. Enforce policy/quotas in Portal, independently of Meet.
// 6. Strict structured report schema and safe rendering (no raw HTML).
