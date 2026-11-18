import fs from 'node:fs';
import Database from 'better-sqlite3';
import pg from 'pg';
export function createDb(config=process.env){
 const driver=config.DB_DRIVER||'sqlite';
 if(driver==='sqlite'){
  const db=new Database(config.SQLITE_PATH||':memory:');
  db.pragma('journal_mode=WAL'); db.pragma('foreign_keys=ON'); db.pragma('busy_timeout=5000');
  db.exec(fs.readFileSync(new URL('../sql/sqlite.sql',import.meta.url),'utf8'));
  return {driver,raw:db,close:()=>db.close()};
 }
 if(driver==='postgres'){
  const pool=new pg.Pool({connectionString:config.DATABASE_URL,max:10,ssl:config.PGSSL==='true'?{rejectUnauthorized:true}:undefined});
  // An idle pooled connection that the server drops (restart, failover) emits 'error'; unhandled, that would crash the process.
  // The pool discards the dead client and opens a new one on the next query.
  pool.on('error',e=>console.error(JSON.stringify({service:'qgics',event:'pg_idle_client_error',code:e&&e.code})));
  let closed=false;
  return {driver,raw:pool,close:async()=>{if(closed)return;closed=true;await pool.end();}};
 }
 throw new Error('unsupported_database');
}
