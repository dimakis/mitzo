import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

for (const theme of ['dark', 'light'] as const) {
  test(`Claude phone sign-in recovers private code delivery: ${theme}`, async ({
    page,
  }, testInfo) => {
    if (testInfo.project.name.startsWith('mobile'))
      await page.setViewportSize({ width: 320, height: 740 });
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((theme) => {
      localStorage.setItem('mitzo-theme', theme);
      localStorage.setItem('mitzo-accent', theme === 'dark' ? 'mint' : 'teal');
      localStorage.setItem('mitzo-font', theme === 'dark' ? 'system' : 'georgia');
    }, theme);
    await page.routeWebSocket('**/*', (socket) => socket.close());
    const checkControls = async () => {
      for (const control of await page
        .locator('.connections-setup :is(button, input, select)')
        .all())
        if (await control.isVisible())
          expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    };
    let state = 'idle',
      requestId = '',
      starts = 0,
      codes = 0;
    let checks = 0,
      releaseCheck: (() => void) | undefined;
    let signedIn = true;
    const accountId = () => `claude-${requestId}`;
    const attempt = () => ({
      requestId,
      accountId: accountId(),
      label: 'Personal Claude',
      state,
      expiresAt: Date.now() + 600_000,
      errorCode: null,
      diagnosticId: null,
      ...(state === 'pending'
        ? { url: 'https://claude.com/cai/oauth/authorize?state=fixture-state' }
        : {}),
    });
    const snapshot = () => ({
      enabled: true,
      attempts: state === 'idle' ? [] : [attempt()],
      accounts:
        state === 'connected'
          ? [
              {
                id: accountId(),
                label: 'Personal Claude',
                email: 'person@example.test',
                planType: 'max',
                verifiedAt: Date.now(),
              },
            ]
          : [],
    });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'mitzo-ui.test') return route.abort();
      if (url.pathname === '/api/claude-accounts/start') {
        starts++;
        requestId = route.request().postDataJSON().requestId;
        state = 'pending';
        return route.fulfill({ json: attempt() });
      }
      if (url.pathname.endsWith('/code') && url.pathname.startsWith('/api/claude-accounts/')) {
        codes++;
        expect(route.request().postDataJSON()).toEqual({ code: 'synthetic-code#fixture-state' });
        expect(url.search).toBe('');
        state = 'connected';
        // The native operation completed, but its HTTP acknowledgement was lost.
        return route.abort('failed');
      }
      if (url.pathname === '/api/claude-accounts') return route.fulfill({ json: snapshot() });
      if (url.pathname === '/api/connections-access') {
        checks++;
        if (checks === 1)
          await new Promise<void>((resolve) => {
            releaseCheck = resolve;
          });
        return route.fulfill({
          json: {
            generatedAt: Date.now(),
            sources: [{ id: 'accounts', state: 'available', reason: null }],
            resources: [
              {
                kind: 'ai-account',
                owner: 'account-profiles',
                nativeId: accountId(),
                provider: 'anthropic-claude',
                signIn: {
                  status: signedIn ? 'verified' : 'failed',
                  explanation: 'Claude sign-in could not be verified. Sign in again to continue.',
                },
              },
            ],
          },
        });
      }
      if (url.pathname === '/api/auth/check')
        return route.fulfill({ json: { authenticated: true } });
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
      const root = resolve('frontend/dist'),
        file = extname(url.pathname) ? url.pathname.slice(1) : 'index.html';
      const path = resolve(root, file);
      if (!path.startsWith(root + sep)) return route.abort();
      const types: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
      };
      try {
        return route.fulfill({ body: await readFile(path), contentType: types[extname(path)] });
      } catch {
        return route.fulfill({ status: 404, body: 'Offline asset unavailable' });
      }
    });
    await page.goto('/connections?manage=claude');
    await page.getByRole('button', { name: 'Sign in with Claude' }).click();
    await expect(page.getByRole('link', { name: 'Open Claude sign-in' })).toHaveAttribute(
      'href',
      'https://claude.com/cai/oauth/authorize?state=fixture-state',
    );
    await page.reload();
    const field = page.getByLabel('Sign-in code');
    await expect(field).toHaveValue('');
    await expect(field).toHaveAttribute('type', 'password');
    await checkControls();
    expect(starts).toBe(1);
    await field.focus();
    await field.fill('synthetic-code#fixture-state');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Complete sign-in' })).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath('connections-claude-private-code.png'),
      fullPage: true,
    });
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toContainText('could not be confirmed');
    await expect(field).toHaveValue('');
    await page.getByRole('button', { name: 'Check sign-in status' }).click();
    await expect(page.getByRole('button', { name: 'Checking sign-in…' })).toBeDisabled();
    await expect(page.getByText('Checking native Claude sign-in…')).toBeVisible();
    await expect.poll(() => checks).toBe(1);
    releaseCheck!();
    await expect(page.getByText('Personal Claude: Signed in.', { exact: true })).toBeVisible();
    await expect(page.getByText('person@example.test · Max')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start chat' })).toBeEnabled();
    expect(starts).toBe(1);
    expect(codes).toBe(1);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(
      'synthetic-code',
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await checkControls();
    await page.screenshot({
      path: testInfo.outputPath('connections-claude-connected.png'),
      fullPage: true,
    });
    signedIn = false;
    await page.getByRole('button', { name: 'Check sign-in status' }).click();
    await expect(page.getByRole('alert')).toContainText('Sign in again to continue.');
    await expect(page.getByText('Personal Claude: Signed in.', { exact: true })).toHaveCount(0);
    expect(checks).toBe(2);
    expect(starts).toBe(1);
    expect(codes).toBe(1);
    await checkControls();
    await page.screenshot({
      path: testInfo.outputPath('connections-claude-check-failed.png'),
      fullPage: true,
    });
  });
}
