const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');

// Qorlla Phone: meeting dial-in. These tests drive the REAL Meet server and PostgreSQL with SIGNED REQUESTS that stand in for a telephone carrier
// (PHONE_PROVIDER=test, a test double). They prove the rules (PINs, signatures, replay, attempt limits, waiting room, host controls, consent, attendance, hang-up).
// They do NOT prove real inbound calls, real numbers or audio: there is no carrier and no PSTN-to-WebRTC media gateway in this repository (BLOCKED).
// Needs Meet on :3310 started with scripts/start-recording-test-meet.cjs (it enables the test provider).
const { startMain, organiser } = require('./support/meet-stack');
const MEET = 'http://localhost:' + (process.env.MEET_TEST_PORT || 3310), SECRET = 'phone-test-secret-123456';
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

  test('MAIN API: dial-in numbers are only the real configured ones; the PIN is shown once; only the host; carrier calling is refused and provisioning needs an administrator', async ({ browser }) => {
    test.setTimeout(60000);
    const m = await meeting(browser); const api = (p, o) => m.ctx.request.fetch(B() + p, o);
    const dn = await (await api('/api/phone/dial-in-numbers')).json(); expect(dn.configured).toBe(true); expect(dn.numbers.map((n) => n.number)).toEqual(['+12125550100', '+18005550100']); expect(dn.numbers[1].tollFree).toBe(true); expect(dn.carrierCalling).toBe(false); expect(dn.joinEnabled).toBe(false); expect(dn.notice).toContain('not available yet'); expect(dn.numbers.every((n) => n.confirmed === false)).toBe(true);   // junk entries dropped, nothing invented, and joining by phone is not claimed while the bridge is uncertified
    expect((await (await browser.newContext()).request.get(B() + '/api/phone/dial-in-numbers')).status()).toBe(401);
    // Since the PSTN lockdown (61404e7) the feature gate answers BEFORE any validation or provider work: every carrier-calling and number-provisioning request is 403 feature_disabled,
    // with or without an idempotency key and whoever asks. The older outcomes (400 without a key, 503 "Carrier calling is not enabled", 403 "not an administrator") are not reachable while the gate is closed.
    // Exact status AND error are asserted: a refusal that changed its reason or became a success must fail this test.
    const gated = async (p, o) => { const r = await api(p, o); expect(r.status(), p).toBe(403); expect((await r.json()).error, p).toBe('feature_disabled'); };
    await gated('/api/phone/calls', { method: 'POST', data: { to: '+15551230000' } });
    await gated('/api/phone/calls', { method: 'POST', data: { to: '+15551230000' }, headers: { 'Idempotency-Key': 'call-test-0001' } });
    await gated('/api/phone/numbers/provision', { method: 'POST', data: { country: 'US' }, headers: { 'Idempotency-Key': 'req-test-0001' } });
    const pa = await (await api('/api/meetings/' + encodeURIComponent(m.item.meetingId) + '/phone-access', { method: 'POST', data: {} })).json(); expect(pa.pin).toMatch(/^\d{8}$/); expect(pa.pin).not.toBe(m.pin); expect(pa.shownOnce).toBe(true); expect(pa.telephony.enabled).toBe(true); expect(pa.telephony.provider).toBe('test-double');
    expect(pa.invitation).not.toContain('+12125550100'); expect(pa.invitation).toContain('not available yet'); expect(pa.invitation).toContain('Meeting ID: ' + m.digits + '#'); expect(pa.invitation).toContain('PIN: ' + pa.pin + '#'); expect(pa.invitation).toContain('audio only');
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
    const c = new Client({ connectionString: 'postgres://qorlla:' + s.dbPassword + '@127.0.0.1:' + (process.env.MEET_DB_PORT || 35432) + '/qorlla_meet' }); await c.connect(); const rows = (await c.query('select * from phone_calls where provider_call_id=$1', [('call-join-1' + RUN)])).rows[0]; await c.end();
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

  test('Phone page: dial pad (keys, keyboard, delete, copy), carrier calling is honestly off, dial-in directory and phone PIN for a meeting, recent calls, settings that say what is not connected', async ({ browser, browserName }) => {
    test.skip(browserName === 'firefox', 'Playwright cannot grant clipboard permissions in Firefox, and this test reads the clipboard: not run there');
    test.setTimeout(120000);
    const m = await meeting(browser, { title: 'Dial me' }); await dial(m, FROM1, { callId: ('ui-1' + RUN) });
    const page = await m.ctx.newPage(); await page.context().grantPermissions(['clipboard-read', 'clipboard-write']); await page.goto(B() + '/qorlla.html#home'); await page.locator('.nav-item[data-view=phone]').click();
    await expect(page.locator('.qp-tabs [role=tab][aria-selected=true]')).toHaveText('Dial Pad'); await expect(page.locator('.qp-grid .qp-card:visible')).toHaveCount(2); await expect(page.locator('#dial-pad')).toBeVisible(); await expect(page.locator('#qpRecentNums')).toBeVisible();   // each tab: its card on the left, a list on the right
    const num = page.locator('#qpDialNumber'); await page.locator('.ph-key[data-key="4"]').click(); await page.locator('.ph-key[data-key="5"]').click(); await expect(num).toHaveValue('45'); await page.getByRole('button', { name: 'Delete last digit' }).click(); await expect(num).toHaveValue('4');
    await page.locator('.ph-key[data-key="7"]').focus(); await page.keyboard.press('8'); await expect(num).toHaveValue('48'); await expect(page.locator('#qpDialHint')).toContainText('valid phone number');
    await page.getByRole('button', { name: 'Copy number', exact: true }).click(); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('48');
    await expect(page.locator('.qp-recent-num').first()).toContainText('48'); await page.getByRole('button', { name: 'Delete last digit' }).click(); await expect(num).toHaveValue('4'); await page.locator('.qp-recent-num').first().click(); await expect(num).toHaveValue('48');   // the right-hand list refills the dial pad
    await num.fill('(202) 555-0123'); await expect(page.locator('#qpDialHint')).toContainText('Public telephone numbers are not available'); await expect(page.locator('#qpDialHint')).toContainText('+12025550123'); await page.locator('#qpDialCountry').selectOption('GB'); await expect(page.locator('#qpDialHint')).toContainText('+442025550123');       // no carrier: the page says so (and still shows how the number was understood)
    await expect(page.locator('#phCall')).toBeDisabled(); await expect(page.locator('#phCallNote')).toContainText('requires a connected telephony provider'); await expect(page.locator('#qpCallerId')).toBeDisabled();
    await page.locator('#phTab-join').click(); await expect(page.locator('#dial-pad')).toBeHidden(); const mid = page.locator('#phone-meeting-id'); const dir = page.locator('.qp-dir');
    await expect(page.locator('#qpDirHint')).toContainText('after you enter a valid meeting ID'); await expect(dir).not.toContainText('+1212');   // no numbers before a meeting is chosen
    await mid.fill('99999999999'); await expect(page.locator('#qpDirNone')).toBeVisible(); await expect(dir).not.toContainText('+1212');   // unknown meeting: nothing to dial
    await mid.fill(m.digits + '99'); await expect(mid).toHaveValue(m.digits.slice(0, 3) + ' ' + m.digits.slice(3, 7) + ' ' + m.digits.slice(7, 11)); await expect(dir).toContainText('+12125550100'); await expect(dir).toContainText('Toll-free'); await expect(dir).not.toContainText('555,');   // a real meeting resolves; only real numbers
    await expect(page.locator('#phone-pin')).toHaveCount(0);   // the PIN is typed on the phone, never on this page
    await page.locator('#qpShowHow').click(); await expect(page.locator('#qpHow')).toContainText('followed by #'); await expect(page.locator('#qpHow')).toContainText(m.digits.slice(0, 3) + ' ' + m.digits.slice(3, 7) + ' ' + m.digits.slice(7, 11));
    await page.locator('#phTab-settings').click(); await expect(page.locator('#qpNumber')).toContainText('No number assigned'); await page.locator('#qpReqNum').click(); await expect(page.locator('#qpReqMsg')).toContainText('feature_disabled');   /* the numbers gate refuses first (PSTN lockdown 61404e7); no number can be requested */   // honest: no number can be requested without a provider
    await page.locator('#phTab-join').click(); await expect(page.locator('#qpMeetings')).toBeVisible(); await page.locator('.qp-pick', { hasText: 'Dial me' }).click(); await expect(mid).toHaveValue(m.digits.slice(0, 3) + ' ' + m.digits.slice(3, 7) + ' ' + m.digits.slice(7, 11));   // a click on a meeting fills the Meeting ID
    await expect(page.locator('.ph-meeting', { hasText: 'Dial me' })).toBeVisible();
    const box = page.locator('.ph-meeting', { hasText: 'Dial me' }); await box.getByRole('button', { name: 'Create phone PIN' }).click(); await expect(box.locator('.ph-pinv')).toHaveText(/^\d{8}$/); const pin = await box.locator('.ph-pinv').textContent();
    await box.getByRole('button', { name: 'Copy phone invitation' }).click(); const inv = await page.evaluate(() => navigator.clipboard.readText()); expect(inv).not.toContain('+12125550100'); expect(inv).toContain('not available yet'); expect(inv).toContain('PIN: ' + pin + '#'); expect(inv).toContain('Meeting ID: ' + m.digits + '#');
    expect((await dial(m, FROM2, { pin })).body.result).toBe('connected');                                                              // the PIN shown on the page really works
    await page.reload(); await page.locator('.nav-item[data-view=phone]').click(); await page.locator('#phTab-recent').click(); const rc = page.locator('#recent-calls'); await expect(rc).toContainText('Dial me'); await expect(rc).toContainText('Phone ••••4567');
    await rc.locator('.qp-call-row').first().click(); await expect(page.locator('#qpViewAll')).toHaveText('View all (2)'); await expect(page.locator('#qpCallsCount')).toHaveText('Showing all 2 calls'); await page.locator('#qpViewAll').click(); await expect(page.locator('#qpViewAll')).toHaveText('Show fewer'); await expect(page.locator('#qpViewAll')).toHaveAttribute('aria-expanded', 'true'); await page.locator('#qpViewAll').click(); await expect(page.locator('#qpViewAll')).toHaveText('View all (2)');
    await expect(page.locator('#qpCallDetail')).toContainText('Dial me'); await expect(page.locator('#qpCallDetail')).toContainText(m.digits.slice(0, 3) + ' ' + m.digits.slice(3, 7) + ' ' + m.digits.slice(7, 11)); await expect(page.locator('#qpCallDetail')).toContainText('Host'); await expect(page.locator('#qpCallDetail')).toContainText('by phone'); await page.locator('#qpViewPeople').click(); await expect(page.locator('#qpPeers')).toContainText('Phone ••••4567'); await page.locator('#qpCopyId').click(); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(m.digits.slice(0, 3) + ' ' + m.digits.slice(3, 7) + ' ' + m.digits.slice(7, 11)); await page.locator('#qpCopyInv').click(); await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Meeting ID: ');   // detail buttons are wired
    await rc.getByRole('button', { name: 'Calls', exact: true }).click(); await expect(page.locator('#phNoCalls')).toContainText('need a telephony provider'); await rc.getByRole('button', { name: 'Meeting Calls' }).click(); await rc.getByLabel('Search calls').fill('zzz'); await expect(page.locator('#phNoCalls')).toContainText('No calls match'); await rc.getByLabel('Search calls').fill('');
    await page.locator('#phTab-contacts').click(); await expect(page.locator('#qpNoContacts')).toContainText('No contacts yet'); await expect(page.locator('#qpContacts')).toBeVisible(); await expect(page.locator('#recent-calls')).toBeHidden();
    await page.locator('#phSettingsBtn').click(); await expect(page.locator('#psPage')).toBeVisible(); await page.locator('#phTab-settings').click(); await page.locator('#qpPT-plans').click(); await expect(page.locator('#phStatus')).toContainText('Telephony provider'); await expect(page.locator('#phStatus')).toContainText('Dial-in numbers'); await expect(page.locator('#phStatus')).toContainText('Not built');
    await page.locator('#phTab-dial').focus(); await page.keyboard.press('ArrowRight'); await expect(page.locator('.qp-tabs [role=tab][aria-selected=true]')).toHaveText('Join Meeting'); await expect(page.locator('.qp-grid')).toBeVisible();   // tabs by keyboard
    await page.setViewportSize({ width: 390, height: 800 }); await page.locator('#phTab-dial').click(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);   // no horizontal overflow on a phone
    await box.getByRole('button', { name: 'Revoke PIN' }).click({ timeout: 1500 }).catch(() => {}); await m.ctx.close();
  });
});

