#!/usr/bin/env node
/**
 * One-off helper: copy the OLD shared Mail / Notes / Calendar / Schedule / Whiteboard data
 * (from before those became private per account) into one account's private files.
 *
 *   node scripts/migrate-legacy.js <username> [--force]
 *   docker compose exec workspace-signaling-engine node scripts/migrate-legacy.js <username>
 *
 * Reads DATA_DIR (default ./data). The legacy files are never modified or deleted, and an
 * existing private file is left alone unless --force is given.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const store = require('../store');

const COLLECTIONS = ['mail', 'notes', 'calendar', 'schedule', 'whiteboard'];
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const args = process.argv.slice(2);
const force = args.includes('--force');
const username = (args.find((a) => !a.startsWith('--')) || '').toLowerCase();

function fail(msg) { console.error('Error: ' + msg); process.exit(1); }
if (!username) fail('usage: node scripts/migrate-legacy.js <username> [--force]');

let users;
try { users = store.readJson(path.join(dataDir, 'auth', 'users.json'), null); }
catch (e) { fail(e.message); }
if (!users) fail('could not find ' + path.join(dataDir, 'auth', 'users.json'));

const user = users.find((u) => u.username === username);
if (!user) fail('no account named "' + username + '"');
if (!/^u_[0-9a-f-]{36}$/.test(user.id)) fail('unexpected account id format');

const dir = path.join(dataDir, 'workplace');
let copied = 0;
COLLECTIONS.forEach((name) => {
  const from = path.join(dir, name + '.json');
  const to = path.join(dir, name + '.' + user.id + '.json');
  if (!fs.existsSync(from)) { console.log('- ' + name + ': no legacy file, skipped'); return; }
  if (fs.existsSync(to) && !force) { console.log('- ' + name + ': account already has data, skipped (use --force to overwrite)'); return; }
  let items;
  try { items = store.readJson(from, null); } catch (e) { console.log('- ' + name + ': legacy file unreadable, skipped'); return; }
  store.writeJson(to, items); // encrypted automatically when ENCRYPT_KEY is set
  console.log('- ' + name + ': copied ' + items.length + ' item' + (items.length === 1 ? '' : 's'));
  copied++;
});
console.log('Done: ' + copied + ' collection' + (copied === 1 ? '' : 's') + ' copied to @' + username + '. Legacy files were left in place.');
