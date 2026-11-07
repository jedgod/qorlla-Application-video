const { test, expect } = require('@playwright/test');

// Workspace overview (the AI panel): layout, Chat History drawer, the + menu and the All sources menu, exactly as specified.
// Server-side behaviour of the switches (CSRF, enforcement, persistence) is covered in qorlla-sources*.spec.js.

const PASSWORD = 'Overview-test-5521!';
const API = '/api/workplace/ai';
const uname = () => 'ov' + Math.random().toString(36).slice(2, 12);

async function signUp(request) {
  const username = uname();
  const r = await request.post('/api/auth/register', { data: { username, password: PASSWORD } });
  expect(r.status()).toBe(201);
  return username;
}
const width = async (loc) => Math.round((await loc.boundingBox()).width);

test.describe('Layout: the overview grows to the left and the workspace page gives up the same width', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('wider than the old 330px by default; dragging the left edge trades width with the workspace page; limits, keyboard, reset and memory', async ({ page }) => {
    await signUp(page.request);
    await page.goto('/qorlla.html');
    const panel = page.locator('#aiPanel'), center = page.locator('.center'), bar = page.locator('#aiResize');
    await expect(panel).toBeVisible();

    const w0 = await width(panel), c0 = await width(center);
    expect(w0).toBeGreaterThan(330);
    expect(Math.abs(w0 - 420)).toBeLessThanOrEqual(2);

    // drag the left edge 100px further left
    const b = await bar.boundingBox(), y = b.y + b.height / 2, x = b.x + b.width / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 100, y, { steps: 6 }); await page.mouse.up();
    const w1 = await width(panel), c1 = await width(center);
    expect(Math.abs(w1 - (w0 + 100))).toBeLessThanOrEqual(2);
    expect(Math.abs((c0 - c1) - (w1 - w0))).toBeLessThanOrEqual(2);              // the workspace page shrank by exactly what the panel gained
    await expect(bar).toHaveAttribute('aria-valuenow', String(w1));

    // limits: never narrower than 300, never wider than 720 (60% of the window at most)
    let nb = await bar.boundingBox();
    await page.mouse.move(nb.x + 3, y); await page.mouse.down(); await page.mouse.move(5, y, { steps: 8 }); await page.mouse.up();
    expect(await width(panel)).toBe(720);
    nb = await bar.boundingBox();
    await page.mouse.move(nb.x + 3, y); await page.mouse.down(); await page.mouse.move(1390, y, { steps: 8 }); await page.mouse.up();
    expect(await width(panel)).toBe(300);

    // keyboard
    await bar.focus();
    await page.keyboard.press('ArrowLeft'); expect(await width(panel)).toBe(324);
    await page.keyboard.press('Shift+ArrowLeft'); expect(await width(panel)).toBe(404);
    await page.keyboard.press('ArrowRight'); expect(await width(panel)).toBe(380);
    await page.keyboard.press('End'); expect(await width(panel)).toBe(720);
    await page.keyboard.press('Home'); expect(await width(panel)).toBe(300);

    // remembered across a reload, and a double-click restores the default
    await page.keyboard.press('Shift+ArrowLeft');                                   // 380
    await page.reload();
    expect(await width(page.locator('#aiPanel'))).toBe(380);
    await page.locator('#aiResize').dblclick();
    expect(Math.abs((await width(page.locator('#aiPanel'))) - 420)).toBeLessThanOrEqual(2);
  });

  test('the workspace page never overflows at 1200px with the default panel', async ({ page }) => {
    await signUp(page.request);
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto('/qorlla.html');
    await expect(page.locator('#aiPanel')).toBeVisible();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over).toBeLessThanOrEqual(0);
    expect(await width(page.locator('.center'))).toBeGreaterThan(450);
  });
});

