import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { deployedSecurityHeaders } from '../support/response-security';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/anthropic-account-enrollment.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/anthropic-account-enrollment.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
});
test.use({ baseURL: 'https://mitzo-ui.test' });
for (const theme of ['light', 'dark'] as const) {
  // The real Connections route owns discovery/retry/save coverage in
  // api-account-enrollment.spec.ts. This isolated form only qualifies the
  // narrower 320px viewport and alternate font/accent combination.
  test(`isolated Messages form retains narrow consent and keyboard focus: ${theme}`, async ({
    page,
  }, info) => {
    const compiled = await bundle;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 320, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://mitzo-ui.test') return route.abort();
      if (url.pathname === '/fixture.js' || url.pathname === '/fixture.css')
        return route.fulfill({
          body: compiled.outputFiles!.find((file) =>
            file.path.endsWith(url.pathname.endsWith('.js') ? '.js' : '.css'),
          )!.text,
          contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css',
        });
      if (url.pathname === '/api/connections/openai-accounts' && route.request().method() === 'GET')
        return route.fulfill({ json: { enabled: true, accounts: [] } });
      if (url.pathname.startsWith('/api/'))
        return route.fulfill({ status: 404, json: { error: 'Unexpected fixture request' } });
      return route.fulfill({
        contentType: 'text/html',
        headers: deployedSecurityHeaders(),
        body: `<html data-theme="${theme}" data-accent="${theme === 'dark' ? 'lavender' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      });
    });
    await page.goto('/');
    await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('enmaas');
    await page.getByRole('combobox', { name: 'Model API', exact: true }).selectOption('messages');
    await expect(page.getByLabel('Additional model IDs')).toHaveValue('');
    await expect(page.getByText(/existing Claude Agent SDK/)).toBeVisible();
    await page.getByLabel('Account label', { exact: true }).fill('EnMaaS Claude');
    await page.getByLabel('Intended work project name').fill('Work');
    await page.getByLabel('API key', { exact: true }).fill('synthetic-key');
    await page.getByLabel('Additional model IDs').fill('hosted/omitted');
    const submit = page.getByRole('button', { name: 'Save API account', exact: true });
    await expect(submit).toBeDisabled();
    await page.getByRole('checkbox').check();
    const consentCopy = await page
      .getByRole('checkbox')
      .locator('..')
      .locator('span')
      .boundingBox();
    expect(consentCopy!.width).toBeGreaterThan(100);
    expect(consentCopy!.x + consentCopy!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await submit.focus();
    await expect(submit).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await submit.scrollIntoViewIfNeeded();
    expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: info.outputPath('connections-anthropic-account-enrollment.png'),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
}
