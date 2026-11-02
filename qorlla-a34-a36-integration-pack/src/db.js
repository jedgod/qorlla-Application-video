import pg from 'pg';
export function makeDb(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL required');
  const pool=new pg.Pool({connectionString,max:12,connectionTimeoutMillis:3000,idleTimeoutMillis:10000,ssl:process.env.PG_SSL==='true'?{rejectUnauthorized:true}:undefined});
  return {pool,async withTransaction(fn) {
    const c=await pool.connect();
    try {
      await c.query('BEGIN');
      const tx={one:async(s,p)=>(await c.query(s,p)).rows[0]??null,query:async(s,p)=>(await c.query(s,p)).rows,exec:async(s,p)=>{await c.query(s,p);},event:async(type,payload)=>{await c.query('INSERT INTO voice_outbox(event_type,payload) VALUES($1,$2::jsonb)',[type,JSON.stringify(payload)]);}};
      const result=await fn(tx); await c.query('COMMIT'); return result;
    } catch(e) {await c.query('ROLLBACK').catch(()=>{});throw e;} finally {c.release();}
  }};
}
