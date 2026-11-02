const { test, expect } = require('@playwright/test');

const APP_URL = '/index.html';

test.use({
  permissions: ['camera', 'microphone'],
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--disable-features=WebRtcHideLocalIpsWithMdns'
    ]
  }
});

test.describe('Live meeting flow (two browsers)', () => {
  test('host and guest connect, see video, chat, react, and end the meeting', async ({ browser, baseURL }) => {
    test.setTimeout(120000);
    const hostCtx = await browser.newContext({ baseURL });
    const guestCtx = await browser.newContext({ baseURL });
    const host = await hostCtx.newPage();
    const guest = await guestCtx.newPage();

    await host.goto(APP_URL);
    await expect(host.locator('#connText')).toHaveText('Server online');
    await host.fill('#displayName', 'Host Hannah');
    await host.click('#startMeetingBtn');
    await expect(host.locator('#meetingBar')).toBeVisible();
    const meetingId = (await host.locator('#meetingIdLabel').textContent()).trim();
    expect(meetingId).toMatch(/^\d{3} \d{4} \d{4}$/);
    await expect(host.locator('#endCallBtn')).toHaveText('End for Everyone');

    await guest.goto(APP_URL);
    await guest.fill('#displayName', 'Guest Gary');
    await guest.fill('#meetingIdInput', meetingId);
    await guest.click('#joinMeetingBtn');
    await expect(guest.locator('#meetingBar')).toBeVisible();

    // Both sides render two tiles and receive the other side's live video
    for (const page of [host, guest]) {
      await expect(page.locator('#videoGrid .tile')).toHaveCount(2);
      await expect.poll(() => page.evaluate(() => {
        const v = document.querySelector('.tile:not(.local) video');
        return v ? v.videoWidth : 0;
      }), { timeout: 20000 }).toBeGreaterThan(0);
    }
    await expect(guest.locator('.tile:not(.local) .name')).toContainText('Host Hannah');

    // Chat is delivered to the other participant
    await host.click('#openDrawerBtn');
    await host.fill('#zoom-chat-input-field', 'Hello from the host');
    await host.click('#zoom-chat-send-trigger');
    await guest.click('#openDrawerBtn');
    await expect(guest.locator('#zoom-chat-message-stream')).toContainText('Hello from the host');

    // Raised hand and mic state propagate
    await guest.click('#handBtn');
    await expect(host.locator('.tile:not(.local) .hand')).toBeVisible();
    await guest.click('#micBtn');
    await expect(guest.locator('#micBtn')).toHaveAttribute('aria-pressed', 'false');
    await expect(host.locator('.tile:not(.local) .mic')).toContainText('\uD83D\uDD07');

    // Shared notes sync
    await host.fill('#telemetryWorkspaceNotes', 'Agenda: thesis review');
    await expect(guest.locator('#telemetryWorkspaceNotes')).toHaveValue('Agenda: thesis review', { timeout: 5000 });

    // Host mutes guest from the People tab
    await guest.click('#micBtn');
    await expect(guest.locator('#micBtn')).toHaveAttribute('aria-pressed', 'true');
    await host.click('#peopleBtn');
    await host.locator('#peopleList li', { hasText: 'Guest Gary' }).locator('button:has-text("Mute")').click();
    await expect(guest.locator('#micBtn')).toHaveAttribute('aria-pressed', 'false');

    // Own row toggles the mic, and the host can request an unmute
    await guest.click('#peopleBtn');
    await guest.locator('#peopleList li', { hasText: '(You)' }).locator('button:has-text("Unmute")').click();
    await expect(guest.locator('#micBtn')).toHaveAttribute('aria-pressed', 'true');
    await guest.locator('#peopleList li', { hasText: '(You)' }).locator('button:has-text("Mute")').click();
    await expect(guest.locator('#micBtn')).toHaveAttribute('aria-pressed', 'false');
    await host.locator('#peopleList li', { hasText: 'Guest Gary' }).locator('button:has-text("Ask to unmute")').click();
    await expect(guest.locator('#toasts')).toContainText('asks you to unmute');

    // Full screen toggles without freezing the page and Esc exits
    await host.click('#fullscreenBtn');
    await expect(host.locator('#stage')).toHaveClass(/expanded/);
    await host.click('#micBtn');
    await host.keyboard.press('Escape');
    await expect(host.locator('#stage')).not.toHaveClass(/expanded/);
    await host.click('#micBtn');

    // Host ends the meeting for everyone
    await host.click('#endCallBtn');
    await expect(host.locator('#joinBar')).toBeVisible();
    await expect(guest.locator('#joinBar')).toBeVisible();
    await expect(guest.locator('#videoGrid .tile')).toHaveCount(1);

    await hostCtx.close();
    await guestCtx.close();
  });

  test('guest cannot join an unknown meeting', async ({ page }) => {
    await page.goto(APP_URL);
    await page.fill('#meetingIdInput', '000 0000 0000');
    await page.click('#joinMeetingBtn');
    await expect(page.locator('#toasts')).toContainText('invalid or has ended');
    await expect(page.locator('#joinBar')).toBeVisible();
  });

  test('scheduler asks anonymous visitors to sign in; signed-in accounts see live slots', async ({ page }) => {
    await page.goto(APP_URL);
    await page.fill('#slotDate', '2026-10-22');
    await page.locator('#slotDate').dispatchEvent('change');
    await expect(page.locator('#slotHint')).toContainText('Sign in with a Qorlla account');
    await expect(page.locator('#slotRows tr')).toHaveCount(0);
  });

  test('scheduler loads live slots and rejects a conflicting booking', async ({ page }) => {
    const username = ('sched' + Math.random().toString(36).slice(2, 9)).slice(0, 20);
    const reg = await page.request.post('/api/auth/register', { data: { username, displayName: 'Scheduler QA', password: 'Sched-test-9917!x' } });
    expect(reg.status()).toBe(201);
    await page.goto(APP_URL);
    await page.fill('#slotDate', '2026-10-22');
    await page.locator('#slotDate').dispatchEvent('change');
    await expect(page.locator('#slotRows tr').first()).toBeVisible();
    await expect(page.locator('#slotRows button:has-text("Book")').first()).toBeVisible();
    await expect(page.locator('#slotRows td:has-text("Booked")').first()).toBeVisible();

    await page.selectOption('#slotFilter', 'available');
    await expect(page.locator('#slotRows td:has-text("Booked")')).toHaveCount(0);
    await page.selectOption('#slotFilter', 'all');
    const oneDay = await page.locator('#slotRows tr').count();
    await page.selectOption('#slotRange', 'week');
    await expect.poll(() => page.locator('#slotRows tr').count()).toBeGreaterThan(oneDay);

    await page.click('#schedToggle');
    await expect(page.locator('#schedBody')).toBeHidden();
    await page.click('#schedToggle');
    await expect(page.locator('#schedBody')).toBeVisible();
  });
});
