export class PgAdapter {
  constructor(pool) { this.pool = pool; }
  async withTransaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = {
        one: async (sql, args) => (await client.query(sql, args)).rows[0] ?? null,
        query: async (sql, args) => (await client.query(sql, args)).rows,
        exec: async (sql, args) => { await client.query(sql, args); }
      };
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  }
}
export const pgOutbox = {
  async enqueue(tx, type, payload) {
    await tx.exec('INSERT INTO voice_outbox (event_type, payload) VALUES ($1,$2::jsonb)', [type, JSON.stringify(payload)]);
  }
};
