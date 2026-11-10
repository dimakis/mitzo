import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

for (const theme of ['light', 'dark'] as const) {
  test(`generic API enrollment discovers models and preserves explicit EnMaaS IDs: ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((theme) => {
      localStorage.setItem('mitzo-theme', theme);
      localStorage.setItem('mitzo-accent', theme === 'light' ? 'teal' : 'mint');
      localStorage.setItem('mitzo-font', theme === 'light' ? 'georgia' : 'system');
    }, theme);
    await page.routeWebSocket('**/*', (socket) => socket.close());
    let discoveryAttempt = 0;
    let enrolled = false;
    const account = {
      id: 'fixture-enmaas',
      label: 'EnMaaS',
      projectLabel: 'Work',
      endpoint: 'https://api.enmaas.devshift.net/v1',
      state: 'ready',
    };
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'mitzo-ui.test') return route.abort();
      const path = url.pathname;
      if (path === '/api/auth/check') return route.fulfill({ json: { authenticated: true } });
      if (path === '/api/connections')
        return route.fulfill({
          json: { connections: [], legacy: [], eligibleAccounts: [], openAIAccountsManaged: true },
        });
      if (path === '/api/connections/templates')
        return route.fulfill({ json: { templates: [], capabilities: [] } });
      if (path === '/api/connections/reauthorize')
        return route.fulfill({ json: { csrf: 'fixture-csrf', expiresAt: Date.now() + 60000 } });
      if (path === '/api/connections/api-models') {
        expect(route.request().postDataJSON()).toEqual({
          csrf: 'fixture-csrf',
          endpoint: account.endpoint,
          apiKey: 'synthetic-key',
        });
        if (++discoveryAttempt === 1)
          return route.fulfill({
            status: 422,
            json: { code: 'CATALOG_UNAVAILABLE', error: 'Catalog unavailable' },
          });
        return route.fulfill({
          json: { models: [{ id: 'paid/model', label: 'Optional paid model' }], partial: true },
        });
      }
      if (path === '/api/connections/openai-accounts') {
        if (route.request().method() === 'POST') {
          const input = route.request().postDataJSON();
          expect(input.connection).toMatchObject({
            endpoint: account.endpoint,
            protocol: 'responses',
            qualification: { source: 'operator', toolCalls: true },
          });
          expect(input.models.map((model: { id: string }) => model.id)).toEqual([
            'rits/zai-org/glm-5-3',
            'rits/deepseek-ai/DeepSeek-V4.1-Flash-1017',
          ]);
          enrolled = true;
          return route.fulfill({ status: 201, json: { account } });
        }
        return route.fulfill({ json: { enabled: true, accounts: enrolled ? [account] : [] } });
      }
      if (path.startsWith('/api/')) return route.fulfill({ json: {} });
      const root = resolve('frontend/dist');
      const file = extname(path) ? path.slice(1) : 'index.html';
      const asset = resolve(root, file);
      if (!asset.startsWith(root + '/')) return route.abort();
      const mime: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2',
      };
      try {
        return route.fulfill({ body: await readFile(asset), contentType: mime[extname(asset)] });
      } catch {
        return route.fulfill({ status: 404, body: 'Missing offline asset' });
      }
    });
    await page.goto('/connections?manage=openai-add');
    await page.getByRole('button', { name: 'Confirm identity to add an account' }).click();
    await page.getByLabel('Passphrase', { exact: true }).fill('synthetic-passphrase');
    await page.getByRole('button', { name: 'Reauthorize', exact: true }).click();
    const form = page.getByRole('region', { name: 'Add a new AI API account' });
    await form.getByLabel('Provider', { exact: true }).selectOption('enmaas');
    await form.getByLabel('Account label', { exact: true }).fill('EnMaaS');
    await form.getByLabel('Intended work project name').fill('Work');
    await form.getByLabel('API key', { exact: true }).fill('synthetic-key');
    await expect(form.getByLabel('API key', { exact: true })).toHaveAttribute('type', 'password');
    await form.getByRole('button', { name: 'Get models', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('Could not read the provider catalog');
    await form.getByRole('button', { name: 'Get models', exact: true }).click();
    await expect(form.getByText(/partial catalog/)).toBeVisible();
    await expect(form.getByLabel('Available models')).toHaveValues([]);
    await expect(form.getByLabel('Additional model IDs')).toHaveValue(
      'rits/zai-org/glm-5-3\nrits/deepseek-ai/DeepSeek-V4.1-Flash-1017',
    );
    const submit = form.getByRole('button', { name: 'Save API account', exact: true });
    await expect(submit).toBeDisabled();
    await form.getByRole('checkbox').check();
    await submit.focus();
    await expect(submit).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await submit.scrollIntoViewIfNeeded();
    expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: testInfo.outputPath('api-enrollment-models.png'),
      fullPage: true,
    });
    await submit.click();
    await expect(form.getByText('EnMaaS is ready for new chats.')).toBeVisible();
    await expect(form.getByLabel('API key', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('synthetic-key');
  });
}
