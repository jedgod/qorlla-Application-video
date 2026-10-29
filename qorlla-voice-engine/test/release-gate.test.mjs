// The release gate must be hard to satisfy by accident and must never approve a release by itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluate, GATES, NEEDS_REAL_ENVIRONMENT, NEEDS_SECOND_PERSON } from '../scripts/release-gate.mjs';

const REV = 'abc1234567', NOW = Date.parse('2026-11-01T12:00:00Z');
const good = (g) => ({ status: 'PASS', evidence: 'artifacts/' + g + '/run.log and report.pdf', operator: 'op-one', reviewer: 'reviewer-two', environment: NEEDS_REAL_ENVIRONMENT.has(g) ? 'staging' : 'development', revision: REV, timestamp: '2026-10-01T09:00:00Z' });
const full = () => Object.fromEntries(GATES.map((g) => [g, good(g)]));
const run = (obj, ...args) => { const dir = mkdtempSync(path.join(tmpdir(), 'gate-')), f = path.join(dir, 'e.json'); writeFileSync(f, JSON.stringify(obj)); return spawnSync(process.execPath, ['scripts/release-gate.mjs', f, ...args], { encoding: 'utf8', cwd: path.resolve(import.meta.dirname, '..') }); };

test('the shipped template is BLOCKED on all 15 gates', () => {
  const tpl = JSON.parse(readFileSync(new URL('../certification-evidence.example.json', import.meta.url), 'utf8')); assert.equal(Object.keys(tpl).length, 15);
  const r = evaluate(tpl, { revision: REV, now: NOW }); assert.equal(r.result, 'BLOCKED'); assert.equal(r.missing.length, 15); assert.equal(r.productionApproved, false);
  const cli = run(tpl, '--revision', REV); assert.equal(cli.status, 1); assert.equal(JSON.parse(cli.stdout).result, 'BLOCKED');
});

test('complete, credible evidence only ever reaches "review required", never an approval', () => {
  const r = evaluate(full(), { revision: REV, now: NOW }); assert.deepEqual(r.missing, []); assert.equal(r.result, 'EVIDENCE_RECORDED_REVIEW_REQUIRED'); assert.equal(r.productionApproved, false); assert.equal(r.reviewRequired, true);
  const cli = run(full(), '--revision', REV); assert.equal(cli.status, 0); assert.equal(JSON.parse(cli.stdout).productionApproved, false);
});

test('each kind of weak evidence is refused, with the reason', () => {
  const block = (mut, gate, re) => { const d = full(); mut(d[gate]); const r = evaluate(d, { revision: REV, now: NOW }); assert.deepEqual(r.missing, [gate], gate); assert.match(r.problems[gate].join(' '), re); };
  block((e) => { e.status = 'PENDING'; }, 'QVE-01', /not PASS/); block((e) => { e.status = 'pass'; }, 'QVE-01', /not PASS/);
  block((e) => { e.evidence = 'ok'; }, 'QVE-02', /evidence must describe/); block((e) => { e.operator = ' '; }, 'QVE-03', /no operator/);
  block((e) => { e.timestamp = 'yesterday'; }, 'QVE-06', /valid date/); block((e) => { e.timestamp = '2026-12-31T00:00:00Z'; }, 'QVE-06', /future/);
  block((e) => { e.revision = 'deadbeef'; }, 'QVE-07', /revision/);
  for (const g of NEEDS_REAL_ENVIRONMENT) for (const env of ['development', 'local', '', undefined]) block((e) => { e.environment = env; }, g, /needs environment/);   // a developer machine cannot pass these
  for (const g of NEEDS_SECOND_PERSON) { block((e) => { e.reviewer = e.operator; }, g, /not the operator/); block((e) => { delete e.reviewer; }, g, /not the operator/); }
  const d = full(); delete d['QVE-15']; assert.deepEqual(evaluate(d, { revision: REV, now: NOW }).missing, ['QVE-15']);
  assert.equal(evaluate(null, { revision: REV }).missing.length, 15); assert.equal(evaluate({}, { revision: REV }).missing.length, 15);
});

test('the CLI fails safe on a missing or broken file', () => {
  assert.equal(spawnSync(process.execPath, ['scripts/release-gate.mjs', 'does-not-exist.json'], { encoding: 'utf8', cwd: path.resolve(import.meta.dirname, '..') }).status, 2);
  const dir = mkdtempSync(path.join(tmpdir(), 'gate-')), f = path.join(dir, 'bad.json'); writeFileSync(f, '{nope'); assert.equal(spawnSync(process.execPath, ['scripts/release-gate.mjs', f], { encoding: 'utf8', cwd: path.resolve(import.meta.dirname, '..') }).status, 2);
});
