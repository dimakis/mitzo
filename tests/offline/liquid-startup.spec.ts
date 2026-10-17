import { test, expect, type Page, type Route } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const catalog = JSON.parse(readFileSync('content/quotes/catalog.json', 'utf8'));
const bundle = build({
  entryPoints: [resolve('tests/fixtures/liquid-startup.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-liquid-startup.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  external: ['/mitzo-wordmark.png'],
  alias: { '@mitzo/protocol': resolve('packages/protocol/src/index.ts') },
});
async function fixture(page: Page, theme: string) {
  const files = (await bundle).outputFiles!;
  let auth: Route | undefined;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (url.pathname === '/api/auth/check') {
      auth = route;
      return;
    }
    if (url.pathname === '/api/home/quote')
      return route.fulfill({ json: { date: url.searchParams.get('date'), quote: catalog[4] } });
    if (url.pathname === '/mitzo-wordmark.png')
      return route.fulfill({
        contentType: 'image/png',
        body: readFileSync('frontend/public/mitzo-wordmark.png'),
      });
    const file = files.find(
      (f) => url.pathname === (f.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
    );
    if (file)
      return route.fulfill({
        body: file.text,
        contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
      });
    if (url.pathname !== '/') return route.abort();
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'georgia' : 'system'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
    });
  });
  return {
    errors,
    respond: async (status = 200) => {
      await expect.poll(() => !!auth).toBe(true);
      const route = auth!;
      auth = undefined;
      await route.fulfill({ status, json: { ok: status === 200 } });
    },
  };
}
for (const theme of ['dark', 'light']) {
  test(`liquid startup: fall, quote, retry and home handoff (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const app = await fixture(page, theme);
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
    await page.goto('/?cached');
    await expect(page.getByTestId('startup-screen')).toBeVisible();
    await expect(page.locator('#root')).toHaveAttribute('inert', '');
    await expect(page.locator('.startup-liquid canvas')).toBeVisible();
    const phrase = await page.getByTestId('startup-phrase').textContent();
    await page.waitForTimeout(750);
    await page.screenshot({ path: info.outputPath(`liquid-rebound-${theme}.png`) });
    await expect(page.locator('.startup-wordmark')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`liquid-logo-${theme}.png`) });
    await expect(page.getByRole('blockquote')).toBeVisible();
    await expect(page.getByRole('blockquote')).toContainText(catalog[4].text);
    await page.waitForTimeout(500);
    await page.screenshot({ path: info.outputPath(`liquid-quote-${theme}.png`) });
    await app.respond(503);
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await page.getByRole('button', { name: 'Retry' }).focus();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('startup-phrase')).toHaveText(phrase!);
    await app.respond();
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    await expect(page.getByTestId('startup-screen')).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Ask Mitzo' }).fill('Ready immediately');
    await expect(page.getByRole('textbox', { name: 'Ask Mitzo' })).toHaveValue('Ready immediately');
    await expect(page.locator('.startup-quote-flight')).toHaveCount(0);
    expect(app.errors).toEqual([]);
  });
}
test('liquid startup: reduced motion, offline first launch and expired login', async ({ page }) => {
  const app = await fixture(page, 'dark');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await page.evaluate(() => (document.documentElement.style.fontSize = '24px'));
  await expect(page.getByRole('blockquote')).toBeVisible();
  await expect(page.locator('.startup-liquid canvas')).toBeHidden();
  expect(
    await page.locator('.startup-screen').evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await app.respond(503);
  const retry = page.getByRole('button', { name: 'Retry' });
  await retry.scrollIntoViewIfNeeded();
  await expect(retry).toBeInViewport();
  expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await retry.click();
  await app.respond(401);
  await expect(page.getByRole('heading', { name: 'Sign in to Mitzo' })).toBeVisible();
  await expect(page.getByTestId('startup-screen')).toHaveCount(0);
  expect(app.errors).toEqual([]);
});
test('liquid startup: fast authentication skips the rest of the animation', async ({ page }) => {
  const app = await fixture(page, 'light');
  await page.goto('/');
  await app.respond();
  await expect(page.getByTestId('startup-screen')).toHaveCount(0, { timeout: 700 });
  await expect(page.getByRole('textbox', { name: 'Ask Mitzo' })).toBeVisible();
});
