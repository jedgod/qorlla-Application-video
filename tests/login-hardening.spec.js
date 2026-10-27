const { test, expect } = require('@playwright/test');

// Phase B coverage for login.html: loads cleanly, validation, safe errors, language switching, session + logout.

test('login page loads without JavaScript errors or failed same-origin requests', async ({ page }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  page.on('response', (r) => { if (r.url().startsWith('http://localhost') && r.status() >= 400 && !r.url().includes('/api/auth/me')) problems.push(r.status() + ' ' + r.url()); });
  await page.goto('/login.html?standalone=1');
  await expect(page.locator('#tabIn')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#form')).toBeVisible();
  expect(problems).toEqual([]);
});

test('sign-in and sign-up navigation, required fields and minimum password length are enforced', async ({ page }) => {
  await page.goto('/login.html?standalone=1');
  await expect(page.locator('#username')).toHaveAttribute('required', '');
  await expect(page.locator('#password')).toHaveAttribute('required', '');
  await page.locator('#tabUp').click();
  await expect(page.locator('#displayName')).toBeVisible();
  await expect(page.locator('#password')).toHaveAttribute('minlength', '8');
  await page.locator('#tabIn').click();
  await expect(page.locator('#displayName')).toBeHidden();
  // Submitting an empty form must not reach the server (native validation blocks it)
  let posted = false;
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/auth/')) posted = true; });
  await page.locator('#go').click();
  expect(posted).toBe(false);
});

test('failed sign-in shows a safe, non-enumerating message', async ({ page }) => {
  await page.goto('/login.html?standalone=1');
  await page.locator('#username').fill('no_such_user_' + Date.now());
  await page.locator('#password').fill('Wrong-password-123!');
  await page.locator('#go').click();
  const err = page.locator('#err');
  await expect(err).toBeVisible();
  const text = (await err.textContent()).toLowerCase();
  expect(text).toMatch(/wrong|incorrect|invalid/);
  expect(text).not.toMatch(/no such user|not found|does not exist|stack|sql|exception/);
});

test('language switching updates the login page and persists', async ({ page }) => {
  await page.goto('/login.html?standalone=1');
  await page.locator('[data-language-select]').selectOption('fr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.locator('#tabIn')).toHaveText('Se connecter');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
});

test('session is created on registration and destroyed on logout', async ({ page, request }) => {
  const username = 'qa_' + Date.now().toString().slice(-10);
  const reg = await page.request.post('/api/auth/register', { data: { username, displayName: 'Session QA', password: 'Session-test-9917!' } });
  expect(reg.status()).toBe(201);
  expect((await (await page.request.get('/api/auth/me')).json()).user.username).toBe(username);
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => /sess|sid|qorlla/i.test(c.name)) || cookies[0];
  expect(session, 'a session cookie is set').toBeTruthy();
  expect(session.httpOnly).toBe(true);
  expect(session.sameSite).not.toBe('None');
  const out = await page.request.post('/api/auth/logout');
  expect(out.status()).toBeLessThan(400);
  expect((await (await page.request.get('/api/auth/me')).json()).user).toBeNull();
  // Unauthenticated access to private data is refused after logout
  expect((await page.request.get('/api/workplace/schedule')).status()).toBe(401);
});
