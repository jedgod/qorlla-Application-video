/**
 * Every object this package owns lives in ONE dedicated schema, so it can share a database with unrelated applications
 * without touching their tables, grants or roles (migrations never revoke or grant anything outside this schema).
 *
 * Application SQL uses unqualified table names, so each connection must resolve them to this schema first. Pools the package
 * creates itself are configured for that. A pool you pass in is NEVER modified (it may be shared with other code); it is checked
 * instead, and a misconfigured pool makes the service fail closed with a clear message:
 *
 *   new pg.Pool({ connectionString, options: '-c search_path=subscription_access,pg_catalog' })
 *   postgres://user:pw@host/db?options=-c%20search_path%3Dsubscription_access%2Cpg_catalog
 */

import pg from 'pg';

export const SCHEMA = 'subscription_access';
export const SEARCH_PATH = `${SCHEMA},pg_catalog`;

/** Pool configuration with the schema search path applied. */
export const poolConfig = (connectionString, extra = {}) => ({ connectionString, options: `-c search_path=${SEARCH_PATH}`, ...extra });

/**
 * A pool the package owns. It ALWAYS has an 'error' listener: when the database drops an idle connection (a failover, a restart,
 * an administrator terminating a session) pg emits 'error' on the pool, and with no listener Node treats that as an uncaught
 * exception and the whole process dies. Logging is the right response: the pool discards the dead client and reconnects.
 */
export function createPool(connectionString, extra = {}) {
  const pool = new pg.Pool(poolConfig(connectionString, extra));
  pool.on('error', (e) => console.error('[subscription-access] idle database connection error (discarded, the pool will reconnect):', e.message));
  return pool;
}

const verified = new WeakMap();

/** Throws unless the pool's connections resolve unqualified names to the subscription schema first. Cached once it succeeds. */
export function ensureSearchPath(pool) {
  let p = verified.get(pool);
  if (!p) {
    p = pool.query('SELECT current_setting(\'search_path\') AS sp').then((r) => {
      const first = String(r.rows[0].sp).split(',')[0].trim().replace(/^"|"$/g, '');
      if (first !== SCHEMA) {
        throw new Error(`database connection search_path is "${r.rows[0].sp}" but must start with ${SCHEMA}: create the pool with options '-c search_path=${SEARCH_PATH}'`);
      }
    });
    p.catch(() => verified.delete(pool));                       // a failure is not cached: fix the pool and the next call succeeds
    verified.set(pool, p);
  }
  return p;
}
