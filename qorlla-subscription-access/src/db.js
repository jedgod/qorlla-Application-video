/**
 * One place for transactions, shared by every service.
 *  - A client that dies while checked out emits 'error'. With no listener that is an uncaught exception that kills the
 *    process, so a listener is attached for the whole checkout; the client is then destroyed instead of being pooled.
 *  - lock_timeout / statement_timeout are set per transaction so a stuck lock holder can never hang a request.
 *  - BEGIN and the SETs go in ONE round trip.
 */

export async function withTx(pool, fn, { readOnly = false, lockTimeoutMs = 5000, statementTimeoutMs = 10_000 } = {}) {
  const client = await pool.connect();
  let broken = false;
  const onError = () => { broken = true; };
  client.on('error', onError);
  try {
    const begin = readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN';
    await client.query(`${begin}; SET LOCAL lock_timeout = ${Math.floor(lockTimeoutMs)}; SET LOCAL statement_timeout = ${Math.floor(statementTimeoutMs)}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }      // connection gone: destroy it, do not pool it
    throw err;
  } finally {
    client.removeListener('error', onError);
    client.release(broken ? true : undefined);
  }
}
