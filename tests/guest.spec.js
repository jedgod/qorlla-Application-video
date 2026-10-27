const { test, expect } = require('@playwright/test');

async function newMeeting(request, topic) {
  const r = await request.post('/api/meetings/create', { data: { topic, hostId: 'usr_guesttest' } });
  expect(r.ok()).toBeTruthy(); return (await r.json()).meeting;
}

test('Continue without signing in opens Guest Welcome, never the video page', async ({ page }) => {
  const videoRequests = [];
  page.on('request', (r) => { if (/\/index\.html(\?|$)/.test(new URL(r.url()).pathname + new URL(r.url()).search)) videoRequests.push(r.url()); });
  await page.goto('/');
  await page.frameLocator('iframe.login-embed').getByRole('link', { name: 'Continue without signing in' }).click();
  await expect(page).toHaveURL(/\/guest\/welcome$/);
  await expect(page.getByRole('heading', { name: 'Welcome to Qorlla' })).toBeVisible();
  await expect(page.getByText('Guest Mode')).toBeVisible();
  for (const name of ['Join Meeting', 'Explore Qorlla', 'Help & Tutorials', 'Create Account']) await expect(page.getByRole('link', { name: new RegExp(name.replace('&', '&')) }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in to Qorlla Workspace' })).toBeVisible();
  expect(videoRequests).toEqual([]);
});

test('guest tiles lead to their own routes; account links go to the auth entry points', async ({ page }) => {
  await page.goto('/guest/welcome');
  await page.getByRole('link', { name: /Join Meeting/ }).first().click(); await expect(page).toHaveURL(/\/guest\/join-meeting$/); await expect(page.getByRole('heading', { name: 'Join a meeting' })).toBeVisible();
  await page.goto('/guest/explore'); await expect(page.getByRole('heading', { name: 'Explore Qorlla' })).toBeVisible();
  await page.goto('/guest/help'); await expect(page.getByRole('heading', { name: /Help/ })).toBeVisible();
  await page.goto('/guest/welcome'); await page.getByRole('link', { name: /Create Account/ }).first().click(); await expect(page).toHaveURL(/\/qorlla\.html\?tab=up/);
  await expect(page.frameLocator('iframe.login-embed').locator('#tabUp')).toHaveAttribute('aria-selected', 'true');
  await page.goto('/auth/login?next=%2Fguest%2Fmeeting%2F123%2Fprejoin'); await expect(page).toHaveURL(/qorlla\.html\?next=/);
});

test('Join Meeting validates the ID, then the pre-join screen shows the meeting and only then opens the video page', async ({ page, request }) => {
  const m = await newMeeting(request, 'Guest flow check');
  await page.goto('/guest/join-meeting');
  await page.fill('#mid', 'abc'); await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#joinMsg')).toContainText('valid 11-digit');
  await page.fill('#mid', `https://example.test/invite?meeting=${encodeURIComponent(m.meetingId)}`); await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/guest\/meeting\/.+\/prejoin$/);
  await expect(page.locator('#pjTopic')).toContainText('Guest flow check');
  await expect(page.locator('#pjGo')).toBeEnabled();
  await page.getByRole('button', { name: 'Join meeting' }).click(); await expect(page.locator('#pjMsg')).toContainText('display name');
  await page.fill('#pjName', 'Visiting Vera'); await page.getByRole('button', { name: 'Join meeting' }).click();
  await expect(page).toHaveURL(/\/index\.html\?meeting=/); await expect(page.locator('#meetingIdInput')).toHaveValue(m.meetingId);
});

test('a direct invitation link opens the pre-join screen; an invalid one is refused', async ({ page, request }) => {
  const m = await newMeeting(request, 'Invitation landing');
  await page.goto('/guest/meeting/' + encodeURIComponent(m.meetingId) + '/prejoin'); await expect(page.locator('#pjTopic')).toContainText('Invitation landing');
  await page.goto('/guest/meeting/000%200000%200000/prejoin'); await expect(page.locator('#pjTopic')).toContainText('not valid'); await expect(page.locator('#pjGo')).toBeDisabled();
  await expect(page.locator('#pjSignIn')).toHaveAttribute('href', /next=%2Fguest%2Fmeeting%2F/);
});

test('guests cannot reach private workplace data on the server', async ({ request }) => {
  for (const p of ['/api/workplace/chat', '/api/workplace/notes', '/api/workplace/mail', '/api/workplace/calendar', '/api/workplace/schedule', '/api/workplace/whiteboard', '/api/auth/users']) {
    const r = await request.get(p); expect([401, 403], p).toContain(r.status());
  }
  expect((await request.post('/api/workplace/chat', { data: { type: 'group', name: 'x' } })).status()).toBe(401);
});
