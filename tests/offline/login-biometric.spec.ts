import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/login-biometric.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-login-biometric.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@capacitor/core': resolve('tests/fixtures/login-biometric-native.ts'),
    '@capgo/capacitor-native-biometric': resolve('tests/fixtures/login-biometric-native.ts'),
  },
});

for (const theme of ['dark', 'light']) {
  test(`Face ID enrollment is explicit and usable (${theme})`, async ({ page, isMobile }, info) => {
    const files = (await bundle).outputFiles!;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'mitzo-ui.test') return route.abort();
      if (url.pathname === '/api/auth/login')
        return route.fulfill({ json: { token: 'offline-fixture-token' } });
      if (url.pathname.startsWith('/api/')) return route.abort();
      if (url.pathname === '/mitzo-wordmark.png')
        return route.fulfill({
          body: await readFile(resolve('frontend/public/mitzo-wordmark.png')),
          contentType: 'image/png',
        });
      const file = files.find((f) =>
        url.pathname.endsWith(f.path.endsWith('.css') ? '.css' : '.js'),
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
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const width of isMobile ? [320, 390] : [1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/');
      const enable = page.getByRole('checkbox', { name: 'Enable Face ID on this device' });
      await expect(enable).not.toBeChecked();
      await expect(page.getByText(/protected by your enrolled biometrics/)).toBeVisible();
      await expect(page.getByText(/Sign in with your passphrase and enable Face ID/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Unlock with Face ID' })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect((await enable.locator('..').boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await enable.focus();
      await page.keyboard.press('Space');
      await expect(enable).toBeChecked();
      await page.screenshot({ path: info.outputPath(`face-id-${width}-${theme}.png`) });
      await page.getByPlaceholder('Passphrase').fill('offline-fixture-passphrase');
      await page.getByRole('button', { name: 'Login', exact: true }).click();
      await expect(page.getByText('Signed in to the offline fixture')).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { biometricFixture: { protectedWrites: unknown[] } })
              .biometricFixture.protectedWrites,
        ),
      ).toEqual([
        {
          key: 'com.mitzo.app.biometric-passphrase',
          value: 'offline-fixture-passphrase',
          accessControl: 1,
        },
      ]);
    }
    expect(errors).toEqual([]);
  });
}
