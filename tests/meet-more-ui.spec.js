const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const directory = path.resolve(__dirname, '../qorlla-meet-video/public');
const id = '11111111-1111-4111-8111-111111111111';

async function preview(page, role = 'host', available = true) {
  let permissions = { guestChat: true, reactions: true }, locked = false, questions = [];
  const manager = role === 'host';
  const claims = Buffer.from(JSON.stringify({ role, name: 'Alex Morgan' })).toString('base64url');
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => new MediaStream(), enumerateDevices: async () => [] } });
    window.__recordingStarted = false;
    window.MediaRecorder = function () { window.__recordingStarted = true; throw Error('Recording must stay unavailable'); };
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    const target = url.pathname;
    if (target === '/socket.io/socket.io.js') return route.fulfill({ contentType: 'application/javascript', body: `window.io=()=>{const handlers={};const socket={on(event,callback){(handlers[event]??=[]).push(callback);return socket;},timeout(){return socket;},emit(event,value,callback){if(event==='reaction')for(const cb of handlers.reaction||[])cb({name:'Alex Morgan',emoji:value});if(typeof callback==='function')callback(null,{ok:true});},disconnect(){}};setTimeout(()=>{for(const cb of handlers.connect||[])cb();for(const cb of handlers.roster||[])cb([]);},20);return socket;};` });
    if (target.startsWith('/api/')) {
      const body = route.request().postDataJSON() || {};
      let data = {};
      if (target === '/api/meetings' && route.request().method() === 'POST') data = { meetingId: id, participantId: '22222222-2222-4222-8222-222222222222', token: 'e30.' + claims + '.preview' };
      else if (target === '/api/meetings/' + id) data = { title: 'Product design review', meeting_code: '123456789012', notes: '', messages: [], polls: [], locked };
      else if (target === '/api/config') data = { iceServers: [] };
      else if (target.endsWith('/lock')) { locked = body.locked; data = { ok: true, locked }; }
      else if (target.endsWith('/more/permissions')) { permissions = body; data = { ok: true }; }
      else if (target.endsWith('/more/questions') && route.request().method() === 'POST') { questions.push({ id: '33333333-3333-4333-8333-333333333333', question: body.question, author: 'Alex Morgan', own: true, status: manager ? 'published' : 'pending', votes: 0, voted: false, answer: '' }); data = { ok: true, pending: !manager }; }
      else if (target.endsWith('/more')) data = { available, occurrenceId: '44444444-4444-4444-8444-444444444444', canManage: manager, isHost: manager, permissions, questions, participants: [], events: [{ event_type: 'meeting.created', created_at: '2026-11-14T15:00:00Z' }] };
      else throw Error('Unexpected preview API request: ' + target);
      return route.fulfill({ json: data });
    }
    if (['/styles.css','/more-panel.css','/app.js','/more-panel.js','/more-panel.html'].includes(target)) return route.fulfill({ path: path.join(directory, target.slice(1)) });
    if (target === '/preview-meet') return route.fulfill({ path: path.join(directory, 'index.html') });
    if (target === '/favicon.ico') return route.fulfill({ status: 204 });
    throw Error('Unexpected preview resource: ' + target);
  });
  await page.goto('/preview-meet');
  await page.locator('#displayName').fill('Alex Morgan');
  await page.locator('#createBtn').click();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#more-status')).toHaveText(available ? /Meeting tools ready/ : /Some tools are unavailable/);
  await page.getByRole('tab', { name: 'More', exact: true }).click();
}

test('compact More preserves all five tabs, host controls and truthful feature availability', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await preview(page);
  await expect(page.getByRole('tab')).toHaveCount(5);
  await expect(page.locator('.more-group')).toHaveCount(5);
  await expect(page.locator('.more-group[open]')).toHaveCount(1);
  await page.getByRole('tab', { name: 'More', exact: true }).press('Home');
  await expect(page.getByRole('tab', { name: 'Chat', exact: true })).toHaveAttribute('aria-selected','true');
  await page.getByRole('tab', { name: 'Chat', exact: true }).press('End');
  await expect(page.getByRole('tab', { name: 'More', exact: true })).toHaveAttribute('aria-selected','true');
  await expect(page.locator('#recordBtn')).toBeDisabled();
  await page.getByRole('button', { name: 'Thumbs up', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('👍');
  await page.locator('.more-group > summary').filter({ hasText: 'Meeting management' }).click();
  await page.locator('#more-guest-chat').uncheck();
  await expect(page.locator('#toast')).toContainText('permissions updated');
  await expect(page.locator('#chatText')).toBeEnabled();
  await page.locator('.more-group > summary').filter({ hasText: 'Security & recording' }).click();
  await page.locator('#more-lock').check();
  await expect(page.locator('#toast')).toContainText('Current participants stay connected');
  await page.locator('.more-group > summary').filter({ hasText: 'Meeting intelligence' }).click();
  await expect(page.locator('.more-tool').filter({ hasText: 'QorllaMate AI' }).locator('button')).toBeDisabled();
  await page.locator('.more-group > summary').filter({ hasText: 'Tools & settings' }).click();
  await page.locator('#more-focus').check();
  await expect(page.locator('body')).toHaveClass(/meet-focus/);
  await page.locator('#more-refresh-diagnostics').click();
  await expect(page.locator('#more-diagnostics')).toContainText('No remote media sample');
  await expect.poll(() => page.evaluate(() => window.__recordingStarted)).toBe(false);
  await page.locator('#more-focus').uncheck();
  await page.evaluate(() => { for (const group of document.querySelectorAll('.more-group')) group.open = false; document.querySelector('.more-group').open = true; document.querySelector('#tab-more').scrollTop = 0; });
  await expect(page.locator('#toast')).toBeHidden();
  fs.mkdirSync(path.resolve(__dirname,'../evidence/meet-more-v4.1'),{recursive:true});
  await page.screenshot({path:path.resolve(__dirname,'../evidence/meet-more-v4.1/desktop.png')});
  expect(errors).toEqual([]);
});

test('participant Q&A treats submitted text as text and keeps host tools private on a phone layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await preview(page,'guest');
  await expect(page.locator('#more-manager-controls')).toBeHidden();
  await page.locator('.more-group > summary').filter({hasText:'Collaboration'}).click();
  await page.locator('#more-qa-toggle').click();
  await page.locator('#more-question').fill('<img src=x onerror=alert(1)> What is next?');
  await page.locator('#more-question-form button').click();
  await expect(page.locator('#more-questions')).toContainText('<img src=x onerror=alert(1)> What is next?');
  await expect(page.locator('#more-questions img')).toHaveCount(0);
  await expect(page.locator('#more-questions')).toContainText('pending');
  await expect(page.getByRole('button',{name:'Publish',exact:true})).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => { for(const group of document.querySelectorAll('.more-group'))group.open=false;document.querySelector('#tab-more').scrollTop=0; });
  await expect(page.locator('#toast')).toBeHidden();
  fs.mkdirSync(path.resolve(__dirname,'../evidence/meet-more-v4.1'),{recursive:true});
  await page.screenshot({path:path.resolve(__dirname,'../evidence/meet-more-v4.1/mobile.png')});
});

test('Q&A stays visibly disabled when its meeting service is unavailable',async({page})=>{
  await preview(page,'guest',false);
  await expect(page.locator('#more-qa-toggle')).toBeDisabled();
  await expect(page.getByRole('button',{name:'Thumbs up',exact:true})).toBeEnabled();
});
