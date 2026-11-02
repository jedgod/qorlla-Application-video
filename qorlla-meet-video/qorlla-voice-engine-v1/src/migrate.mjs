import {readFile} from 'node:fs/promises';import {pool} from './store.mjs';
try{await pool.query(await readFile(new URL('../sql/001_voice.sql',import.meta.url),'utf8'));console.log('voice migration complete');}finally{await pool.end();}
