// Background maintenance: unanswered calls become "missed" (with an audit event and a notification to both parties) and old tickets are deleted.
// Single instance: with several instances this needs leader election (see the README).
import { pruneTickets } from './tickets.mjs';

export function startMaintenance({ store, db, onExpired = () => {}, intervalMs = 5000, ringSeconds = 60 }) {
  let busy = false;
  const run = async () => {
    if (busy) return; busy = true;
    try { for (const call of await store.expireRinging(ringSeconds)) onExpired(call); await pruneTickets(db); }
    catch (e) { console.error('voice maintenance failed', e?.code || e?.message || 'unknown'); }
    finally { busy = false; }
  };
  const timer = setInterval(run, intervalMs); timer.unref?.();
  return { stop: () => clearInterval(timer), runOnce: run };
}
