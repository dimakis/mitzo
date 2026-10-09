import { test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

// Reuse the full inventory regression against the compiled app, with no server.
// Its own later API route supplies the injected, synthetic inventory.
test.beforeEach(async ({ page }) => {
  const types: Record<string, string> = {
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test' || url.pathname.startsWith('/api/')) return route.abort();
    const file =
      url.pathname.startsWith('/assets/') || extname(url.pathname)
        ? url.pathname.slice(1)
        : 'index.html';
    try {
      await route.fulfill({
        body: await readFile(resolve('frontend/dist', file)),
        contentType: types[extname(file)] ?? 'application/octet-stream',
      });
    } catch {
      await route.fulfill({ status: 404, body: 'Missing offline asset' });
    }
  });
});
await import('../browser/connections-evidence.spec');
