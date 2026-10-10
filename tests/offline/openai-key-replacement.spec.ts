import { test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import '../browser/openai-key-replacement.spec';

// Reuse the browser interaction contract with compiled assets intercepted in
// memory. No app server, provider, credential or model is involved on this Mac.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mitzo-theme', 'dark'));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (url.pathname.startsWith('/api/')) return route.fallback();
    const root = resolve('frontend/dist');
    const file = extname(url.pathname) ? url.pathname.slice(1) : 'index.html';
    const path = resolve(root, file);
    if (!path.startsWith(root + '/')) return route.abort();
    const mime: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
    };
    try {
      return route.fulfill({ body: await readFile(path), contentType: mime[extname(path)] });
    } catch {
      return route.fulfill({ status: 404, body: 'Missing offline asset' });
    }
  });
});
