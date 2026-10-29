// Background maintenance. Unanswered calls and room invitations become "missed", calls and room seats whose device stopped renewing its lease are closed after a grace period, delivered events past the
// retention window and old tickets are deleted. Every step is an atomic statement (FOR UPDATE SKIP LOCKED / re-checks inside the transaction), so running it on several replicas at once is safe:
// two replicas can never process the same call twice. Each change writes its durable events in the same transaction; afterChange() lets the caller kick the outbox worker.
import { pruneTickets } from './tickets.mjs';

export function startMaintenance({ store, db, reliability = null, afterChange = () => {}, intervalMs = 5000, ringSeconds = 60, leaseGraceSeconds = 120, retentionHours = 168 }) {
  let busy = false, tick = 0;
  const run = async () => {
    if (busy) return; busy = true;
    try {
      const missed = await store.expireRinging(ringSeconds), stale = await store.expireStaleCalls(leaseGraceSeconds);
      const inv = await store.rooms.expireInvites(ringSeconds), seats = await store.rooms.expireStaleMembers(leaseGraceSeconds);
      if (missed.length || stale.length || inv || seats) afterChange();
      if (++tick % 60 === 0) { await pruneTickets(db); if (reliability) await reliability.prune(retentionHours); }
    } catch (e) { console.error('voice maintenance failed', e?.code || e?.message || 'unknown'); }
    finally { busy = false; }
  };
  const timer = setInterval(run, intervalMs); timer.unref?.();
  return { stop: () => clearInterval(timer), runOnce: run };
}
