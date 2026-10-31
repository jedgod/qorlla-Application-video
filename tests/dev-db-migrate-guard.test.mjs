// node --test tests/dev-db-migrate-guard.test.mjs
// The development migration runner must be impossible to point at a production-like database by accident. No Docker and no database are used:
// the port lookup is injected, and every refusal must happen BEFORE any database work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDevelopmentTarget, migrate } from '../scripts/dev-db-migrate.mjs';

const loopback = () => ({ '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '35433' }] });
const ok = (o = {}) => assertDevelopmentTarget({ container: 'qviewer-dev-db', env: {}, authorized: true, ports: loopback, ...o });
const refuses = (o, re) => assert.throws(() => ok(o), re);

test('explicit authorisation is required (dev stack: authorized:true, command line: QORLLA_DEV_DB_MIGRATE=yes)', () => {
  refuses({ authorized: false }, /explicit authori[sz]ation/);
  refuses({ authorized: false, env: { QORLLA_DEV_DB_MIGRATE: 'true' } }, /explicit authori[sz]ation/);   // only the exact value "yes"
  ok({ authorized: false, env: { QORLLA_DEV_DB_MIGRATE: 'yes' } });
  ok();
});

test('production-like environment settings are rejected, whatever else is set', () => {
  for (const [k, v] of [['NODE_ENV', 'production'], ['QORLLA_ENV', 'staging'], ['APP_ENV', 'PROD'], ['ENVIRONMENT', 'live'], ['DEPLOY_ENV', 'uat']]) refuses({ env: { [k]: v } }, /production-like environment/);
  ok({ env: { NODE_ENV: 'development' } });
});

test('only development-looking, production-free container names are accepted', () => {
  for (const name of ['qorlla-prod-db', 'meet-production', 'live-meet-dev-db', 'qorlla-staging-dev', 'postgres', 'qorlla_meet', 'db', 'main-db']) assert.throws(() => ok({ container: name }), /Refusing/, name);
  for (const name of ['qviewer-dev-db', 'qorlla-meet-dev-db', 'qviewer-fresh-db', 'qviewer-partial-db', 'ci-test-pg']) ok({ container: name });
});

test('names that could be read as docker options or shell text are rejected', () => {
  for (const name of ['-rf', '--help-dev', 'dev db', 'dev;rm', 'dev$(id)', '', undefined, 'a'.repeat(80) + '-dev']) assert.throws(() => ok({ container: name }), /Refusing/, String(name));
});

test('a database published beyond the loopback interface is refused; loopback-only or unpublished is fine', () => {
  assert.throws(() => ok({ ports: () => ({ '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '35433' }] }) }), /loopback/);
  assert.throws(() => ok({ ports: () => ({ '5432/tcp': [{ HostIp: '', HostPort: '35433' }] }) }), /loopback/);
  assert.throws(() => ok({ ports: () => ({ '5432/tcp': [{ HostIp: '10.0.0.5', HostPort: '35433' }] }) }), /loopback/);
  ok({ ports: () => ({ '5432/tcp': null }) });
  ok({ ports: () => ({}) });
  ok({ ports: () => null });
});

test('migrate() refuses before doing any database work (the injected port lookup is never reached for a bad name or missing authorisation)', () => {
  let reached = false; const spy = () => { reached = true; return {}; };
  assert.throws(() => migrate({ container: 'qorlla-prod-db', root: '.', authorized: true, ports: spy }), /production-like/);
  assert.throws(() => migrate({ container: 'qviewer-dev-db', root: '.', authorized: false, env: {}, ports: spy }), /explicit authori[sz]ation/);
  assert.equal(reached, false);
});
