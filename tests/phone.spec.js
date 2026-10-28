const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');

// Qorlla Phone: meeting dial-in. These tests drive the REAL Meet server and PostgreSQL with SIGNED REQUESTS that stand in for a telephone carrier
// (PHONE_PROVIDER=test, a test double). They prove the rules (PINs, signatures, replay, attempt limits, waiting room, host controls, consent, attendance, hang-up).
// They do NOT prove real inbound calls, real numbers or audio: there is no carrier and no PSTN-to-WebRTC media gateway in this repository (BLOCKED).
// Needs Meet on :3310 started with scripts/start-recording-test-meet.cjs (it enables the test provider).
const { startMain, organiser } = require('./support/meet-stack');
const MEET = 'http://localhost:3310', SECRET = 'phone-test-secret-123456';
const sign = (raw, t = Math.floor(Date.now() / 1000)) => 't=' + t + ',v1=' + crypto.createHmac('sha256', SECRET).update(t + '.' + raw).digest('hex');
const RUN = '-' + crypto.randomBytes(4).toString('hex');                       // call ids are unique per run (the table remembers every call)
let seq = 0; const eid = () => 'evt-' + Date.now() + '-' + (++seq) + '-' + crypto.randomBytes(3).toString('hex');
async function ivr(p, obj, o = {}) { const raw = JSON.stringify(obj); const r = await fetch(MEET + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-qorlla-signature': o.sig || sign(raw, o.t) }, body: o.rawOverride || raw }); return { status: r.status, body: await r.json().catch(() => ({})) }; }
const FROM1 = '+15551234567', FROM2 = '+15557654321', FROM3 = '+442071234568';
const GENERIC = 'We could not connect you to that meeting. Check the meeting ID and PIN and try again.';
const NUMBERS = JSON.stringify([{ country: 'United States', label: 'New York', number: '+12125550100', tollFree: false }, { country: 'United States', label: 'Toll-free', number: '+18005550100', tollFree: true }, { country: 'Nowhere', number: '555' }, { country: '', number: '+442071234567' }]);

test.describe('rules (no server)', () => {
  test('PINs are 8 random digits stored as verifiers; the test provider signs and verifies, rejects tampering, old and future timestamps; other providers and weak secrets are refused', async () => {
    const m = await import('../qorlla-meet-video/server/phone.mjs');
    const pins = new Set(Array.from({ length: 40 }, () => m.makePin())); expect(pins.size).toBeGreaterThan(35); for (const p of pins) expect(p).toMatch(/^\d{8}$/);
    const h = m.hashPin('12345678'); expect(h).not.toContain('12345678'); expect(m.verifyPin('12345678', h)).toBe(true); expect(m.verifyPin('12345679', h)).toBe(false); expect(m.verifyPin('1', 'garbage')).toBe(false); expect(m.hashPin('12345678')).not.toBe(h);   // salted
    const p = m.createProvider({ PHONE_PROVIDER: 'test', PHONE_WEBHOOK_SECRET: 'x'.repeat(20) }); expect(p.ready).toBe(true); expect(p.name).toBe('test-double');
    const raw = '{"a":1}', s = p.sign(raw); expect(p.verify(s, raw)).toBe(true); expect(p.verify(s, '{"a":2}')).toBe(false); expect(p.verify(p.sign(raw, Math.floor(Date.now() / 1000) - 3600), raw)).toBe(false); expect(p.verify(p.sign(raw, Math.floor(Date.now() / 1000) + 3600), raw)).toBe(false); expect(p.verify('t=1,v1=zz', raw)).toBe(false); expect(p.verify(undefined, raw)).toBe(false);
    expect(m.createProvider({}).ready).toBe(false); expect(m.createProvider({ PHONE_PROVIDER: 'twilio' }).reason).toContain('not implemented'); expect(m.createProvider({ PHONE_PROVIDER: 'test', PHONE_WEBHOOK_SECRET: 'short' }).ready).toBe(false);
  });
});

test.describe('dial-in against the real Meet server', () => {
  test.describe.configure({ mode: 'serial' });
  let main; test.beforeAll(async () => { main = await startMain(5297, { PHONE_DIAL_IN_NUMBERS: NUMBERS, PHONE_PROVIDER: 'test' }); }); test.afterAll(() => main && main.stop());
  const B = () => main.base;
  // a started meeting: { ctx, item, digits, uuid, token (host), pin }; joinBeforeHost and waitingRoom as asked
  async function meeting(browser, { waitingRoom = false, joinBeforeHost = true, title = 'Phone meeting' } = {}) {
    const ctx = await browser.newContext(); const { item } = await organiser(ctx, B(), { name: 'Hostess', title });
    const st = await ctx.request.post(B() + '/api/meetings/' + encodeURIComponent(item.meetingId) + '/start', { data: { waitingRoom, joinBeforeHost, name: 'Hostess' } }); expect(st.status()).toBe(200);
    const startUrl = (await st.json()).url; const q = JSON.parse(Buffer.from(new URL(startUrl).hash.replace('#qs=', ''), 'base64url').toString());
    const pinRes = await ctx.request.post(B() + '/api/meetings/' + encodeURIComponent(item.meetingId) + '/phone-access', { data: {} }); expect(pinRes.status()).toBe(201);
    const pin = (await pinRes.json()).pin; const host = (p, method = 'GET', body) => fetch(MEET + '/api/meetings/' + q.meetingId + p, { method, headers: { Authorization: 'Bearer ' + q.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    return { ctx, item, startUrl, digits: item.meetingId.replace(/\D/g, ''), uuid: q.meetingId, token: q.token, pin, host };
  }
  const dial = (m, from, o = {}) => ivr('/api/phone/ivr/verify', { eventId: eid(), callId: o.callId || 'call-' + crypto.randomBytes(5).toString('hex'), from, meetingId: o.meetingId || m.digits, pin: o.pin || m.pin });
  const attendance = async (m) => (await (await m.ctx.request.get(B() + '/api/meetings/' + encodeURIComponent(m.item.meetingId) + '/phone-attendance')).json()).calls;

  test('MAIN API: dial-in numbers are only the real configured ones; the PIN is shown once; only the host; carrier calling and provisioning answer 503', async ({ browser }) => {
    test.setTimeout(60000);
    const m = await meeting(browser); const api = (p, o) => m.ctx.request.fetch(B() + p, o);
    const dn = await (await api('/api/phone/dial-in-numbers')).json(); expect(dn.configured).toBe(true); expect(dn.numbers.map((n) => n.number)).toEqual(['+12125550100', '+18005550100']); expect(dn.numbers[1].tollFree).toBe(true); expect(dn.carrierCalling).toBe(false);   // junk entries dropped, nothing invented
    expect((await (await browser.newContext()).request.get(B() + '/api/phone/dial-in-numbers')).status()).toBe(401);
    expect((await api('/api/phone/calls', { method: 'POST', data: { to: '+15551230000' } })).status()).toBe(503); expect((await api('/api/phone/numbers/provision', { method: 'POST', data: {} })).status()).toBe(503);
    const pa = await (await api('/api/meetings/' + encodeURIComponent(m.item.meetingId) + '/phone-access', { method: 'POST', data: {} })).json(); expect(pa.pin).toMatch(/^\d{8}$/); expect(pa.pin).not.toBe(m.pin); expect(pa.shownOnce).toBe(true); expect(pa.telephony.enabled).toBe(true); expect(pa.telephony.provider).toBe('test-double');
    expect(pa.invitation).toContain('+12125550100'); expect(pa.invitation).toContain('Meeting ID: ' + m.digits + '#'); expect(pa.invitation).toContain('PIN: ' + pa.pin + '#'); expect(pa.invitation).toContain('audio only');
    const other = await browser.newContext(); await other.request.post(B() + '/api/auth/register', { data: { username: 'oth' + Math.random().toString(36).slice(2, 7), displayName: 'Other', password: 'Handoff-pass-9917!x' } });
    expect((await other.request.post(B() + '/api/meetings/' + encodeURIComponent(m.item.meetingId) + '/phone-access', { data: {} })).status()).toBe(403); expect((await other.request.delete(B() + '/api/meetings/' + encodeURIComponent(m.item.meetingId) + '/phone-access')).status()).toBe(403);
    expect((await (await browser.newContext()).request.post(B() + '/api/meetings/' + encodeURIComponent(m.item.meetingId) + '/phone-access', { data: {} })).status()).toBe(401);
    await m.ctx.close(); await other.close();
  });

  test('signed requests only: bad, tampered, stale and unsigned requests are refused; a repeated event is answered once and has no second effect', async ({ browser }) => {
    test.setTimeout(60000);
    const m = await meeting(browser); const body = { eventId: eid(), callId: ('call-sig-1' + RUN), from: FROM1, meetingId: m.digits, pin: m.pin }; const raw = JSON.stringify(body);
    expect((await ivr('/api/phone/ivr/verify', body, { sig: 't=1,v1=' + '0'.repeat(64) })).status).toBe(401); expect((await ivr('/api/phone/ivr/verify', body, { sig: sign(raw).replace(/.$/, (c) => (c === '0' ? '1' : '0')) })).status).toBe(401);
    expect((await ivr('/api/phone/ivr/verify', { ...body, pin: '00000000' }, { sig: sign(raw) })).status).toBe(401);                       // body changed after signing
    expect((await ivr('/api/phone/ivr/verify', body, { t: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);                      // stale
    expect((await fetch(MEET + '/api/phone/ivr/verify', { method: 'POST', body: raw })).status).toBe(401);
    expect((await ivr('/api/phone/ivr/verify', { callId: 'x', from: FROM1, meetingId: m.digits, pin: m.pin })).status).toBe(400);           // no event id
    const first = await ivr('/api/phone/ivr/verify', body); expect(first.body.result).toBe('connected'); const again = await ivr('/api/phone/ivr/verify', body); expect(again.body).toMatchObject({ result: 'connected', duplicate: true, callRef: first.body.callRef });
    expect((await attendance(m)).length).toBe(1);                                                                                           // the replay changed nothing
    const reuse = await dial(m, FROM1, { callId: ('call-sig-1' + RUN) }); expect(reuse.body.result).toBe('denied');                                 // same call id, new event id
    const people = await m.host('/'); expect(people.body.online).toContain; await m.ctx.close();
  });

  test('wrong PIN, wrong meeting, ended meeting and a stranger meeting PIN all get the SAME generic answer; locking, bans and the 5-try limit; lock expires', async ({ browser }) => {
    test.setTimeout(90000);
    const m = await meeting(browser, { title: 'Meeting A' }), n = await meeting(browser, { title: 'Meeting B' });
    const wrongPin = await dial(m, FROM1, { pin: '00000000' }), wrongId = await dial(m, FROM1, { meetingId: '12345678901' }), crossPin = await dial(m, FROM1, { pin: n.pin }), junk = await dial(m, FROM1, { pin: 'abcd' });
    for (const r of [wrongPin, wrongId, crossPin, junk]) { expect(r.status).toBe(200); expect(r.body).toEqual({ result: 'denied', say: GENERIC }); }   // nothing reveals which part was wrong
    // the fifth failure from one caller locks THAT caller (even with the right PIN, in the same words); another caller is unaffected
    await dial(m, FROM1, { pin: '11111111' }); const locked = await dial(m, FROM1); expect(locked.body).toEqual({ result: 'locked', say: GENERIC }); const ok = await dial(m, FROM2); expect(ok.body.result).toBe('connected');
    await new Promise((r) => setTimeout(r, 4600)); const later = await dial(m, FROM1); expect(later.body.result).toBe('connected');      // the lock ran out (PHONE_LOCK_MS=4000 on the test Meet)
    // locked meeting
    expect((await m.host('/lock', 'POST', { locked: true })).status).toBe(200); expect((await dial(m, FROM3)).body).toEqual({ result: 'denied', say: GENERIC }); await m.host('/lock', 'POST', { locked: false }); expect((await dial(m, FROM3)).body.result).toBe('connected');
    // ended meeting
    await n.host('/end', 'POST'); expect((await dial(n, FROM2)).body).toEqual({ result: 'denied', say: GENERIC });
    await m.ctx.close(); await n.ctx.close();
  });

  test('a caller joins the SAME meeting as an audio-only participant: masked name, roster, attendance and history; the number is never stored or returned in clear', async ({ browser }) => {
    test.setTimeout(90000);
    const m = await meeting(browser); const r = await dial(m, FROM1, { callId: ('call-join-1' + RUN) }); expect(r.body).toMatchObject({ result: 'connected', say: 'You are connected to the meeting.' }); expect(r.body.recordingNotice).toBeUndefined();
    const calls = await attendance(m); expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ name: 'Phone ••••4567', status: 'connected', provider: 'test-double' });
    const info = await m.host('/'); expect(info.body.online.length).toBe(1);                                                            // counted in the room
    await ivr('/api/phone/webhooks/provider', { eventId: eid(), callId: ('call-join-1' + RUN), type: 'caller_hung_up' });
    const done = (await attendance(m))[0]; expect(done.status).toBe('ended'); expect(done.seconds).toBeGreaterThanOrEqual(0); expect((await ivr('/api/phone/ivr/disconnect', { eventId: eid(), callId: ('call-join-1' + RUN) })).body.result).toBe('ended');   // idempotent
    // the same meeting's other reports: Meet activity names the phone caller; History (after the host ends) counts and flags them
    await m.host('/end', 'POST'); await expect.poll(async () => (await (await m.ctx.request.get(B() + '/api/history/meetings')).json()).meetings.length, { timeout: 30000, intervals: [1000] }).toBe(1);
    const det = await (await m.ctx.request.get(B() + '/api/history/meetings/' + encodeURIComponent(m.item.meetingId))).json(); const ph = det.attendees.find((a) => a.phone); expect(ph.name).toBe('Phone ••••4567'); expect(det.uniqueAttendeeCount).toBeGreaterThanOrEqual(1);
    const everything = JSON.stringify([r.body, calls, done, det]); expect(everything).not.toContain('5551234567'); expect(everything).not.toContain(FROM1);
    const { Client } = require('../qorlla-meet-video/node_modules/pg'); const s = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '.dev-stack', 'secrets.json'), 'utf8'));
    const c = new Client({ connectionString: 'postgres://qorlla:' + s.dbPassword + '@127.0.0.1:35432/qorlla_meet' }); await c.connect(); const rows = (await c.query('select * from phone_calls where provider_call_id=$1', [('call-join-1' + RUN)])).rows[0]; await c.end();
    expect(JSON.stringify(rows)).not.toContain('5551234567'); expect(rows.caller_hash).toMatch(/^[0-9a-f]{64}$/); expect(rows.caller_last4).toBe('4567');
    await m.ctx.close();
  });

  test('waiting room: callers are held and appear in the host waiting list; admit connects, deny hangs up; "host absent" holds until the host connects', async ({ browser }) => {
    test.setTimeout(90000);
    const m = await meeting(browser, { waitingRoom: true });
    const r1 = await dial(m, FROM1, { callId: ('w-1' + RUN) }), r2 = await dial(m, FROM2, { callId: ('w-2' + RUN) }); expect(r1.body.result).toBe('waiting'); expect(r1.body.say).toContain('hold'); expect(r2.body.result).toBe('waiting');
    const wl = (await m.host('/waiting')).body.waiting; expect(wl.map((x) => x.name).sort()).toEqual(['Phone ••••4321', 'Phone ••••4567']); expect((await m.host('/')).body.online.length).toBe(0);      // not in the room yet
    const first = wl.find((x) => x.name.endsWith('4567')), second = wl.find((x) => x.name.endsWith('4321'));
    expect((await m.host('/admit', 'POST', { participantId: first.participantId, allow: true })).status).toBe(200); expect((await m.host('/admit', 'POST', { participantId: second.participantId, allow: false })).status).toBe(200);
    const calls = await attendance(m); expect(calls.find((c) => c.name.endsWith('4567')).status).toBe('connected'); expect(calls.find((c) => c.name.endsWith('4321')).status).toBe('denied'); expect((await m.host('/')).body.online.length).toBe(1);
    await m.ctx.close();
    const h = await meeting(browser, { joinBeforeHost: false, title: 'Host absent' }); const w = await dial(h, FROM3, { callId: ('ha-1' + RUN) }); expect(w.body.result).toBe('waiting');
    const hp = await h.ctx.newPage(); await hp.goto(h.startUrl); await expect(hp.locator('#app')).not.toHaveClass(/hidden/, { timeout: 30000 });   // the host connects: callers that waited for the host are let in
    await expect.poll(async () => (await attendance(h))[0].status, { timeout: 20000, intervals: [1000] }).toBe('connected');
    await h.ctx.close();
  });

  test('host controls: mute is recorded and announced (not bridged), remove ends the call and bans the number from this meeting, revoking the PIN hangs up everyone and rotation invalidates the old PIN', async ({ browser }) => {
    test.setTimeout(90000);
    const m = await meeting(browser); const a = (await dial(m, FROM1, { callId: ('hc-1' + RUN) })).body, b = (await dial(m, FROM2, { callId: ('hc-2' + RUN) })).body;
    const mu = await m.host('/phone/' + a.callRef + '/mute', 'POST', { muted: true }); expect(mu.status).toBe(200); expect(mu.body).toMatchObject({ muted: true, bridged: false }); expect(mu.body.note).toContain('gateway'); expect((await attendance(m)).find((c) => c.name.endsWith('4567')).muted).toBe(true);
    const rm = await m.host('/phone/' + a.callRef + '/remove', 'POST'); expect(rm.status).toBe(200); expect((await attendance(m)).find((c) => c.name.endsWith('4567')).status).toBe('removed'); expect((await dial(m, FROM1)).body).toEqual({ result: 'denied', say: GENERIC });   // cannot dial back in
    expect((await m.host('/phone/' + a.callRef + '/remove', 'POST')).status).toBe(404); expect((await m.host('/phone/00000000-0000-4000-8000-000000000000/mute', 'POST', {})).status).toBe(404);
    const rot = await (await m.ctx.request.post(B() + '/api/meetings/' + encodeURIComponent(m.item.meetingId) + '/phone-access', { data: {} })).json(); expect((await dial(m, FROM3, { pin: m.pin })).body.result).toBe('denied'); expect((await dial(m, FROM3, { pin: rot.pin })).body.result).toBe('connected');   // the old PIN is dead
    const rv = await m.ctx.request.delete(B() + '/api/meetings/' + encodeURIComponent(m.item.meetingId) + '/phone-access'); expect((await rv.json()).revoked).toBe(true);
    const after = await attendance(m); expect(after.filter((c) => ['waiting', 'connected'].includes(c.status))).toHaveLength(0); expect(after.find((c) => c.name.endsWith('4321')).endReason).toBe('pin_revoked');
    expect((await dial(m, '+15550001111', { pin: rot.pin })).body.result).toBe('denied');
    const nonHost = await fetch(MEET + '/api/meetings/' + m.uuid + '/phone/' + b.callRef + '/mute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); expect(nonHost.status).toBe(401);
    await m.ctx.close();
  });

  test('ending the meeting hangs up every caller; a recording request is answered on the keypad (agree / decline) through the same consent records', async ({ browser }) => {
    test.setTimeout(90000);
    const m = await meeting(browser); const a = (await dial(m, FROM1, { callId: ('rc-1' + RUN) })).body, c2 = (await dial(m, FROM2, { callId: ('rc-2' + RUN) })).body;
    // recording: the host asks; callers are counted and must answer; the keypad is their consent screen
    const rq = await m.host('/recording/request', 'POST', { purpose: 'Minutes', recipients: 'Team', retentionDays: 30, privacyContact: 'p@example.com', video: false, audio: true }); expect(rq.status).toBe(201);
    expect((await m.host('/recording')).body).toMatchObject({ status: 'awaiting', pending: 2 });
    const late = await dial(m, FROM3, { callId: ('rc-3' + RUN) }); expect(late.body).toMatchObject({ result: 'connected', recordingNotice: true }); expect(late.body.consentPrompt).toContain('Press 1');   // told about the recording as they join
    expect((await ivr('/api/phone/ivr/consent', { eventId: eid(), callId: ('rc-1' + RUN), digit: 1 })).body.result).toBe('agree'); expect((await ivr('/api/phone/ivr/consent', { eventId: eid(), callId: ('rc-2' + RUN), digit: 7 })).body.result).toBe('retry');
    expect((await ivr('/api/phone/ivr/consent', { eventId: eid(), callId: ('rc-2' + RUN), digit: 1 })).body.result).toBe('agree'); expect((await m.host('/recording')).body).toMatchObject({ status: 'awaiting', pending: 1 });
    expect((await ivr('/api/phone/ivr/consent', { eventId: eid(), callId: ('rc-3' + RUN), digit: 2 })).body.result).toBe('decline'); expect((await m.host('/recording')).body.status).toBe('blocked');   // one decline blocks recording, same as on the web
    const audit = (await m.host('/recordings-audit')).body.events.map((e) => e.action + ':' + (e.detail && e.detail.by)); expect(audit).toContain('consent.agree:keypad'); expect(audit).toContain('consent.decline:keypad');
    expect((await ivr('/api/phone/ivr/consent', { eventId: eid(), callId: 'nope', digit: 1 })).body).toMatchObject({ result: 'denied' });
    await m.host('/end', 'POST'); const calls = await attendance(m); expect(calls.every((c) => c.status === 'ended' && c.endReason === 'meeting_ended')).toBe(true); expect(calls).toHaveLength(3);
    expect(a.callRef && c2.callRef).toBeTruthy(); await m.ctx.close();
  });

  test('Phone page: dial pad (keys, keyboard, delete, copy), carrier calling is honestly off, dial-in directory and phone PIN for a meeting, recent calls, settings that say what is not connected', async ({ browser }) => {
    test.setTimeout(120000);
    const m = await meeting(browser, { title: 'Dial me' }); await dial(m, FROM1, { callId: ('ui-1' + RUN) });
    const page = await m.ctx.newPage(); await page.context().grantPermissions(['clipboard-read', 'clipboard-write']); await page.goto(B() + '/qorlla.html#home'); await page.locator('.nav-item[data-view=phone]').click();
    await expect(page.locator('[role=tab][aria-selected=true]')).toHaveText('Dial Pad'); await expect(page.locator('.qp-grid .qp-card')).toHaveCount(4);   // three columns: dial pad, join by phone, and the number + recent calls on the right
    const num = page.locator('#qpDialNumber'); await page.locator('.ph-key[data-key="4"]').click(); await page.locator('.ph-key[data-key="5"]').click(); await expect(num).toHaveValue('45'); await page.getByRole('button', { name: 'Delete last digit' }).click(); await expect(num).toHaveValue('4');
    await page.locator('.ph-key[data-key="7"]').focus(); await page.keyboard.press('8'); await expect(num).toHaveValue('48'); await expect(page.locator('#qpDialHint')).toContainText('valid phone number');
    await page.getByRole('button', { name: 'Copy number', exact: true }).click(); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('48');
    await num.fill('(202) 555-0123'); await expect(page.locator('#qpDialHint')).toContainText('Will call +12025550123'); await page.locator('#qpDialCountry').selectOption('GB'); await expect(page.locator('#qpDialHint')).toContainText('Will call +442025550123');
    await expect(page.locator('#phCall')).toBeDisabled(); await expect(page.locator('#phCallNote')).toContainText('requires a connected telephony provider'); await expect(page.locator('#qpCallerId')).toBeDisabled();
    const dir = page.locator('.qp-dir'); await expect(dir).toContainText('+12125550100'); await expect(dir).toContainText('Toll-free'); await expect(dir).not.toContainText('555,');   // only real numbers
    const mid = page.locator('#phone-meeting-id'); await mid.fill('12345678901234'); await expect(mid).toHaveValue('123 4567 8901'); const pinBox = page.locator('#phone-pin'); await expect(pinBox).toHaveAttribute('type', 'password'); await page.getByRole('button', { name: 'Show PIN' }).click(); await expect(pinBox).toHaveAttribute('type', 'text');
    await page.locator('#qpShowHow').click(); await expect(page.locator('#qpHow')).toContainText('followed by #'); await expect(page.locator('#qpHow')).toContainText('123 4567 8901');
    await expect(page.locator('#qpNumber')).toContainText('No Qorlla number assigned'); await page.locator('#qpReqNum').click(); await expect(page.locator('#qpReqMsg')).toContainText('provider');   // honest: no number can be requested without a provider
    await page.locator('.qp-host summary').click(); await expect(page.locator('.ph-meeting', { hasText: 'Dial me' })).toBeVisible();
    const box = page.locator('.ph-meeting', { hasText: 'Dial me' }); await box.getByRole('button', { name: 'Create phone PIN' }).click(); await expect(box.locator('.ph-pinv')).toHaveText(/^\d{8}$/); const pin = await box.locator('.ph-pinv').textContent();
    await box.getByRole('button', { name: 'Copy phone invitation' }).click(); const inv = await page.evaluate(() => navigator.clipboard.readText()); expect(inv).toContain('+12125550100'); expect(inv).toContain('PIN: ' + pin + '#'); expect(inv).toContain('Meeting ID: ' + m.digits + '#');
    expect((await dial(m, FROM2, { pin })).body.result).toBe('connected');                                                              // the PIN shown on the page really works
    await page.reload(); await page.locator('.nav-item[data-view=phone]').click(); const rc = page.locator('#recent-calls'); await expect(rc).toContainText('Dial me'); await expect(rc).toContainText('Phone ••••4567');
    await rc.getByRole('button', { name: 'Calls', exact: true }).click(); await expect(page.locator('#phNoCalls')).toContainText('need a telephony provider'); await rc.getByRole('button', { name: 'Meeting Calls' }).click(); await rc.getByLabel('Search calls').fill('zzz'); await expect(page.locator('#phNoCalls')).toContainText('No calls match'); await rc.getByLabel('Search calls').fill('');
    await page.locator('#phTab-contacts').click(); await expect(page.locator('#phContacts')).toContainText('not available yet'); await expect(page.locator('.qp-grid')).toBeHidden();
    await page.locator('#phSettingsBtn').click(); await expect(page.locator('#phStatus')).toContainText('Telephony provider'); await expect(page.locator('#phStatus')).toContainText('2 provisioned'); await expect(page.locator('#phStatus')).toContainText('not built');
    await page.locator('#phTab-dial').focus(); await page.keyboard.press('ArrowRight'); await expect(page.locator('[role=tab][aria-selected=true]')).toHaveText('Join Meeting'); await expect(page.locator('.qp-grid')).toBeVisible();   // tabs by keyboard
    await page.setViewportSize({ width: 390, height: 800 }); await page.locator('#phTab-dial').click(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);   // no horizontal overflow on a phone
    await box.getByRole('button', { name: 'Revoke PIN' }).click({ timeout: 1500 }).catch(() => {}); await m.ctx.close();
  });
});

test('no provider: the Phone page says so and the dial-in directory is empty, never invented', async ({ browser }) => {
  test.setTimeout(60000);
  const main = await startMain(5298, { PHONE_DIAL_IN_NUMBERS: '', PHONE_PROVIDER: '' });
  try {
    const ctx = await browser.newContext(); await organiser(ctx, main.base); const page = await ctx.newPage(); await page.goto(main.base + '/qorlla.html#home'); await page.locator('.nav-item[data-view=phone]').click(); await page.locator('#phTab-join').click(); await expect(page.locator('#phNoNumbers')).toContainText('No dial-in numbers');
    await page.locator('#phTab-settings').click(); await expect(page.locator('#phStatus')).toContainText('not connected'); await expect(page.locator('#phStatus')).toContainText('none provisioned'); await page.locator('#phTab-recent').click(); await expect(page.locator('#phNoCalls')).toBeVisible(); await ctx.close();
  } finally { main.stop(); }
});
