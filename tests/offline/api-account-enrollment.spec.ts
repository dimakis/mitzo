import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

for (const theme of ['light', 'dark'] as const) {
  for (const protocol of ['responses', 'messages'] as const) {
    test(`EnMaaS ${protocol} connects automatically and retains picker visibility: ${theme}`, async ({
      page,
    }, info) => {
      if (info.project.name.startsWith('mobile'))
        await page.setViewportSize({ width: 320, height: 850 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.addInitScript((theme) => {
        localStorage.setItem('mitzo-theme', theme);
        localStorage.setItem('mitzo-accent', theme === 'light' ? 'teal' : 'mint');
        localStorage.setItem('mitzo-font', theme === 'light' ? 'georgia' : 'system');
      }, theme);
      await page.routeWebSocket('**/*', (socket) => socket.close());
      let saved: Record<string, unknown> | null = null,
        refreshFailed = false;
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url()),
          path = url.pathname;
        if (url.hostname !== 'mitzo-ui.test') return route.abort();
        if (path === '/api/auth/check') return route.fulfill({ json: { authenticated: true } });
        if (path === '/api/connections')
          return route.fulfill({
            json: {
              connections: [],
              legacy: [],
              eligibleAccounts: [],
              openAIAccountsManaged: true,
            },
          });
        if (path === '/api/connections/templates')
          return route.fulfill({ json: { templates: [], capabilities: [] } });
        if (path === '/api/connections/reauthorize')
          return route.fulfill({ json: { csrf: 'fixture-csrf', expiresAt: Date.now() + 60000 } });
        if (path === '/api/connections/api-models') {
          expect(route.request().postDataJSON()).toMatchObject({
            endpoint: 'https://api.enmaas.devshift.net' + (protocol === 'responses' ? '/v1' : ''),
            apiKey: 'synthetic-key',
            ...(protocol === 'messages' ? { protocol, authentication: 'api-key' } : {}),
          });
          return route.fulfill({
            json: { models: [{ id: 'catalog/model', label: 'Catalog model' }], partial: true },
          });
        }
        if (path === '/api/connections/openai-accounts/fixture-enmaas/models') {
          if (refreshFailed)
            return route.fulfill({ status: 422, json: { code: 'MODEL_REFRESH_FAILED' } });
          saved = {
            ...saved,
            models: [
              ...(saved!.models as { id: string; label: string }[]),
              { id: 'new/model', label: 'New model' },
            ],
          };
          return route.fulfill({ json: { account: saved } });
        }
        if (path === '/api/connections/openai-accounts') {
          if (route.request().method() === 'POST') {
            const input = route.request().postDataJSON();
            expect(input.connection).toMatchObject({
              protocol,
              ...(protocol === 'messages' ? { authentication: 'api-key' } : {}),
            });
            expect(input.models.map((model: { id: string }) => model.id)).toEqual([
              'rits/deepseek-ai/DeepSeek-V4.1-Flash-1017',
              'rits/zai-org/glm-5-3',
              'catalog/model',
            ]);
            saved = {
              id: 'fixture-enmaas',
              requestId: input.requestId,
              label: input.label,
              projectLabel: input.projectLabel,
              endpoint: input.connection.endpoint,
              protocol,
              state: 'ready',
              models: input.models,
            };
            return route.fulfill({ status: 201, json: { account: saved } });
          }
          return route.fulfill({ json: { enabled: true, accounts: saved ? [saved] : [] } });
        }
        if (path.startsWith('/api/')) return route.fulfill({ json: {} });
        const root = resolve('frontend/dist'),
          asset = resolve(root, extname(path) ? path.slice(1) : 'index.html');
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
      await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('enmaas');
      const form = page.getByRole('region', { name: 'EnMaaS account', exact: true });
      await form.getByRole('combobox', { name: 'Runtime', exact: true }).selectOption(protocol);
      await form.getByLabel('API key', { exact: true }).fill('synthetic-key');
      await expect(form.getByLabel('API key', { exact: true })).toHaveAttribute('type', 'password');
      for (const control of await form.locator('input, select').all()) {
        if (!(await control.isVisible())) continue;
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        expect(
          await control.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize)),
        ).toBeGreaterThanOrEqual(16);
      }
      expect(await form.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px');
      await page.screenshot({ path: info.outputPath('enmaas-connect.png'), fullPage: true });
      await form.getByRole('button', { name: 'Connect EnMaaS', exact: true }).click();
      await expect(form.getByText('Account saved', { exact: true })).toBeVisible();
      await expect(form.getByText('3 available · 3 shown')).toBeVisible();
      await form.getByRole('button', { name: 'Model picker settings', exact: true }).click();
      let dialog = page.getByRole('dialog', { name: 'Model picker settings', exact: true });
      const catalogChoice = dialog.getByRole('checkbox', { name: 'Catalog model', exact: true });
      await catalogChoice.focus();
      await catalogChoice.uncheck();
      await expect(
        dialog.getByRole('checkbox', { name: 'Catalog model', exact: true }),
      ).toBeFocused();
      await expect(dialog.getByText('2 of 3 shown')).toBeVisible();
      await page.screenshot({ path: info.outputPath('enmaas-model-settings.png'), fullPage: true });
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(
        form.getByRole('button', { name: 'Model picker settings', exact: true }),
      ).toBeFocused();
      await form.getByRole('button', { name: 'Refresh models', exact: true }).click();
      await expect(form.getByText('4 available · 3 shown')).toBeVisible();
      await page.goto('/connections?manage=openai-add&connection=fixture-enmaas');
      await expect(form.getByText('4 available · 3 shown')).toBeVisible();
      await form.getByRole('button', { name: 'Model picker settings', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Model picker settings', exact: true });
      await expect(
        dialog.getByRole('checkbox', { name: 'Catalog model', exact: true }),
      ).not.toBeChecked();
      await expect(dialog.getByRole('checkbox', { name: 'New model', exact: true })).toBeChecked();
      await dialog.getByRole('button', { name: 'Hide all', exact: true }).click();
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(form.getByRole('button', { name: 'Start a chat', exact: true })).toBeDisabled();
      await form.getByRole('button', { name: 'Model picker settings', exact: true }).click();
      await dialog.getByRole('button', { name: 'Show all', exact: true }).click();
      await page.keyboard.press('Escape');
      await expect(form.getByRole('button', { name: 'Start a chat', exact: true })).toBeEnabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
        'synthetic-key',
      );
      refreshFailed = true;
      await form.getByRole('button', { name: 'Refresh models', exact: true }).click();
      await page.getByLabel('Passphrase', { exact: true }).fill('synthetic-passphrase');
      await page.getByRole('button', { name: 'Reauthorize', exact: true }).click();
      await form.getByRole('button', { name: 'Refresh models', exact: true }).click();
      await expect(form.getByRole('alert')).toContainText('last model list is retained');
      await expect(form.getByText('4 available · 4 shown')).toBeVisible();
    });
  }
}