test('no provider: the Phone page says so and the dial-in directory is empty, never invented', async ({ browser }) => {
  test.setTimeout(60000);
  const main = await startMain(5298, { PHONE_DIAL_IN_NUMBERS: '', PHONE_PROVIDER: '' });
  try {
    const ctx = await browser.newContext(); await organiser(ctx, main.base); const page = await ctx.newPage(); await page.goto(main.base + '/qorlla.html#home'); await page.locator('.nav-item[data-view=phone]').click(); await page.locator('#phTab-join').click(); await expect(page.locator('#phNoNumbers')).toContainText('No dial-in numbers');
    await page.locator('#phTab-settings').click(); await page.locator('#qpPT-plans').click(); await expect(page.locator('#phStatus')).toContainText('Not connected'); await expect(page.locator('#phStatus')).toContainText('Needs a connected carrier'); await page.locator('#phTab-recent').click(); await expect(page.locator('#phNoCalls')).toBeVisible(); await ctx.close();
  } finally { main.stop(); }
});

test('Join Meeting: a failing request is told apart from an empty one (stale server 404, server error, genuinely none), History lists finished meetings without phone actions', async ({ browser }) => {
  test.setTimeout(90000);
  const main = await startMain(5296, { PHONE_DIAL_IN_NUMBERS: NUMBERS, PHONE_PROVIDER: 'test' });
  try {
    const ctx = await browser.newContext(); const { item: item0 } = await organiser(ctx, main.base); const page = await ctx.newPage();
    await page.route('**/api/phone/dial-in-numbers', (r) => r.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not found</h1>' }));   // what an old server that was not restarted answers
    await page.route('**/api/workplace/schedule', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The schedule is unavailable.' }) }));
    await page.goto(main.base + '/qorlla.html#home'); await page.locator('.nav-item[data-view=phone]').click(); await page.locator('#phTab-join').click();
    await expect(page.locator('#qpDirErr')).toContainText('older version'); await expect(page.locator('#qpJoinCountry')).toBeDisabled(); await expect(page.locator('#qpJoinCountry')).toContainText('Unavailable');
    await expect(page.locator('#qpMineErr')).toContainText('schedule is unavailable'); await expect(page.locator('#qpMineNone')).toHaveCount(0);   // an error is not shown as "no meetings"
    await page.unroute('**/api/phone/dial-in-numbers'); await page.unroute('**/api/workplace/schedule');
    await page.locator('#qpDirErr ~ button').click(); await expect(page.locator('#qpJoinCountry')).toBeEnabled(); await expect(page.locator('#qpDirHint')).toBeVisible();
    const opts = await page.locator('#qpJoinCountry option').allTextContents(); expect(opts.length).toBeGreaterThan(20); expect(opts).toContain('United States (+1)'); expect(opts).toContain('Ghana (+233)');   // the selector is populated with supported regions even with no number provisioned for them
    await page.locator('#phone-meeting-id').fill(item0.meetingId); await page.locator('#qpJoinCountry').selectOption('GH'); await expect(page.locator('#qpDirNoCountry')).toContainText('No dial-in number is provisioned for Ghana');
    await page.locator('#qpMineErr ~ button').click(); await expect(page.locator('#qpMineErr')).toHaveCount(0); await expect(page.locator('.qp-pick').first()).toBeVisible();   // recovered: the organiser's meeting is listed
    await page.locator('#qpMeetings [data-m=history]').click(); await expect(page.locator('#qpMineNone')).toContainText('No finished meetings'); await expect(page.getByRole('button', { name: 'Create phone PIN' })).toHaveCount(0);
    const fake = Array.from({ length: 9 }, (_, i) => ({ id: 'c' + i, kind: 'meeting', meetingId: '123 4567 89' + String(i).padStart(2, '0'), title: 'Call ' + i, name: 'Phone \u2022\u2022\u2022\u2022' + (1000 + i), status: 'ended', joinedAt: new Date(Date.now() - i * 3600000).toISOString(), seconds: 60 * (i + 1), muted: false }));
    await page.route('**/api/phone/calls/history', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ calls: fake, outgoing: [] }) }));
    await page.reload(); await page.locator('.nav-item[data-view=phone]').click(); await page.locator('#phTab-recent').click();
    await expect(page.locator('.qp-call-row')).toHaveCount(6); await expect(page.locator('#qpViewAll')).toHaveText('View all (9)'); await expect(page.locator('#qpCallsCount')).toHaveText('Showing 6 of 9 calls');
    await page.locator('#qpViewAll').click(); await expect(page.locator('.qp-call-row')).toHaveCount(9); await expect(page.locator('#qpViewAll')).toHaveText('Show fewer'); await expect(page.locator('#qpCallsCount')).toHaveText('Showing all 9 calls');
    await page.locator('#qpViewAll').click(); await expect(page.locator('.qp-call-row')).toHaveCount(6);   // View all expands, Show fewer collapses
    await ctx.close();
  } finally { main.stop(); }
});

