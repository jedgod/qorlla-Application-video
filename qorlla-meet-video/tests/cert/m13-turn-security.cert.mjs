// M1.3 CERTIFICATION, suite 1: TURN allocation revocation and credential lifecycle (P0), against the HARDENED relay (tests/cert/relay-hardened-up.sh) with a raw TURN client that behaves
// like a malicious / non-compliant client. No browser: every check is a protocol-level fact about what coturn accepts.
//   LAN_IP=<lan> tests/cert/relay-hardened-up.sh
//   node tests/cert/m13-turn-security.cert.mjs            (CERT_RUN=n labels the evidence file; BOUND_RUNS=n sets the enforcement-bound sample size)
import { randomUUID, createHash } from 'node:crypto';
import { TurnClient } from '../lib/turn-client.mjs';
import { CERT, newDb, authority, reporter, wait, until, sh, pctl } from './lib.mjs';
import { respCommand } from '../../server/resp-client.mjs';
import { turnCli } from '../../server/turn-cli.mjs';

const { check, note, finish, metrics } = reporter('m13-turn-security');
const open = (proto = 'udp') => TurnClient.open({ host: CERT.lan, port: proto === 'tls' ? CERT.tlsPort : CERT.turnPort, proto, tlsInsecure: true });
const md5 = (s) => createHash('md5').update(s).digest('hex');

