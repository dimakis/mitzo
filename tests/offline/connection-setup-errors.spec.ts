import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

for (const theme of ['light', 'dark'] as const) {
  test(`connection setup retains actionable errors and recovers: ${theme}`, async ({
    page,
  }, testInfo) => {
    if (testInfo.project.name.startsWith('mobile'))
      await page.setViewportSize({ width: 320, height: 740 });
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((theme) => {
      localStorage.setItem('mitzo-theme', theme);
      localStorage.setItem('mitzo-accent', theme === 'light' ? 'teal' : 'mint');
      localStorage.setItem('mitzo-font', theme === 'light' ? 'system' : 'georgia');
    }, theme);
    await page.routeWebSocket('**/*', (socket) => socket.close());
    let attempt = 0;
    let setup = {
      id: 'fixture-ha',
      sessionId: 'fixture-chat',
      revision: 1,
      status: 'pending',
      profile: 'home-assistant',
      expiresAt: Date.now() + 1800000,
      connection: {
        label: 'Home Assistant',
        endpoint: 'https://long-synthetic-home-assistant-address.ui.nabu.casa',
        methods: ['GET', 'POST'],
        homeAssistantDashboards: 'read-write',
      },
      credential: {
        label: 'Home Assistant key',
        instructions: 'Create a long-lived access token in your Home Assistant profile.',
      },
      error: '',
    };
    const submissionError = 'The originating chat is unavailable. Return to that chat and retry.';
    const storageError =
      'The service accepted the key, but Apple Keychain is locked. Unlock Keychain on the Mac running Mitzo, then retry.';
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'mitzo-ui.test') return route.abort();
      if (url.pathname === '/api/credential-connections/reauthorize')
        return route.fulfill({ json: { csrf: 'fixture-csrf', expiresAt: Date.now() + 60000 } });
      if (url.pathname === '/api/credential-connections/setups/fixture-ha/complete') {
        expect(route.request().postDataJSON().secret).toBe('synthetic-token');
        attempt++;
        if (attempt === 1) return route.fulfill({ status: 409, json: { error: submissionError } });
        setup = {
          ...setup,
          revision: setup.revision + 2,
          status: attempt === 2 ? 'pending' : 'ready',
          error: attempt === 2 ? storageError : '',
        };
        return route.fulfill({ json: { setup } });
      }
      if (url.pathname === '/api/credential-connections/setups/fixture-ha')
        return route.fulfill({ json: { setup } });
      if (url.pathname === '/api/auth/check')
        return route.fulfill({ json: { authenticated: true } });
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
      const root = resolve('frontend/dist');
      const file = extname(url.pathname) ? url.pathname.slice(1) : 'index.html';
      const path = resolve(root, file);
      if (!path.startsWith(root + '/')) return route.abort();
      const mime: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
      };
      try {
        return route.fulfill({ body: await readFile(path), contentType: mime[extname(path)] });
      } catch {
        return route.fulfill({ status: 404, body: 'Missing offline asset' });
      }
    });
    await page.goto('/connections/setup/fixture-ha');
    const connect = page.getByRole('button', { name: 'Connect Home Assistant', exact: true });
    const key = page.getByLabel('Home Assistant key');
    const submit = async () => {
      await expect(key).toBeVisible();
      const passphrase = page.getByLabel('Mitzo passphrase');
      if (await passphrase.count()) await passphrase.fill('synthetic-passphrase');
      await key.fill('synthetic-token');
      await connect.click();
    };
    await submit();
    await expect(page.getByRole('alert')).toHaveText(submissionError);
    await expect(key).toHaveValue('');
    await submit();
    await expect(page.getByRole('alert')).toHaveText(storageError);
    await expect(key).toHaveValue('');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await key.fill('synthetic-token');
    await connect.focus();
    await expect(connect).toBeFocused();
    await connect.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    const box = await connect.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: testInfo.outputPath('connection-setup-error.png'),
      fullPage: true,
    });
    await connect.click();
    await expect(page.getByRole('heading', { name: 'Home Assistant is connected' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Return to chat' })).toHaveAttribute(
      'href',
      '/chat/fixture-chat',
    );
  });
}