test.describe('Phone: contacts, call preferences, plans, recurrence labels, invitation text', () => {
  test.describe.configure({ mode: 'serial' });
  let main; test.beforeAll(async () => { main = await startMain(5295, { PHONE_DIAL_IN_NUMBERS: NUMBERS, PHONE_PROVIDER: 'test', SMTP_URL: 'smtp://127.0.0.1:1', SMTP_FROM: 'noreply@qorlla.test' }); }); test.afterAll(() => main && main.stop());

  test('API: contacts are private, validated and complete (create, list, edit, favorite, delete); phone settings validate and save; overview tells the truth', async ({ browser }) => {
    const ctx = await browser.newContext(); await organiser(ctx, main.base); const r = ctx.request, u = main.base + '/api/workplace/contacts';
    expect((await (await r.get(u)).json())).toEqual([]);
    expect((await r.post(u, { data: { name: '', email: 'a@b.co' } })).status()).toBe(400);
    expect((await r.post(u, { data: { name: 'No way to reach' } })).status()).toBe(400);
    expect((await r.post(u, { data: { name: 'Bad phone', phone: '12345' } })).status()).toBe(400);
    expect((await r.post(u, { data: { name: 'Bad mail', email: 'nope' } })).status()).toBe(400);
    const a = await r.post(u, { data: { name: 'Jane Smith', email: 'Jane@Example.com', phone: '+1 (202) 555-0100', department: 'Engineering', group: 'colleague' } }); expect(a.status()).toBe(201); const jane = await a.json();
    expect(jane).toMatchObject({ email: 'jane@example.com', phone: '+12025550100', group: 'colleague', favorite: false });
    await r.post(u, { data: { name: 'Amina Khan', email: 'amina@example.com', group: 'bogus' } });
    expect((await (await r.get(u)).json()).map((c) => c.name)).toEqual(['Amina Khan', 'Jane Smith']);   // sorted by name; an unknown group becomes external
    expect((await (await r.patch(u + '/' + jane.id, { data: { favorite: true, department: 'Research' } })).json())).toMatchObject({ favorite: true, department: 'Research', phone: '+12025550100' });
    const other = await browser.newContext(); await organiser(other, main.base); expect((await (await other.request.get(u)).json())).toEqual([]);   // another account sees none of them
    expect((await other.request.delete(u + '/' + jane.id)).status()).toBe(404); await other.close();
    expect((await r.delete(u + '/' + jane.id)).status()).toBe(200); expect((await (await r.get(u)).json()).length).toBe(1);
    const ps = main.base + '/api/workplace/phone-settings'; expect((await (await r.get(ps)).json())).toMatchObject({ forwardEnabled: false, voicemailEnabled: false, missedAlerts: true });
    expect((await r.put(ps, { data: { forwardEnabled: true } })).status()).toBe(400); expect((await r.put(ps, { data: { forwardTo: '12345' } })).status()).toBe(400);
    const saved = await (await r.put(ps, { data: { forwardEnabled: true, forwardTo: '+44 20 7123 4567', voicemailEnabled: true, voicemailGreeting: 'Leave a message', callerIdName: 'Stryker' } })).json(); expect(saved).toMatchObject({ forwardTo: '+442071234567', active: false }); expect(saved.note).toContain('once carrier calling is connected');
    expect((await (await r.get(ps)).json())).toMatchObject({ forwardEnabled: true, voicemailGreeting: 'Leave a message', callerIdName: 'Stryker' });
    const ov = await (await r.get(main.base + '/api/phone/overview')).json(); expect(ov).toMatchObject({ carrierCalling: false, audioBridge: false, assigned: [], plan: { name: 'Free', limitMinutes: 30, graceMinutes: 10, billingConnected: false } }); expect(ov.numbers.map((n) => n.number)).toEqual(['+12125550100', '+18005550100']);
    await ctx.close();
  });

  test('a repeating series is labelled "Recurring (N occurrences)" with its pattern and which occurrence it is, and the invitation carries a Repeats line', async ({ browser }) => {
    const ctx = await browser.newContext(); const { item } = await organiser(ctx, main.base, { title: 'Embedded and SCADA systems' }); const r = ctx.request;
    const mk = async (i, date) => (await (await r.post(main.base + '/api/workplace/schedule', { data: { title: 'Weekly class', date, time: '17:00', duration: 150, seriesId: 'sTest1', seriesRepeat: 'weekly', seriesCount: 3, seriesIndex: i } })).json());
    const a = await mk(0, '2027-08-23'), b = await mk(1, '2027-08-30'); await mk(2, '2027-09-06');
    expect(a.meetingId).not.toEqual(b.meetingId);                                                             // every occurrence keeps its own Meeting ID, attendance and History record
    const list = await (await r.get(main.base + '/api/workplace/schedule')).json(); const x = list.find((i) => i.id === b.id);
    expect(x.recurrence).toMatchObject({ label: 'Recurring (3 occurrences)', occurrence: '2 of 3', count: 3, repeat: 'weekly' }); expect(x.recurrence.detail).toBe('Every week on Mon, until Sep 6, 2027 (3 occurrences)');
    expect(list.find((i) => i.id === item.id).recurrence).toBeUndefined();                                    // a single meeting has none
    const t = await (await r.get(main.base + '/api/meetings/' + encodeURIComponent(b.meetingId) + '/invitation-text')).json(); expect(t.text).toContain('Repeats: Every week on Mon, until Sep 6, 2027 (3 occurrences)'); expect(t.text).not.toContain('+12125550100'); expect(t.text).not.toContain('Join by phone'); expect(t.text).toContain('Meeting ID: ' + b.meetingId);
    expect((await ctx.request.get(main.base + '/api/meetings/' + encodeURIComponent(b.meetingId) + '/invitation.ics')).status()).toBe(200);
    const other = await browser.newContext(); await organiser(other, main.base); expect((await other.request.get(main.base + '/api/meetings/' + encodeURIComponent(b.meetingId) + '/invitation-text')).status()).toBe(403); await other.close();   // only the host
    const page = await ctx.newPage(); await page.goto(main.base + '/qorlla.html#home'); await page.locator('.nav-item[data-view=schedule]').click(); await expect(page.locator('.sched-rec').first()).toContainText('Recurring (3 occurrences)'); await ctx.close();
  });

  test('Contacts tab: add, search, filter, favorite, edit, call (honestly refused without a provider), start a meeting, delete; Numbers & Plans tabs save and show the truth; all at 1280x720 without scrolling', async ({ browser }) => {
    test.setTimeout(120000);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } }); await organiser(ctx, main.base); const page = await ctx.newPage(); page.on('dialog', (d) => d.accept());
    await page.goto(main.base + '/qorlla.html#home'); await page.locator('.nav-item[data-view=phone]').click(); await page.locator('#phTab-contacts').click();
    await page.locator('#qpAddContact').click(); await page.locator('#qpSaveContact').click(); await expect(page.locator('#qpFormMsg')).toContainText('Name is required');
    await page.locator('#qpCName').fill('Dr. Jane Smith'); await page.locator('#qpCEmail').fill('jane.smith@example.com'); await page.locator('#qpCPhone').fill('abc'); await page.locator('#qpSaveContact').click(); await expect(page.locator('#qpFormMsg')).toContainText('international');
    await page.locator('#qpCPhone').fill('+12025550100'); await page.locator('#qpCDept').fill('Engineering'); await page.locator('#qpSaveContact').click();
    await expect(page.locator('#qpCtDH')).toHaveText('Dr. Jane Smith'); await expect(page.locator('#qpContactDetail')).toContainText('Engineering'); await expect(page.locator('.qp-crow')).toHaveCount(1);
    await page.locator('#qpAddContact').click(); await page.locator('#qpCName').fill('Michael Tan'); await page.locator('#qpCEmail').fill('michael@example.com'); await page.locator('#qpCGroup').selectOption('external'); await page.locator('#qpSaveContact').click(); await expect(page.locator('.qp-crow')).toHaveCount(2);
    await page.locator('#qpFav').click(); await expect(page.locator('#qpFav')).toHaveAttribute('aria-pressed', 'true'); await page.locator('#cFilter, [data-f=favorites]').first().click(); await expect(page.locator('.qp-crow')).toHaveCount(1); await page.locator('#qpContacts [data-f=all]').click();
    await page.getByLabel('Search contacts').fill('jane'); await expect(page.locator('.qp-crow')).toHaveCount(1); await page.getByLabel('Search contacts').fill('zzz'); await expect(page.locator('#qpNoContacts')).toContainText('No contacts match'); await page.getByLabel('Search contacts').fill('');
    await page.locator('.qp-crow', { hasText: 'Dr. Jane Smith' }).click(); await page.locator('#qpCallBtn').click(); await expect(page.locator('#qpContactMsg')).toContainText('feature_disabled');   // wired to the API; refused honestly. Since the PSTN lockdown (61404e7) the gate's own code is what the page shows (the raw code is a wording follow-up for the page, tracked separately)
    await page.locator('#qpEdit').click(); await page.locator('#qpCDept').fill('Research'); await page.locator('#qpSaveContact').click(); await expect(page.locator('#qpContactDetail')).toContainText('Research');
    await page.locator('#qpStartMeet').click(); await expect(page.locator('#startDialog')).toBeVisible({ timeout: 15000 }); await expect(page.locator('#sdEmails')).toHaveValue('jane.smith@example.com', { timeout: 15000 }); await page.locator('#sdClose').click();
    const over = await page.evaluate(() => { const g = document.querySelector('.qp-grid').getBoundingClientRect(); return [g.bottom, innerHeight, document.documentElement.scrollWidth > innerWidth + 1]; }); expect(over[0]).toBeLessThanOrEqual(over[1]); expect(over[2]).toBe(false);
    await page.locator('.qp-crow-wrap', { hasText: 'Michael Tan' }).getByLabel('More actions for Michael Tan').click(); await page.getByRole('menuitem', { name: 'Delete' }).click(); await expect(page.locator('.qp-crow')).toHaveCount(1);
    // Numbers & Plans
    await page.locator('#phTab-settings').click(); await expect(page.locator('#qpNumTable')).toContainText('+12125550100'); await expect(page.locator('#qpNumber')).toContainText('Unassigned');
    await page.locator('#qpPT-plans').click(); await expect(page.locator('#qpPlanBody')).toContainText('Free'); await expect(page.locator('#qpPlanBody')).toContainText('30 + 10'); await expect(page.locator('#qpUpgrade')).toHaveAttribute('href', /pricing/);
    await page.locator('#qpPT-settings').click(); await page.locator('#qpCallerName').fill('Qorlla Workspace'); await page.locator('#qpSaveSettings').click(); await expect(page.locator('#qpPlanMsg')).toContainText('Saved'); await expect(page.locator('#qpNumber')).toContainText('Qorlla Workspace');
    await page.locator('#qpPT-forward').click(); await page.locator('#qpFwdOn').check(); await page.locator('#qpSaveFwd').click(); await expect(page.locator('#qpPlanMsg')).toContainText('Enter the number'); await page.locator('#qpFwdTo').fill('+442071234567'); await page.locator('#qpSaveFwd').click(); await expect(page.locator('#qpPlanMsg')).toContainText('once carrier calling is connected');
    await page.locator('#qpPT-voicemail').click(); await page.locator('#qpVmOn').check(); await page.locator('#qpVmGreeting').fill('Please leave a message'); await page.locator('#qpSaveVm').click(); await expect(page.locator('#qpPlanMsg')).toContainText('once carrier calling is connected');
    await page.reload(); await page.locator('.nav-item[data-view=phone]').click(); await page.locator('#phTab-settings').click(); await page.locator('#qpPT-voicemail').click(); await expect(page.locator('#qpVmOn')).toBeChecked(); await expect(page.locator('#qpVmGreeting')).toHaveValue('Please leave a message');   // it was really saved
    await page.locator('#qpManage').click(); await expect(page.locator('#qpNumTable')).toBeVisible(); await page.locator('#qpReqNum').click(); await expect(page.locator('#qpReqMsg')).toContainText('feature_disabled');   /* the numbers gate refuses first (PSTN lockdown 61404e7); no number can be requested */
    await ctx.close();
  });
});

