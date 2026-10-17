import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, extname, basename } from 'node:path';

test('a failed login chunk can recover after connectivity returns', async ({ page }) => {
  let online = false;
  let blocked = 0;
  let documents = 0;
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (url.pathname === '/api/auth/check')
      return route.fulfill({ status: 401, json: { error: 'Unauthorized' } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
    if (/^Login-.*\.js$/.test(basename(url.pathname)) && !online) {
      blocked++;
      return route.abort('failed');
    }
    const document = route.request().isNavigationRequest();
    if (document) documents++;
    const path = resolve('frontend/dist', document ? 'index.html' : `.${url.pathname}`);
    try {
      return route.fulfill({
        body: await readFile(path),
        contentType:
          {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.png': 'image/png',
          }[extname(path)] ?? 'application/octet-stream',
      });
    } catch {
      return route.abort();
    }
  });
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
  expect(blocked).toBeGreaterThan(0);
  online = true;
  await page.getByRole('button', { name: 'Try Again' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Mitzo' })).toBeVisible();
  expect(documents).toBe(2);
});