async function main() {
  const D = await newDb(), db = D.pool, A = authority(db);
  const mkShare = () => ({ meetingId: randomUUID(), shareId: randomUUID() });
  const issue = async (sh_, role = 'viewer') => { const c = await A.issue({ meetingId: sh_.meetingId, participantId: randomUUID(), shareId: sh_.shareId, role }); return { username: c.username, password: c.credential, realm: CERT.realm }; };
  const alloc = async (cred, proto = 'udp') => { const c = await open(proto); const r = await c.allocate(cred); return { c, r }; };
  const sessions = async (u) => (await A.sessionsOf(u)).length;
  /** a media pair on the relay: presenter A -> viewer B, both allocations on the share's credentials; returns helpers */
  async function pair(share) {
    const pc = await issue(share, 'presenter'), vc = await issue(share, 'viewer'); const a = await alloc(pc), b = await alloc(vc);
    if (!a.r.ok || !b.r.ok) throw new Error('pair allocation failed: ' + JSON.stringify([a.r.code, b.r.code]));
    for (const c of [a.c, b.c]) { const p = await c.createPermission(CERT.relayIp); if (!p.ok) throw new Error('permission failed ' + p.code); }
    const rx = []; b.c.onData = (d) => rx.push({ seq: d.data.readUInt32BE(0), at: d.at }); let seq = 0;
    const timer = setInterval(() => { const buf = Buffer.alloc(1000); buf.writeUInt32BE(seq++, 0); a.c.send(b.r.relayed.ip, b.r.relayed.port, buf); }, 10);       // ~100 packets/s, ~0.8 Mbit/s
    return { pc, vc, a, b, rx, stop: () => { clearInterval(timer); a.c.close(); b.c.close(); } };
  }
  const flowing = async (p, ms = 1500) => { const n0 = p.rx.length; await wait(ms); return p.rx.length - n0; };

  console.log('T0. a credential is REQUIRED, and failures reveal nothing');
  { const c = await open(); const r = await c.allocate({ username: 'nobody', password: 'x' }); check('an unknown user is refused (401), no anonymous allocation', !r.ok && r.code === 401, JSON.stringify(r.code)); c.close(); }
  { const sh_ = mkShare(), cr = await issue(sh_); const c = await open(); const r = await c.allocate({ username: cr.username, password: 'wrong' + cr.password }); check('a wrong password for a real user is refused with the SAME code (no user enumeration)', !r.ok && r.code === 401, JSON.stringify(r.code)); c.close(); await A.revokeShare(sh_.shareId, 't0'); }

  console.log('T1. a valid credential allocates on every transport; the SERVER relay address is returned');
  const s1 = mkShare(), c1 = await issue(s1);
  const u = await alloc(c1, 'udp'); check('UDP allocation with a valid credential', u.r.ok && !!u.r.relayed, u.r.relayed && u.r.relayed.ip + ':' + u.r.relayed.port);
  const t = await alloc(c1, 'tcp'); check('TCP transport (an alternative ICE candidate type) with the same credential: allocation works, so TCP is covered by revocation below', t.r.ok, JSON.stringify(t.r.code));
  const l = await alloc(c1, 'tls'); check('TLS transport with the same credential (TURNS)', l.r.ok, JSON.stringify(l.r.code));
  const live = await sessions(c1.username); check('coturn lists those allocations under the credential username (revocation can find them)', live >= 3, live + ' sessions');

  console.log('T2. REVOCATION: no new allocation, no reconnection, no refresh, on UDP, TCP and TLS, with a replayed nonce');
  const nonce = u.c.nonce; const rev = await A.revokeShare(s1.shareId, 'cert_revoke'); check('revoke returns with the credential terminated', rev.errors.length === 0 && rev.terminated >= 1, JSON.stringify({ keys: rev.keysDeleted, cancelled: rev.sessionsCancelled }));
  check('coturn lists NO allocation of the credential any more (all 3 transports)', (await sessions(c1.username)) === 0);
  for (const proto of ['udp', 'tcp', 'tls']) { const x = await alloc(c1, proto); check(`re-allocation with the revoked credential over ${proto.toUpperCase()}: refused (401)`, !x.r.ok && x.r.code === 401, JSON.stringify(x.r.code)); x.c.close(); }
  { const x = await open(); const r = await x.allocate({ ...c1, nonce }); check('REPLAYING the nonce of the old session with the revoked credential: refused', !r.ok, JSON.stringify(r.code)); x.close(); }
  { const r = await u.c.refresh(600); check('REFRESH of the cancelled allocation by the same client: refused (the allocation is gone)', !r.ok, JSON.stringify(r.code)); }
  { const r = await u.c.allocate(c1); check('the same client socket cannot simply allocate again (this is what an ICE restart does)', !r.ok, JSON.stringify(r.code)); }
  [u.c, t.c, l.c].forEach((c) => c.close());

  console.log('T3. PEER POLICY: an allocation can talk ONLY to another allocation of this relay (no direct path, no loopback/LAN/internet, no multicast)');
  const s3 = mkShare(), c3 = await issue(s3), a3 = await alloc(c3);
  for (const [ip, why] of [['127.0.0.1', 'loopback'], [CERT.lan, 'the host LAN address'], ['8.8.8.8', 'a public internet address'], ['169.254.169.254', 'the cloud metadata address'], ['192.168.1.1', 'a private range'], ['224.0.0.1', 'multicast'], [CERT.redisIp, 'the credential store itself']]) {
    const r = await a3.c.createPermission(ip); check(`permission for ${why} (${ip}) is refused (403)`, !r.ok && r.code === 403, JSON.stringify(r.code));
  }
  { const r = await a3.c.createPermission(CERT.relayIp); check('permission for the relay\'s OWN address (another allocation) is granted', r.ok, JSON.stringify(r.code)); }
  { const r = await a3.c.channelBind(0x4000, '8.8.8.8', 9); check('a channel to a public peer is refused too', !r.ok && r.code === 403, JSON.stringify(r.code)); }
  a3.c.close(); await A.revokeShare(s3.shareId, 't3');

  console.log('T3b. NO DIRECT PATH: a datagram sent straight to an allocation\'s relayed address by anything that is not a permitted peer is dropped');
  { const s = mkShare(), vc = await issue(s), v = await alloc(vc); await v.c.createPermission(CERT.relayIp); let got = 0; v.c.onData = () => { got++; };
    // from INSIDE the relay's network (so the relayed address is reachable) a plain UDP sender that is not an allocation of the relay: coturn has no permission for its address
    let out = ''; try { out = sh('docker', ['run', '--rm', '--network', 'qm13-net', 'alpine:3', 'sh', '-c', `for i in 1 2 3 4 5 6 7 8 9 10; do echo probe | nc -u -w1 ${v.r.relayed.ip} ${v.r.relayed.port}; done; echo sent`]); } catch (e) { out = 'docker failed: ' + e.message.slice(0, 80); }
    await wait(800); check('10 datagrams sent DIRECTLY to the viewer\'s relayed address from a non-permitted source: none reaches the viewer (the only way in is another allocation, which is revocable)', /sent/.test(out) && got === 0, out.replace(/\n/g, ' ').slice(0, 60) + ' received=' + got);
    v.c.close(); await A.revokeShare(s.shareId, 't3b'); }

  console.log('T4. relay-to-relay media flows, then stops at revocation; a second share is untouched (isolation)');
  const sa = mkShare(), sb = mkShare(), pa = await pair(sa), pb = await pair(sb);
  check('share A delivers media through the relay', (await flowing(pa)) > 40); check('share B delivers media through the relay', (await flowing(pb)) > 40);
  await A.revokeShare(sa.shareId, 't4'); await wait(300);
  check('share A: NO media after its revocation', (await flowing(pa, 2000)) === 0);
  check('share B (another share, same relay): unaffected by A\'s revocation', (await flowing(pb)) > 40);
  const sRev = await A.revokeShare(sb.shareId, 't4b'); pa.stop(); pb.stop(); check('share B revoked on its own', sRev.errors.length === 0);

  console.log('T5. QUOTAS and the bandwidth cap');
  const s5 = mkShare(), c5 = await issue(s5); const held = []; let q = null;
  for (let i = 0; i < 26; i++) { const x = await alloc(c5); if (x.r.ok) held.push(x.c); else { q = x.r.code; x.c.close(); break; } }
  check('per-credential allocation quota (24 = the largest audience of one share: the presenter one credential carries every viewer connection): the 25th allocation is refused (486)', held.length === 24 && q === 486, held.length + ' held, then ' + q); held.forEach((c) => c.close()); await A.revokeShare(s5.shareId, 't5');
  { const s = mkShare(), p = await pair(s); p.stop(); const a = await alloc(await issue(s)), b = await alloc(await issue(s)); await a.c.createPermission(CERT.relayIp); await b.c.createPermission(CERT.relayIp); let bytes = 0; b.c.onData = (d) => { bytes += d.data.length; };
    const big = Buffer.alloc(1100), t0 = Date.now(); const flood = setInterval(() => { for (let i = 0; i < 40; i++) a.c.send(b.r.relayed.ip, b.r.relayed.port, big); }, 10);          // offered ~ 4.4 MB/s
    await wait(3000); clearInterval(flood); const rate = bytes / ((Date.now() - t0) / 1000); metrics.floodReceivedBytesPerSec = Math.round(rate);
    check('the per-allocation cap (1.25 MB/s) limits a flooding client: delivered rate is far below the offered ~4.4 MB/s', rate < 2_000_000, Math.round(rate / 1000) + ' kB/s delivered'); a.c.close(); b.c.close(); await A.revokeShare(s.shareId, 't5b'); }

  console.log('T6. the credential store, the control channel and the registry are protected');
  { let e = null; try { await respCommand(['PING'], { host: CERT.redis.host, port: CERT.redis.port, timeoutMs: 2000 }); } catch (x) { e = x.message; } check('Redis (the credential store) refuses an unauthenticated client', !!e && /NOAUTH|Authentication/i.test(e), e); }
  { let e = null; try { await respCommand(['PING'], { ...CERT.redis, password: 'wrong', timeoutMs: 2000 }); } catch (x) { e = x.message; } check('Redis refuses a wrong password', !!e && /WRONGPASS|invalid/i.test(e), e); }
  { let e = null; try { await turnCli([], { ...CERT.cli, password: 'wrong', timeoutMs: 3000 }); } catch (x) { e = x.message; } check('the coturn admin CLI refuses a wrong password', e === 'turn_cli_auth_failed', e); }
  { const bind = (c) => sh('docker', ['port', c]); const rd = bind('qm13-redis'), tn = bind('qm13-turn');
    check('Redis and the admin CLI are published on 127.0.0.1 only (never on the LAN)', /6379\/tcp -> 127\.0\.0\.1:36391/.test(rd) && /5766\/tcp -> 127\.0\.0\.1:35791/.test(tn) && !/5766[^\n]*(0\.0\.0\.0|10\.)/.test(tn), (rd + ' | ' + tn).replace(/\n/g, ' ')); }
  { const row = (await db.query('SELECT * FROM relay_credentials LIMIT 1')).rows[0]; check('the registry stores no secret (no password column or value)', row && !Object.keys(row).some((k) => /pass|secret|credential$/i.test(k)) && !Object.values(row).some((v) => typeof v === 'string' && v.length > 40), Object.keys(row).join(',')); }
  { const cr = await issue(mkShare()); check('credentials are random and unique (192-bit username, 144-bit password)', cr.username.length >= 16 && cr.password.length >= 24 && cr.username !== (await issue(mkShare())).username); }

  console.log('T7. RESURRECTION: a revoked key that comes back (restored backup / mistaken write) is removed by the reconciler');
  { const s = mkShare(), cr = await issue(s); await A.revokeShare(s.shareId, 't7'); await respCommand(['SET', A.keyOf(cr.username), md5(`${cr.username}:${CERT.realm}:${cr.password}`), 'EX', '120'], CERT.redis);
    const back = await alloc(cr); check('(the danger, shown) a restored key makes the revoked credential WORK again', back.r.ok, JSON.stringify(back.r.code)); back.c.close();
    const rc = await A.reconcile(); check('reconcile() finds and deletes the resurrected key (and cancels its allocations)', rc.resurrected >= 1 && (await respCommand(['EXISTS', A.keyOf(cr.username)], CERT.redis)) === 0, JSON.stringify({ resurrected: rc.resurrected }));
    const again = await alloc(cr); check('after the reconcile the credential is dead again (401)', !again.r.ok && again.r.code === 401, JSON.stringify(again.r.code)); again.c.close(); }

  console.log('T8. EXPIRY: a credential stops working at its TTL; a running allocation is ended by the reconciler');
  { const A30 = authority(db, { ttlSeconds: 30 }), s = mkShare(); const pc = await A30.issue({ meetingId: s.meetingId, participantId: randomUUID(), shareId: s.shareId, role: 'viewer' }), cr = { username: pc.username, password: pc.credential, realm: CERT.realm };
    const a = await alloc(cr); check('a fresh 30 s credential allocates', a.r.ok); await wait(32_000);
    const late = await alloc(cr); check('after its TTL the credential is refused (401): a stolen or leaked credential has a hard end', !late.r.ok && late.r.code === 401, JSON.stringify(late.r.code)); late.c.close();
    const still = await A30.sessionsOf(cr.username); note('the allocation made BEFORE expiry still exists after the TTL: ' + still.length + ' (measured: an allocation outlives its credential)');
    const r = await A30.reconcile(); check('reconcile() revokes the expired credential and terminates its allocation', (await A30.sessionsOf(cr.username)).length === 0 && r.expiredNow >= 1, JSON.stringify({ expired: r.expiredNow })); a.c.close(); }

  console.log('T9. FAILURE: the credential store down, the control channel down, coturn restarted, Redis restarted');
  { const s = mkShare(), p = await pair(s); check('a share is flowing before the fault', (await flowing(p)) > 40);
    sh('docker', ['pause', 'qm13-redis']); const t0 = Date.now(); let refused = false; try { await A.issue({ meetingId: randomUUID(), participantId: randomUUID(), shareId: randomUUID(), role: 'viewer' }); } catch (e) { refused = e.code === 'relay_unavailable'; }
    check('credential store DOWN: a new credential is refused (fail closed) within 3 s', refused && Date.now() - t0 < 3500, (Date.now() - t0) + ' ms');
    const rv = await A.revokeShare(s.shareId, 't9-redis-down'); const row = (await db.query('SELECT revoked_at IS NOT NULL r, terminated_at IS NOT NULL t FROM relay_credentials WHERE share_id=$1', [s.shareId])).rows;
    check('revocation while the store is down: recorded durably but NOT yet terminated (pending, visible to monitoring)', row.every((x) => x.r && !x.t) && rv.errors.length > 0, rv.errors.join(';').slice(0, 80));
    const st = await A.stats().catch(() => null); check('stats() reports the unenforced revocation (the alert condition)', st && st.pending >= 2 && st.oldest_pending_seconds >= 0, st && JSON.stringify({ pending: st.pending, healthy: st.healthy }));
    sh('docker', ['unpause', 'qm13-redis']); const rc = await until(async () => { const r = await A.reconcile(); return r.errors.length === 0 ? r : null; }, 15000, 500);
    check('store back: the reconciler finishes the termination (rows terminated, key gone, no allocation)', !!rc && (await A.sessionsOf(p.pc.username)).length === 0 && (await respCommand(['EXISTS', A.keyOf(p.pc.username)], CERT.redis)) === 0);
    check('and media has stopped', (await flowing(p, 2000)) === 0); p.stop(); }
  { const A2 = authority(db, { }); const bad = authority(db); const badCli = { ...CERT.cli, port: 35999 };            // control channel unreachable while coturn itself is up
    const Abad = (await import('../../server/relay-authority.mjs')).createRelayAuthority({ db, redis: CERT.redis, cli: badCli, realm: CERT.realm, ttlSeconds: 300 });
    const s = mkShare(), p = await pair(s); check('(CLI fault) a share is flowing', (await flowing(p)) > 40);
    let refused = false; try { await Abad.issue({ meetingId: randomUUID(), participantId: randomUUID(), shareId: randomUUID(), role: 'viewer' }); } catch (e) { refused = e.code === 'relay_unavailable'; } check('control channel DOWN: new credentials are refused (fail closed)', refused);
    const rv = await Abad.revokeShare(s.shareId, 't9-cli-down'); const n = await flowing(p, 2000);
    note('EXPOSURE WINDOW: with the coturn CLI unreachable, a revoked share\'s EXISTING allocation keeps forwarding: ' + n + ' packets in 2 s (the key was deleted, so it cannot re-allocate)');
    check('the revocation is pending (not falsely marked terminated) and nothing can allocate afresh', rv.errors.length > 0 && (await alloc(p.vc)).r.code === 401);
    metrics.cliOutageExposurePacketsPer2s = n;
    const rc = await A2.reconcile(); check('control channel back: the reconciler terminates it and media stops', rc.errors.length === 0 && (await flowing(p, 2000)) === 0); p.stop(); }
  { const s = mkShare(), valid = await issue(s), dead = mkShare(), dcred = await issue(dead); await A.revokeShare(dead.shareId, 't9'); sh('docker', ['restart', 'qm13-turn']); await until(async () => (await A.health()).ok, 30000, 500); await wait(2500);
    const v = await alloc(valid), d = await alloc(dcred); check('coturn RESTARTED: a still-valid credential re-allocates (availability)', v.r.ok, JSON.stringify(v.r.code)); check('coturn RESTARTED: a revoked credential stays refused (revocation survives, it lives in the store)', !d.r.ok && d.r.code === 401, JSON.stringify(d.r.code)); v.c.close(); d.c.close(); await A.revokeShare(s.shareId, 't9'); }
  { const dead = mkShare(), dcred = await issue(dead); await A.revokeShare(dead.shareId, 't9r'); sh('docker', ['restart', 'qm13-redis']); await until(async () => (await A.health()).ok, 30000, 500); await wait(3000);
    const d = await alloc(dcred); check('Redis RESTARTED (no persistence): a revoked credential cannot come back (401)', !d.r.ok && d.r.code === 401, JSON.stringify(d.r.code)); d.c.close();
    const s = mkShare(), cr = await issue(s); sh('docker', ['restart', 'qm13-redis']); await until(async () => (await A.health()).ok, 30000, 500); await wait(3000); const v = await alloc(cr);
    note('Redis restart without persistence: an unrevoked credential is LOST (' + (v.r.ok ? 'still works' : 'refused ' + v.r.code) + '): availability loss, never a security loss; the page asks for fresh credentials'); v.c.close(); await A.revokeShare(s.shareId, 't9r2'); }

  console.log('T10. ENFORCEMENT BOUND: time from "revoke" to the last packet delivered (repeated, one share each)');
  const N = Number(process.env.BOUND_RUNS || 20), lastAfter = [], revoke = [];
  for (let i = 0; i < N; i++) { const s = mkShare(), p = await pair(s); await until(async () => p.rx.length > 30, 8000, 50); const t0 = Date.now(); const r = await A.revokeShare(s.shareId, 'bound'); const tRet = Date.now(); await wait(1500);
    const last = p.rx.length ? p.rx[p.rx.length - 1].at : t0; lastAfter.push(Math.max(0, last - t0)); revoke.push(tRet - t0); p.stop(); if (r.errors.length) note('run ' + i + ' errors ' + r.errors.join(';')); }
  metrics.bound = { runs: N, revokeCallMs: { p50: pctl(revoke, 50), p95: pctl(revoke, 95), max: Math.max(...revoke) }, lastDeliveredAfterRevokeMs: { p50: pctl(lastAfter, 50), p95: pctl(lastAfter, 95), max: Math.max(...lastAfter) } };
  check(`NO media is delivered later than 5 s after the revoke call began (documented bound; ${N} runs)`, Math.max(...lastAfter) <= 5000, JSON.stringify(metrics.bound.lastDeliveredAfterRevokeMs));
  check('the revoke call itself returns within 8 s in every run (documented API bound)', Math.max(...revoke) <= 8000, JSON.stringify(metrics.bound.revokeCallMs));
  console.log('T11. CRASH BEFORE TERMINATION: the revocation was recorded but the process died; the sweeper alone ends the media');
  { const s = mkShare(), p = await pair(s); await wait(500); await db.query("UPDATE relay_credentials SET revoked_at = now(), revoke_reason = 'crash_sim' WHERE share_id = $1", [s.shareId]);
    const before = await flowing(p, 1000); check('(simulated crash) the recorded revocation alone has NOT stopped the media yet: this is the window the sweeper closes', before > 25, before + ' packets/s'); const t0 = Date.now(); const r = await A.reconcile(); const ms = Date.now() - t0;
    check('one reconcile pass (what a new process runs on boot, and every sweep does) stops it', r.errors.length === 0 && (await flowing(p, 1500)) === 0, ms + ' ms'); metrics.reconcileMs = ms; p.stop(); }

  await D.drop(); finish();
}
main().catch((e) => { console.error('SUITE ERROR', e); process.exit(3); });
