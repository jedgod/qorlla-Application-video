/**
 * Simple TTL cache. Not suitable alone for multi-server consistent enforcement.
 * Use Redis (same interface) in production multi-instance deployments.
 * Cache is used only for subscription/entitlement snapshots, never for quota decisions.
 */

export class MemoryCache {
  constructor({ ttlMs = 30_000, maxSize = 5_000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.store.size >= this.maxSize) {
      const first = this.store.keys().next().value;
      if (first) this.store.delete(first);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  del(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}

export const defaultCache = new MemoryCache();