test.describe('Chat History, the + menu and All sources', () => {
  test.use({ viewport: { width: 1400, height: 900 } });
  const drawer = (page) => page.locator('#aiDrawer');

  test('hamburger opens "Chat History" with a close X; X, Escape and the backdrop all close it', async ({ page }) => {
    await signUp(page.request);
    await page.goto('/qorlla.html');
    const menu = page.locator('#aiMenu');
    // the hamburger sits at the left of the header, before the sparkle and the title
    const mb = await menu.boundingBox(), tb = await page.locator('#aiPanel .assistant-name').boundingBox();
    expect(mb.x).toBeLessThan(tb.x);
    await expect(menu).toHaveAttribute('aria-label', 'Chat history');

    await menu.click();
    await expect(drawer(page)).toBeVisible();
    await expect(drawer(page).locator('.dh')).toContainText('Chat History');
    await expect(drawer(page).getByText('No chats yet.')).toBeVisible();
    const x = page.getByRole('button', { name: 'Close chat history' });
    await expect(x).toBeVisible();
    await x.click();
    await expect(drawer(page)).toBeHidden();

    await menu.click(); await expect(drawer(page)).toBeVisible();
    await page.keyboard.press('Escape'); await expect(drawer(page)).toBeHidden();

    await menu.click(); await expect(drawer(page)).toBeVisible();
    const pb = await page.locator('#aiPanel').boundingBox();
    await page.mouse.click(pb.x + pb.width - 12, pb.y + 300);                     // the dimmed area to the right of the drawer
    await expect(drawer(page)).toBeHidden();
  });

  test('"Summarize my week" appears in history with a "..." menu: Rename, Open in browser, Delete', async ({ page, context }) => {
    await signUp(page.request);
    await page.goto('/qorlla.html');
    await page.locator('#sugWeek').click();
    await expect(page.locator('#aiThread .bubble.ai').first()).toBeVisible();

    await page.locator('#aiMenu').click();
    const row = page.locator('.hist-row').first();
    await expect(row.locator('.t')).toHaveText('Summarize my week');
    await row.hover();
    await row.locator('.more').click();
    const pop = page.locator('#aiRowPop');
    await expect(pop).toBeVisible();
    await expect(pop.getByRole('menuitem')).toHaveText(['Rename', 'Open in browser', 'Delete']);

    // Rename
    await pop.getByRole('menuitem', { name: 'Rename' }).click();
    const input = page.locator('.hist-row input.rename');
    await expect(input).toBeFocused();
    await input.fill('Weekly recap'); await input.press('Enter');
    await expect(page.locator('.hist-row .t').first()).toHaveText('Weekly recap');
    await expect.poll(async () => (await (await page.request.get(API + '/chats')).json()).chats.map((c) => c.title)).toEqual(['Weekly recap']);

    // Open in browser: a new tab that loads this very chat
    await page.locator('.hist-row').first().hover();
    await page.locator('.hist-row .more').first().click();
    const [tab] = await Promise.all([context.waitForEvent('page'), page.locator('#aiRowPop').getByRole('menuitem', { name: 'Open in browser' }).click()]);
    await tab.waitForLoadState('domcontentloaded');
    expect(tab.url()).toMatch(/[?&]aichat=c[a-z0-9]+/);
    await expect(tab.locator('#aiThread .bubble.me').first()).toHaveText('Summarize my week');
    await tab.close();

    // Delete asks first; Cancel keeps it, Delete removes it here and on the server
    await page.locator('.hist-row').first().hover();
    await page.locator('.hist-row .more').first().click();
    await page.locator('#aiRowPop').getByRole('menuitem', { name: 'Delete' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete conversation?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('.hist-row')).toHaveCount(1);
    await page.locator('.hist-row').first().hover();
    await page.locator('.hist-row .more').first().click();
    await page.locator('#aiRowPop').getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('.hist-row')).toHaveCount(0);
    await expect(page.getByText('No chats yet.')).toBeVisible();
    await expect.poll(async () => (await (await page.request.get(API + '/chats')).json()).chats.length).toBe(0);
  });

  test('"+" offers Add data and files (a chosen file becomes a removable chip)', async ({ page }) => {
    await signUp(page.request);
    await page.goto('/qorlla.html');
    await expect(page.locator('#aiInput')).toHaveAttribute('placeholder', 'Write a message or type @ for context');
    await page.locator('#aiPlus').click();
    await expect(page.locator('#aiPlusPop').getByRole('menuitem')).toHaveText(['Add data and files']);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: 'Add data and files' }).click()]);
    await chooser.setFiles({ name: 'budget.txt', mimeType: 'text/plain', buffer: Buffer.from('q4') });
    const chip = page.locator('.ai-chip', { hasText: 'budget.txt' });
    await expect(chip).toBeVisible();
    await chip.getByRole('button', { name: 'Remove budget.txt' }).click();
    await expect(page.locator('.ai-chip')).toHaveCount(0);
  });

  test('the hourglass opens "All sources": a master "Qorlla Sources" switch, an expander and one switch per source, saved on the server', async ({ page }) => {
    await signUp(page.request);
    await page.goto('/qorlla.html');
    const trigger = page.locator('#aiSources');
    await expect(trigger).toHaveText('⏳');
    await expect(trigger).toHaveAttribute('aria-label', 'All sources');
    await trigger.click();
    const pop = page.locator('#aiSrcPop');
    await expect(pop).toBeVisible();
    const master = pop.getByRole('switch', { name: /^Qorlla Sources/ });
    await expect(master).toHaveAttribute('aria-checked', 'true');
    await expect(pop.locator('.src-peek')).toBeVisible();                           // icon preview with a "+N" count
    await expect(pop.getByRole('switch', { name: /^Meetings/ })).toHaveCount(0);   // collapsed until the arrow is used
    await pop.getByRole('button', { name: 'Show sources' }).click();
    for (const n of ['Meetings', 'Canvas', 'Chat', 'My Notes']) await expect(pop.getByRole('switch', { name: new RegExp('^' + n) })).toHaveAttribute('aria-checked', 'true');

    // a switch changes the stored setting, and the server then refuses that source to the assistant
    await pop.getByRole('switch', { name: /^Meetings/ }).click();
    await expect(pop.getByRole('switch', { name: /^Meetings/ })).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => (await (await page.request.get(API + '/sources')).json()).sources.meetings).toBe(false);
    expect((await page.request.get(API + '/context/meetings')).status()).toBe(403);
    expect((await page.request.get(API + '/context/my_notes')).status()).toBe(200);

    // closing it by clicking elsewhere and by Escape
    await page.locator('#aiPanel .assistant-name').click();                          // the expanded list may cover the text box, so click a neutral spot
    await expect(pop).toBeHidden();
    await trigger.click(); await expect(pop).toBeVisible();
    await page.keyboard.press('Escape'); await expect(pop).toBeHidden();
  });
});
