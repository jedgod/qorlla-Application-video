#!/usr/bin/env node
/**
 * Convert every JSON data file under DATA_DIR (default ./data) between plaintext and encrypted.
 *
 *   ENCRYPT_KEY=<64 hex> node scripts/encrypt-data.js encrypt            plaintext -> encrypted
 *   ENCRYPT_KEY=<64 hex> node scripts/encrypt-data.js decrypt            encrypted -> plaintext
 *   ENCRYPT_KEY=<new> ENCRYPT_KEY_OLD=<old> node scripts/encrypt-data.js rotate
 *   add --dry-run to see what would change without touching anything
 *
 * Stop the server first so nothing writes while files are being converted, and keep a backup.
 * Each file is rewritten atomically and verified by reading it back before moving on.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const store = require('../store');

const [cmd, ...rest] = process.argv.slice(2);
const dry = rest.includes('--dry-run');
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function fail(msg) { console.error('Error: ' + msg); process.exit(1); }
if (!['encrypt', 'decrypt', 'rotate'].includes(cmd)) fail('usage: node scripts/encrypt-data.js <encrypt|decrypt|rotate> [--dry-run]');
if (!store.enabled) fail('ENCRYPT_KEY is not set (64 hex characters; generate with: openssl rand -hex 32)');
if (cmd === 'rotate' && !store.hasOldKey) fail('rotate needs the previous key in ENCRYPT_KEY_OLD');
if (!fs.existsSync(dataDir)) fail('data directory not found: ' + dataDir);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.json')) yield full;
  }
}

let changed = 0, skipped = 0, failed = 0;
for (const file of walk(dataDir)) {
  const rel = path.relative(dataDir, file);
  try {
    const info = store.inspect(file);
    const want = cmd === 'decrypt' ? false : true;
    // "encrypt": only plaintext needs work. "decrypt": only encrypted. "rotate": rewrite everything.
    if (cmd !== 'rotate' && info.encrypted === want) { skipped++; continue; }
    if (dry) { console.log(`would ${cmd}: ${rel}`); changed++; continue; }
    store.writeJson(file, info.data, { plain: cmd === 'decrypt' });
    const back = store.inspect(file);
    if (JSON.stringify(back.data) !== JSON.stringify(info.data) || back.encrypted !== want) throw new Error('verification after write failed');
    console.log(({ encrypt: 'encrypted', decrypt: 'decrypted', rotate: 'rotated' })[cmd] + ': ' + rel);
    changed++;
  } catch (err) {
    failed++;
    console.error(`FAILED ${rel}: ${err.message}`);
  }
}
console.log(`\n${dry ? 'Dry run: ' : ''}${changed} file(s) ${dry ? 'would change' : 'converted'}, ${skipped} already in the right state, ${failed} failed.`);
process.exit(failed ? 1 : 0);
