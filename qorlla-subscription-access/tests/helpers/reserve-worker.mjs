// A separate OS process acting as one application instance: tries N reservations for one customer and reports the counts.
// usage: node reserve-worker.mjs <databaseUrl> <customerId> <feature> <attempts> <tag>
import { AccessService } from '../../src/accessService.js';

const [url, customerId, feature, attempts, tag] = process.argv.slice(2);
const svc = new AccessService({ connectionString: url, poolMax: 6, connectionTimeoutMs: 60_000, lockTimeoutMs: 30_000, statementTimeoutMs: 40_000 });
const out = { allowed: 0, denied: 0, errors: 0, ids: [] };
await Promise.all(Array.from({ length: Number(attempts) }, async (_, i) => {
  try {
    const r = await svc.reserve(customerId, feature, 1, { idempotencyKey: `${tag}-${i}` });
    if (r.allowed) { out.allowed++; out.ids.push(r.reservationId); } else out.denied++;
  } catch { out.errors++; }
}));
await svc.close();
console.log(JSON.stringify(out));
