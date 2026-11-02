#!/usr/bin/env node
// Record (or revoke) a Qorlla Telephony release gate. Run by a person AFTER the real test for that gate has passed; there is deliberately no API or button for this.
//   node scripts/phone-certify.mjs --list
//   node scripts/phone-certify.mjs <dialin|carrier|bridge|billing> --evidence <file> --by <name>
//   node scripts/phone-certify.mjs --revoke <gate> --by <name>
// Needs DATABASE_URL (Meet's PostgreSQL). The evidence file (a signed-off test report, call logs, screenshots archive) is hashed; its path and SHA-256 are stored with the gate.
// What each gate means is in docs/TELEPHONY_V2.md. A gate is only half the story: the status shown to users is also derived from live evidence (health check, signed webhooks,
// reconciled usage), so certifying a gate while the carrier is down still shows "not connected".
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pg = require('../qorlla-meet-video/node_modules/pg');

const GATES = { dialin: 'inbound routing of the shared dial-in numbers (real inbound test calls)', carrier: 'real inbound and outbound calls, including failures, duplicates and outages', bridge: 'two-way telephone audio in a real meeting (codecs, DTMF, echo, levels, several callers)', billing: 'provider usage reconciled against carrier charges, taxes, refunds and spending limits' };
const args = process.argv.slice(2), flag = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
const die = (m) => { console.error('phone-certify: ' + m); process.exit(1); };
if (!process.env.DATABASE_URL) die('DATABASE_URL is not set.');
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  if (args.includes('--list')) {
    const { rows } = await db.query('SELECT gate, certified_at, evidence_ref, evidence_sha256, certified_by FROM qphone_gates ORDER BY gate'); const have = new Map(rows.map((r) => [r.gate, r]));
    for (const g of Object.keys(GATES)) { const r = have.get(g); console.log(g.padEnd(8), r ? 'CERTIFIED ' + new Date(r.certified_at).toISOString() + ' by ' + r.certified_by + ' evidence ' + r.evidence_ref + ' sha256 ' + r.evidence_sha256.slice(0, 12) + '...' : 'not certified  (' + GATES[g] + ')'); }
  } else if (flag('revoke')) {
    const g = flag('revoke'), by = flag('by'); if (!GATES[g]) die('unknown gate: ' + g); if (!by) die('--by <name> is required.');
    const r = await db.query('DELETE FROM qphone_gates WHERE gate=$1', [g]); await db.query("INSERT INTO qphone_audit(actor_id,action,subject,detail) VALUES($1,'gate.revoked',$2,'{}')", [by, g]); console.log(r.rowCount ? 'Revoked ' + g + '.' : g + ' was not certified.');
  } else {
    const g = args[0], file = flag('evidence'), by = flag('by'); if (!GATES[g]) die('usage: phone-certify.mjs <' + Object.keys(GATES).join('|') + '> --evidence <file> --by <name>'); if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) die('--evidence must be an existing file.'); if (!by || by.length < 2) die('--by <name> is required.');
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), ref = path.basename(file).slice(0, 200);
    await db.query('INSERT INTO qphone_gates(gate,evidence_ref,evidence_sha256,certified_by) VALUES($1,$2,$3,$4) ON CONFLICT (gate) DO UPDATE SET certified_at=now(), evidence_ref=EXCLUDED.evidence_ref, evidence_sha256=EXCLUDED.evidence_sha256, certified_by=EXCLUDED.certified_by', [g, ref, sha, by]);
    await db.query("INSERT INTO qphone_audit(actor_id,action,subject,detail) VALUES($1,'gate.certified',$2,$3)", [by, g, JSON.stringify({ evidence: ref, sha256: sha })]); console.log('Certified ' + g + ' (' + GATES[g] + ').\nEvidence ' + ref + ' sha256 ' + sha);
  }
} finally { await db.end(); }
