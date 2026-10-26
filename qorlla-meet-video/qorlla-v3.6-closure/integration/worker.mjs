import pg from 'pg';
import {runWorker} from './sync-queue.mjs';
// Replace these callbacks with your MAIN app's approved encrypted vault and scheduling persistence adapters.
// Fail closed until implemented: do not set a production worker live with placeholders.
if(process.env.QORLLA_VAULT_ADAPTER_READY!=='true')throw Error('Configure verified vault and schedule adapters first');
const adapter=await import(process.env.QORLLA_ADAPTER_MODULE);
if(typeof adapter.saveHostSecret!=='function'||typeof adapter.onSynced!=='function')throw Error('Missing required adapter functions');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const controller=new AbortController();
process.on('SIGTERM',()=>controller.abort());process.on('SIGINT',()=>controller.abort());
try {await runWorker(pool,{saveHostSecret:adapter.saveHostSecret,onSynced:adapter.onSynced},controller.signal);}finally{await pool.end();}
