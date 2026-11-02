import {readFile} from 'node:fs/promises';import {pool} from './store.mjs';
try{await pool.query(await readFile(new URL('../sql/001_voice.sql',import.meta.url),'utf8'));await pool.query(await readFile(new URL('../sql/002_voice_security.sql',import.meta.url),'utf8'));console.log('voice migrations complete');}finally{await pool.end();}
