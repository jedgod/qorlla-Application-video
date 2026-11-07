import { randomUUID } from 'node:crypto';

export function createA411Worker({ outbox, log, concurrency = 1, pollMs = 1000 }) {
  if (!outbox || typeof outbox.runOnce !== 'function' || typeof log?.error !== 'function') throw new Error('Outbox and logger required');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 20 ||
      !Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60000) throw new RangeError('Invalid worker settings');
  const workerId = randomUUID();
  let running = false, loop = null, wake = null, timer = null;
  const status = { lastSuccessAt: null, lastFailureAt: null, failures: 0 };
  const delay = () => new Promise(resolve => {
    wake = resolve;
    timer = setTimeout(() => { timer = null; wake = null; resolve(); }, pollMs);
  });
  return {
    start() {
      if (running || loop) throw new Error('Worker already running or stopping');
      running = true;
      loop = (async () => {
        while (running) {
          try { await outbox.runOnce(workerId, concurrency); status.lastSuccessAt = new Date().toISOString(); }
          catch (e) { status.lastFailureAt = new Date().toISOString(); status.failures++; log.error('A411 worker poll failed', { error: String(e?.message || e) }); }
          if (running) await delay();
        }
      })();
    },
    async stop({ timeoutMs = 10000 } = {}) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new RangeError('Invalid drain timeout');
      if (!running && !loop) return;
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
      if (wake) { const resolve = wake; wake = null; resolve(); }
      const current = loop;
      let timeout;
      try {
        await Promise.race([current, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Outbox worker drain timed out')), timeoutMs);
        })]);
        if (loop === current) loop = null;
      } finally { clearTimeout(timeout); }
    },
    health() { return { running, ...status }; }
  };
}