test.describe('Phone Settings, Help Center, Diagnostics and support tickets', () => {
  test.describe.configure({ mode: 'serial' });
  let main; test.beforeAll(async () => { main = await startMain(5294, { PHONE_DIAL_IN_NUMBERS: NUMBERS, PHONE_PROVIDER: 'test' }); }); test.afterAll(() => main && main.stop());

  test('API: settings are validated server-side, sensitive changes are audited, help articles are searchable, diagnostics carry a reference and no secrets, tickets reject PINs', async ({ browser }) => {
    const ctx = await browser.newContext(); await organiser(ctx, main.base); const r = ctx.request, ps = main.base + '/api/workplace/phone-settings';
    const d = await (await r.get(ps)).json(); expect(d).toMatchObject({ callWaiting: true, doNotDisturb: false, defaultCountry: 'US', ringtone: 'classic', notifyChannel: 'browser', blockedNumbers: [], spamProtection: true, historyRetentionDays: 90 });
    for (const bad of [{ doNotDisturb: 'yes' }, { ringtone: 'siren' }, { notifyChannel: 'sms' }, { historyRetentionDays: 7 }, { defaultCountry: 'usa' }, { blockedNumbers: ['12345'] }, { blockedNumbers: 'x' }, { forwardTo: '555' }]) expect((await r.put(ps, { data: bad })).status(), JSON.stringify(bad)).toBe(400);
    expect((await r.put(ps, { data: { blockedNumbers: Array.from({ length: 101 }, (_, i) => '+1202555' + String(1000 + i)) } })).status()).toBe(400);
    const ok = await (await r.put(ps, { data: { callerIdName: 'Qorlla Desk', doNotDisturb: true, defaultCountry: 'GH', ringtone: 'chime', notifyChannel: 'both', historyRetentionDays: 30, blockedNumbers: ['+1 (202) 555-0111', '+12025550111', '+12025550112'], micLabel: 'Fake mic' } })).json();
    expect(ok).toMatchObject({ doNotDisturb: true, defaultCountry: 'GH', ringtone: 'chime', blockedNumbers: ['+12025550111', '+12025550112'], note: 'Saved.' });
    const audit = await (await r.get(main.base + '/api/workplace/phone-audit')).json(); expect(audit.length).toBe(1); expect(audit[0].changed.sort()).toEqual(['blockedNumbers', 'doNotDisturb']); expect(JSON.stringify(audit)).not.toContain('2025550111');   // what changed, never the numbers
    await r.put(ps, { data: { callerIdName: 'Renamed' } }); expect((await (await r.get(main.base + '/api/workplace/phone-audit')).json()).length).toBe(1);   // a harmless change is not audited
    const other = await browser.newContext(); await organiser(other, main.base); expect((await (await other.request.get(ps)).json()).callerIdName).toBe(''); expect((await (await other.request.get(main.base + '/api/workplace/phone-audit')).json())).toEqual([]); await other.close();
    const h = await (await r.get(main.base + '/api/workplace/phone-help/articles')).json(); expect(h.articles.length).toBeGreaterThanOrEqual(12); expect(h.categories).toContain('Meeting PIN Problems'); for (const a of h.articles) { expect(a.steps.length).toBeGreaterThan(0); expect(JSON.stringify(a)).not.toMatch(/\b\d{8}\b/); }
    expect((await (await r.get(main.base + '/api/workplace/phone-help/articles?q=404')).json()).articles.map((a) => a.slug)).toContain('http-errors'); expect((await (await r.get(main.base + '/api/workplace/phone-help/articles?q=zzzzqq')).json()).articles).toEqual([]);
    expect((await r.get(main.base + '/api/workplace/phone-help/articles/join-a-meeting-by-phone')).status()).toBe(200); expect((await r.get(main.base + '/api/workplace/phone-help/articles/nope')).status()).toBe(404);
    const dr = await r.get(main.base + '/api/phone/diagnostics'); const dg = await dr.json(); expect(dg.correlationId).toMatch(/^[a-f0-9]{10}$/); expect(dr.headers()['x-correlation-id']).toBe(dg.correlationId);
    const by = Object.fromEntries(dg.checks.map((c) => [c.id, c.status])); expect(by).toMatchObject({ api: 'ok', numbers: 'warn', provider: 'warn', audio: 'unavailable', billing: 'unavailable' }); expect(['ok', 'fail']).toContain(by.meet);
    expect(JSON.stringify(dg)).not.toMatch(/secret|password|pin\b|postgres:/i);
    expect((await ctx.request.fetch(main.base + '/api/phone/diagnostics', { headers: {} })).status()).toBe(200);
    const anon = await browser.newContext(); const ar = await anon.request.get(main.base + '/api/phone/diagnostics'); expect(ar.status()).toBe(401); expect(ar.headers()['x-correlation-id']).toMatch(/^[a-f0-9]{10}$/); await anon.close();
    const tk = main.base + '/api/workplace/phone-tickets';
    expect((await r.post(tk, { data: { subject: 'x', description: 'short' } })).status()).toBe(400); const red = await (await r.post(tk, { data: { subject: 'PIN', description: 'my pin is 12345678 and token abcdefghijklmnopqrstuvwxyz0123456789 please help' } })).json(); expect(red.redacted).toBeGreaterThanOrEqual(2); expect(JSON.stringify(red)).not.toMatch(/12345678|abcdefghijklmnopqrstuvwxyz0123456789/);
    const t = await (await r.post(tk, { data: { subject: 'Cannot join', category: 'Join by Phone', description: 'The dial-in numbers never appear for my meeting.', reference: dg.correlationId } })).json(); expect(t).toMatchObject({ status: 'open', category: 'Join by Phone', reference: dg.correlationId, notified: false, redacted: 0 }); expect(t.ref).toMatch(/^T-[0-9A-F]{6}$/);
    expect((await (await r.get(tk)).json()).map((x) => x.ref).sort()).toEqual([t.ref, red.ref].sort()); const o2 = await browser.newContext(); await organiser(o2, main.base); expect((await (await o2.request.get(tk)).json())).toEqual([]); expect((await o2.request.get(tk + '/' + t.id)).status()).toBe(404); await o2.close();
    expect((await r.post(tk + '/' + t.id + '/close', { data: {} })).status()).toBe(200); expect((await (await r.get(tk + '/' + t.id)).json()).status).toBe('closed'); await ctx.close();
  });

  test('Phone Settings page: all eight sections, saved values come back, microphone and speaker tests run, blocked numbers validate, audit shows, export works, billing and admin say unavailable', async ({ browser, browserName }) => {
    test.setTimeout(120000);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...(browserName === 'chromium' ? { permissions: ['microphone'] } : {}), acceptDownloads: true }); await organiser(ctx, main.base); const page = await ctx.newPage();
    await page.goto(main.base + '/qorlla.html#home'); await page.locator('.nav-item[data-view=phone]').click(); await page.locator('#phSettingsBtn').click(); await expect(page.locator('#psPage')).toBeVisible();
    await expect(page.locator('#psNav-calling')).toHaveAttribute('aria-selected', 'true'); await expect(page.locator('#psBody')).toContainText('Not yet enabled'); await expect(page.locator('#psOutNum')).toBeDisabled(); await expect(page.locator('#psOutNum')).toContainText('No number assigned');
    await page.locator('#psCallerName').fill('Qorlla Desk'); await page.locator('#psDnd').check(); await page.locator('#psFwdOn').check(); await page.locator('#psSaveCalling').click(); await expect(page.locator('#psSaveCallingMsg')).toContainText('Enter the number to forward');
    await page.locator('#psFwdTo').fill('+442071234567'); await page.locator('#psSaveCalling').click(); await expect(page.locator('#psSaveCallingMsg')).toContainText('once carrier calling is connected');
    await page.locator('#psNav-audio').click(); await page.locator('#psAllowDev').click(); await expect(page.locator('#psAudioMsg')).toContainText('Device names are now shown', { timeout: 20000 }); await expect(page.locator('#psMic option').first()).not.toHaveText('No microphone found');
    await page.locator('#psTestMic').click(); await expect(page.locator('#psAudioMsg')).toContainText('microphone is working', { timeout: 15000 }); await page.locator('#psTestSpk').click(); await expect(page.locator('#psAudioMsg')).toContainText('tone'); await page.locator('#psPlayRing').click(); await expect(page.locator('#psAudioMsg')).toContainText('ringtone');
    await page.locator('#psRing').selectOption('soft'); await page.locator('#psNoise').uncheck(); await page.locator('#psSaveAudio').click(); await expect(page.locator('#psSaveAudioMsg')).toContainText('Saved');
    await page.locator('#psNav-dialin').click(); await expect(page.locator('#psDialinTable')).toContainText('+12125550100'); await page.locator('#psCountry').selectOption('GH'); await page.locator('#psSaveDialin').click(); await expect(page.locator('#psSaveDialinMsg')).toContainText('Saved'); await expect(page.locator('.psPinMake').first()).toBeVisible();
    await page.locator('.psPinMake').first().click(); await expect(page.locator('.ph-pinv').first()).toHaveText(/^\d{8}$/); await page.getByRole('button', { name: 'Revoke PIN' }).first().click();
    await page.locator('#psNav-privacy').click(); await page.locator('#psBlockIn').fill('12345'); await page.locator('#psBlockAdd').click(); await expect(page.locator('#psBlockErr')).toContainText('international'); await page.locator('#psBlockIn').fill('+1 202 555 0111'); await page.locator('#psBlockAdd').click(); await expect(page.locator('#psBlockList')).toContainText('+12025550111'); await page.locator('#psSavePrivacy').click(); await expect(page.locator('#psSavePrivacyMsg')).toContainText('Saved');
    await page.locator('#psNav-privacy').click(); await expect(page.locator('#psBlockList')).toContainText('+12025550111'); await expect(page.locator('#psAudit')).toContainText('blockedNumbers');   // saved on the server, and audited without the number
    await page.locator('#psNav-notify').click(); await page.locator('#psNChan').selectOption('both'); await page.locator('#psSaveNotify').click(); await expect(page.locator('#psSaveNotifyMsg')).toContainText('Saved');
    await page.locator('#psNav-history').click(); await page.locator('#psRetention').selectOption('30'); await page.locator('#psSaveHistory').click(); await expect(page.locator('#psSaveHistoryMsg')).toContainText('Saved');
    const dl = page.waitForEvent('download'); await page.locator('#psExport').click(); expect((await dl).suggestedFilename()).toBe('qorlla-phone-calls.csv'); await expect(page.locator('#psHistMsg')).toContainText('exported'); await page.locator('#psClearNums').click(); await expect(page.locator('#psHistMsg')).toContainText('cleared');
    await page.locator('#psNav-plans').click(); await expect(page.locator('#psBilling')).toContainText('not available'); await expect(page.locator('#psUpgrade')).toHaveAttribute('href', /pricing/);
    await page.locator('#psNav-admin').click(); await expect(page.locator('#psAdminNote')).toContainText('not available'); await expect(page.locator('#psBody')).toContainText('Call queues');
    await page.reload(); await page.locator('.nav-item[data-view=phone]').click(); await page.locator('#phSettingsBtn').click(); await expect(page.locator('#psCallerName')).toHaveValue('Qorlla Desk'); await expect(page.locator('#psDnd')).toBeChecked(); await page.locator('#psNav-notify').click(); await expect(page.locator('#psNChan')).toHaveValue('both');   // really saved
    await page.locator('#psNav-calling').focus(); await page.keyboard.press('ArrowDown'); await expect(page.locator('#psNav-audio')).toHaveAttribute('aria-selected', 'true');   // keyboard
    await page.setViewportSize({ width: 390, height: 800 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); await ctx.close();
  });

  test('Help Center: search and categories find real articles; Diagnostics shows each service with a reference; the error guide explains 404; a support ticket can be created and withdrawn; a missing route is explained', async ({ browser }) => {
    test.setTimeout(120000);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } }); await organiser(ctx, main.base); const page = await ctx.newPage();
    await page.goto(main.base + '/qorlla.html#home'); await page.locator('.nav-item[data-view=phone]').click(); await page.locator('#phHelpBtn').click(); await expect(page.locator('#hpH')).toHaveText('Qorlla Phone Help Center'); await expect(page.locator('.hp-card')).toHaveCount(6);
    await expect(page.locator('#hpCount')).toContainText('All articles: '); await page.getByLabel('Search phone help').fill('404'); await expect(page.locator('.hp-art')).toContainText('Understanding errors such as HTTP 404'); await page.getByLabel('Search phone help').fill('zzzzqq'); await expect(page.locator('#hpNone')).toBeVisible();
    await page.getByLabel('Search phone help').fill(''); await page.locator('.hp-card[data-g="Join by Phone"]').click(); await expect(page.locator('.hp-art')).toHaveCount(3); await page.locator('.hp-art', { hasText: 'Join a meeting by phone' }).click(); await expect(page.locator('#hpArtTitle')).toHaveText('Join a meeting by phone'); await expect(page.locator('.hp-steps')).toContainText('11-digit Meeting ID'); await page.locator('#hpBack').click(); await expect(page.locator('.hp-art').first()).toBeVisible();
    await page.locator('#hpTab-diag').click(); await expect(page.locator('#hpChecks')).toContainText('Not checked'); await page.locator('#hpRun').click();
    await expect(page.locator('[data-id=api]')).toContainText('OK'); await expect(page.locator('[data-id=numbers]')).toContainText('Warning'); await expect(page.locator('[data-id=provider]')).toContainText('Warning'); await expect(page.locator('[data-id=audio]')).toContainText('Unavailable'); await expect(page.locator('[data-id=devices]')).toContainText(/OK|Warning/); await expect(page.locator('#hpRef strong')).toHaveText(/^[a-f0-9]{10}$/);
    await page.locator('#hpD-guide').click(); await expect(page.locator('#hpGuide')).toContainText('older version');
    await page.locator('#hpTab-tickets').click(); await expect(page.locator('#hpRefIn')).toHaveValue(/^[a-f0-9]{10}$/); await page.locator('#hpSend').click(); await expect(page.locator('#hpMsg')).toContainText('Add a short subject');
    await page.locator('#hpSubject').fill('Cannot see dial-in numbers'); await page.locator('#hpDesc').fill('My PIN is 12345678 and it fails, please look'); await page.locator('#hpSend').click(); await expect(page.locator('#hpMsg')).toContainText('looked like secrets were removed');
    await expect(page.locator('.hp-ticket').first()).toContainText('Open'); await page.locator('.hp-ticket').first().click(); await expect(page.locator('#hpThread')).toContainText('PIN is [removed]'); await expect(page.locator('#hpThread')).not.toContainText('12345678'); await expect(page.locator('#hpTicketStatus')).toContainText('Open');
    await page.locator('#hpReplyText').fill('Thank you, nothing else to add'); await page.locator('#hpReplySend').click(); await expect(page.locator('#hpThread')).toContainText('nothing else to add'); page.once('dialog', (d) => d.accept()); await page.locator('#hpCloseTicket').click(); await expect(page.locator('#hpTicketStatus')).toContainText('Closed'); await expect(page.locator('#hpClosedNote')).toBeVisible();
    // a route that is missing (an old server that was not restarted) is explained, with Retry
    await page.route('**/api/workplace/phone-settings', (r) => r.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not found</h1>' }));
    await page.locator('#phSettingsBtn').click(); await expect(page.locator('#psErr')).toContainText('older version'); await page.unroute('**/api/workplace/phone-settings'); await page.getByRole('button', { name: 'Retry' }).click(); await expect(page.locator('#psPage')).toBeVisible(); await expect(page.locator('#psCallerName')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 800 }); await page.locator('#phHelpBtn').click(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); await ctx.close();
  });
});
