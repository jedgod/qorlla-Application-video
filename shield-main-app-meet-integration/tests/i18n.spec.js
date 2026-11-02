const { test, expect } = require('@playwright/test');

for (const language of [
  { locale: 'es', signIn: 'Iniciar sesión', create: 'Crear cuenta', placeholder: 'Cómo aparece tu nombre en el chat' },
  { locale: 'fr', signIn: 'Se connecter', create: 'Créer un compte', placeholder: 'Votre nom dans la discussion' },
  { locale: 'pt-PT', signIn: 'Iniciar sessão', create: 'Criar conta', placeholder: 'Como o seu nome aparece na conversa' }
]) {
  test(language.locale + ' selection persists across pages and translates dynamic account labels', async ({ page }) => {
    await page.goto('/login.html?standalone=1');
    await page.evaluate(() => localStorage.removeItem('qorlla.locale'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.locator('[data-language-select]').selectOption(language.locale);
    await expect(page.locator('html')).toHaveAttribute('lang', language.locale);
    await expect(page.locator('#tabIn')).toHaveText(language.signIn);
    await page.locator('#tabUp').click();
    await expect(page.locator('#go')).toHaveText(language.create);
    await expect(page.locator('#displayName')).toHaveAttribute('placeholder', language.placeholder);
    await page.goto('/index.html');
    await expect(page.locator('html')).toHaveAttribute('lang', language.locale);
    await expect(page.locator('[data-language-select]')).toHaveValue(language.locale);
    expect(await page.evaluate(() => I18n.date('2026-10-21T12:00:00Z', { month: 'long', timeZone: 'UTC' })))
      .toBe(new Intl.DateTimeFormat(language.locale, { month: 'long', timeZone: 'UTC' }).format(new Date('2026-10-21T12:00:00Z')));
    await page.locator('[data-language-select]').selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
}

test('translation falls back, interpolates, and never translates unmarked content', async ({ page }) => {
  await page.goto('/login.html?standalone=1');
  const result = await page.evaluate(() => {
    I18n.setLocale('es');
    const node = document.createElement('p');
    node.textContent = 'Today';
    document.body.append(node);
    return { fallback: I18n.t('Unknown key'), interpolation: I18n.t('Hello {name}', { name: '<Ana>' }), number: I18n.number(1234.5), content: node.textContent };
  });
  expect(result.fallback).toBe('Unknown key');
  expect(result.interpolation).toBe('Hello <Ana>');
  expect(result.content).toBe('Today');
  expect(result.number).toContain(',5');
});

for (const preference of [
  { browser: 'fr-CA', expected: 'fr', signIn: 'Se connecter' },
  { browser: 'pt-PT', expected: 'pt-PT', signIn: 'Iniciar sessão' }
]) {
  test('detects browser preference ' + preference.browser, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ locale: preference.browser, baseURL });
    try {
      const page = await context.newPage();
      await page.goto('/login.html?standalone=1');
      await expect(page.locator('html')).toHaveAttribute('lang', preference.expected);
      await expect(page.locator('#tabIn')).toHaveText(preference.signIn);
    } finally { await context.close(); }
  });
}

test('all translated catalogs have matching keys and preserve existing catalogs', async () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const context = { window: {} };
  for (const locale of ['es', 'fr', 'pt-PT']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../locales', locale + '.js'), 'utf8'), context);
  }
  const catalogs = context.window.QorllaLocales;
  const keys = Object.keys(catalogs.es).sort();
  for (const locale of ['fr', 'pt-PT']) {
    expect(Object.keys(catalogs[locale]).sort()).toEqual(keys);
    expect(Object.values(catalogs[locale]).every(value => typeof value === 'string' && value.length > 0)).toBe(true);
  }
});
