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
  test(`EnMaaS Claude uses shared account setup: ${theme}`, async ({ page, isMobile }, info) => {
    const compiled = await bundle;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    let attempts = 0,
      saved = false;
    const account = {
      id: 'fixture-anthropic',
      label: 'EnMaaS Claude',
      projectLabel: 'Work',
      state: 'ready',
    };
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
      if (url.pathname === '/api/connections/api-models') {
        expect(route.request().postDataJSON()).toMatchObject({
          endpoint: 'https://api.enmaas.devshift.net',
          protocol: 'messages',
          authentication: 'bearer',
          apiKey: 'synthetic-key',
        });
        if (++attempts === 1)
          return route.fulfill({ status: 422, json: { error: 'Catalog unavailable' } });
        return route.fulfill({
          json: { models: [{ id: 'hosted/sonnet', label: 'Hosted Sonnet' }], partial: true },
        });
      }
      if (url.pathname === '/api/connections/openai-accounts') {
        if (route.request().method() === 'POST') {
          expect(route.request().postDataJSON()).toMatchObject({
            connection: { protocol: 'messages', authentication: 'bearer' },
            models: [
              { id: 'hosted/sonnet', label: 'Hosted Sonnet' },
              { id: 'hosted/omitted', label: 'hosted/omitted' },
            ],
          });
          saved = true;
          return route.fulfill({ status: 201, json: { account } });
        }
        return route.fulfill({ json: { enabled: true, accounts: saved ? [account] : [] } });
      }
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
    await page.getByRole('button', { name: 'Get models', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Could not read the provider catalog');
    await page.getByRole('button', { name: 'Get models', exact: true }).click();
    await page
      .getByRole('listbox', { name: 'Available models', exact: true })
      .selectOption('hosted/sonnet');
    await page.getByLabel('Additional model IDs').fill('hosted/omitted');
    const submit = page.getByRole('button', { name: 'Save API account', exact: true });
    await expect(submit).toBeDisabled();
    await page.getByRole('checkbox').check();
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
    await submit.click();
    await expect(page.getByText('EnMaaS Claude is ready for new chats.')).toBeVisible();
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('synthetic-key');
    expect(errors).toEqual([]);
  });
}
