import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/inbox-cleanup.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/inbox-cleanup.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});

for (const theme of ['dark', 'light'] as const) {
  test(`Inbox cleanup is reachable, recoverable and explicit (${theme})`, async ({
    page,
  }, info) => {
    const mobile = info.project.name.startsWith('mobile');
    await page.setViewportSize({ width: mobile ? 320 : 1280, height: mobile ? 740 : 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.addInitScript(
      ({ theme }) => {
        localStorage.setItem('mitzo-theme', theme);
        localStorage.setItem('mitzo-accent', theme === 'dark' ? 'mint' : 'teal');
        localStorage.setItem('mitzo-font', theme === 'dark' ? 'system' : 'georgia');
        if (theme === 'light')
          document.addEventListener('DOMContentLoaded', () => {
            document.documentElement.style.fontSize = '20px';
          });
      },
      { theme },
    );
    const compiled = await bundle;
    const writes: string[] = [],
      errors: string[] = [],
      externalRequests: string[] = [];
    let fail = true;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== 'http://mitzo-ui.test') {
        externalRequests.push(url.origin);
        return route.abort();
      }
      if (url.pathname === '/api/notifications/archive-resolved') {
        writes.push(request.method());
        return fail
          ? route.fulfill({ status: 503, json: { error: 'Synthetic outage' } })
          : route.fulfill({ json: { ok: true, archived: 7 } });
      }
      if (url.pathname === '/api/inbox/feed' || url.pathname === '/api/notifications')
        return route.fulfill({ json: { items: [], total: 0, needsYou: 0, sources: [] } });
      if (url.pathname === '/fixture.js' || url.pathname === '/fixture.css')
        return route.fulfill({
          contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css',
          body: compiled.outputFiles!.find((file) =>
            file.path.endsWith(url.pathname.endsWith('.js') ? '.js' : '.css'),
          )!.text,
        });
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
      if (/\.(png|svg)$/.test(url.pathname)) return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><link rel="stylesheet" href="/fixture.css"><script type="module" src="/fixture.js"></script></html>`,
      });
    });
    await page.goto('/inbox');
    const trigger = page.getByRole('button', { name: 'Clean up', exact: true });
    await expect(trigger).toBeEnabled();
    await page.screenshot({ path: info.outputPath(`inbox-${theme}.png`), fullPage: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Clean up Inbox' });
    await expect(dialog.getByText(/across your entire inbox/)).toBeVisible();
    await expect(dialog.getByText(/Pending requests and unread updates stay/)).toBeVisible();
    expect(writes).toEqual([]);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(trigger).toBeFocused();
    await trigger.click();
    const confirm = dialog.getByRole('button', { name: 'Archive read and resolved' });
    const bounds = await confirm.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`inbox-cleanup-${theme}.png`) });
    await confirm.click();
    await expect(dialog.getByRole('alert')).toContainText('Could not confirm cleanup');
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    fail = false;
    await trigger.click();
    await confirm.click();
    await expect(page.getByRole('status')).toContainText('Archived 7 items');
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
    expect(writes).toEqual(['POST', 'POST']);
    expect(errors).toEqual([]);
    expect(externalRequests).toEqual([]);
  });
}
