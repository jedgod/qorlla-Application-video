import pg from 'pg';
import {config} from './config.js';
export const pool = new pg.Pool({connectionString:config.DATABASE_URL,max:15,connectionTimeoutMillis:5000,ssl:process.env.PG_SSL==='true'?{rejectUnauthorized:true}:undefined});
export async function transaction<T>(fn:(c:pg.PoolClient)=>Promise<T>):Promise<T>{
 const c=await pool.connect(); try {await c.query('BEGIN'); const result=await fn(c); await c.query('COMMIT');return result;}
 catch(e){await c.query('ROLLBACK');throw e;} finally {c.release();}
}
