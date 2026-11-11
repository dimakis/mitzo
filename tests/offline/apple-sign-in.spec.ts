import { test, expect, type Page, type Route } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/apple-sign-in.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-apple-login.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@capacitor/core': resolve('tests/fixtures/apple-sign-in-native.ts'),
    '@capgo/capacitor-native-biometric': resolve('tests/fixtures/apple-sign-in-native.ts'),
  },
});

async function fixture(
  page: Page,
  options: {
    enrolled?: boolean;
    disabled?: boolean;
    theme?: string;
    statusFailure?: boolean;
    check?: boolean;
    native?: (route: Route) => Promise<void>;
  } = {},
) {
  const files = (await bundle).outputFiles!;
  const bodies: Record<string, unknown>[] = [];
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (url.pathname === '/api/auth/apple/status')
      return route.fulfill({
        status: options.statusFailure ? 503 : 200,
        json: options.disabled
          ? { enabled: false }
          : { enabled: true, enrolled: options.enrolled ?? true, native: true },
      });
    if (url.pathname === '/api/auth/apple/start') {
      const body = route.request().postDataJSON();
      bodies.push(body);
      return route.fulfill({
        json:
          body.client === 'native'
            ? { state: 's'.repeat(43), nonce: 'n'.repeat(43), verifier: 'v'.repeat(43) }
            : { authorizationUrl: 'https://appleid.apple.com/auth/authorize?state=synthetic' },
      });
    }
    if (url.pathname === '/api/auth/apple/native') {
      bodies.push(route.request().postDataJSON());
      return options.native
        ? options.native(route)
        : route.fulfill({ json: { token: 'apple-fixture-token' } });
    }
    if (url.pathname === '/api/auth/check')
      return route.fulfill({
        status: options.check ? 200 : 401,
        json: options.check
          ? { ok: true, authSessionId: 'synthetic-session' }
          : { error: 'Unauthenticated' },
      });
    if (url.pathname === '/api/auth/login')
      return route.fulfill({ json: { token: 'passphrase-fixture-token' } });
    if (url.pathname.startsWith('/api/')) return route.abort();
    if (['/apple-sign-in.png', '/mitzo-wordmark.png'].includes(url.pathname))
      return route.fulfill({
        body: await readFile(resolve(`frontend/public${url.pathname}`)),
        contentType: 'image/png',
      });
    const file = files.find((f) => url.pathname.endsWith(f.path.endsWith('.css') ? '.css' : '.js'));
    if (file)
      return route.fulfill({
        body: file.text,
        contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
      });
    if (url.pathname !== '/') return route.abort();
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html data-theme="${options.theme ?? 'dark'}" data-font="georgia" data-accent="mint"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
    });
  });
  return bodies;
}

for (const theme of ['dark', 'light']) {
  test(`Apple login preserves recovery and keyboard/touch access (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await fixture(page, { theme });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const width of isMobile ? [320, 390] : [1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/?native=1');
      const button = page.getByRole('button', { name: 'Sign in with Apple', exact: true });
      await expect(button).toBeVisible();
      await expect(page.getByRole('button', { name: 'Login', exact: true })).toBeVisible();
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await button.focus();
      await expect(button).toBeFocused();
      await page.screenshot({ path: info.outputPath(`apple-login-${width}-${theme}.png`) });
      await page.keyboard.press('Enter');
      await expect(page.getByText('Signed in to the offline fixture')).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem('mitzo_auth_token'))).toBe(
        'apple-fixture-token',
      );
    }
    expect(errors).toEqual([]);
  });
}

test('enrollment requires a passphrase and uses the native challenge exchange', async ({
  page,
}) => {
  const bodies = await fixture(page, { enrolled: false });
  await page.goto('/?native=1');
  const connect = page.getByRole('button', { name: 'Connect Apple account' });
  await expect(connect).toBeDisabled();
  await page.getByLabel('Passphrase', { exact: true }).fill('synthetic-owner-proof');
  await connect.click();
  await expect(page.getByText('Signed in to the offline fixture')).toBeVisible();
  expect(bodies).toEqual([
    { client: 'native', enrollPassphrase: 'synthetic-owner-proof' },
    { state: 's'.repeat(43), verifier: 'v'.repeat(43), code: 'synthetic-apple-code' },
  ]);
});

test('a forged browser success cannot authenticate; a verified cookie can', async ({ page }) => {
  await fixture(page);
  await page.goto('/?apple=success');
  await expect(page.getByRole('alert')).toContainText('could not be confirmed');
  await expect(page.getByText('Signed in to the offline fixture')).toHaveCount(0);
  await page.unrouteAll();
  await fixture(page, { check: true });
  await page.goto('/?apple=success');
  await expect(page.getByText('Signed in to the offline fixture')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('mitzo_auth_token'))).toBeNull();
});

test('cancelled native login remains visible and passphrase recovery works', async ({ page }) => {
  const bodies = await fixture(page);
  await page.goto('/?native=1&cancel=1');
  await page.getByRole('button', { name: 'Sign in with Apple' }).click();
  await expect(page.getByRole('alert')).toHaveText('Apple sign-in was cancelled.');
  expect(bodies).toHaveLength(1);
  await page.getByLabel('Passphrase', { exact: true }).fill('recovery-proof');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByText('Signed in to the offline fixture')).toBeVisible();
});

test('late native completion cannot restore a logged-out session', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await fixture(page, {
    native: async (route) => {
      await gate;
      await route.fulfill({ json: { token: 'late-token' } });
    },
  });
  await page.goto('/?native=1');
  const request = page.waitForRequest('**/api/auth/apple/native');
  await page.getByRole('button', { name: 'Sign in with Apple' }).click();
  await request;
  await expect(page.getByRole('button', { name: 'Sign in with Apple' })).toBeDisabled();
  await page.evaluate(() => {
    localStorage.setItem('mitzo_logout_pending', '1');
    window.dispatchEvent(new Event('mitzo:auth-lost'));
  });
  const response = page.waitForResponse('**/api/auth/apple/native');
  release();
  await response;
  await expect(page.getByRole('button', { name: 'Sign in with Apple' })).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem('mitzo_auth_token'))).toBeNull();
  await expect(page.getByText('Signed in to the offline fixture')).toHaveCount(0);
});

test('disabled configuration stays quiet; status failure offers retry and recovery', async ({
  page,
}) => {
  await fixture(page, { disabled: true });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in with Apple' })).toHaveCount(0);
  await page.unrouteAll();
  await fixture(page, { statusFailure: true });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Retry Apple sign-in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Login', exact: true })).toBeEnabled();
});
