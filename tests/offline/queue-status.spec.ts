import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const output = build({
  entryPoints: [resolve('tests/fixtures/queue-status.tsx')],
  bundle: true,
  format: 'esm',
  write: false,
  outfile: '/tmp/mitzo-queue-status.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});

for (const theme of ['dark', 'light']) {
  test(`queue count follows metadata events despite stalled details (${theme})`, async ({
    page,
  }, info) => {
    let queued = 0;
    let failed = false;
    let details: 'stalled' | 'loaded' | 'failed' = 'stalled';
    let metadataReads = 0;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const files = (await output).outputFiles!;
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/meta')) {
        metadataReads++;
        return route.fulfill({
          status: failed ? 503 : 200,
          json: { codexQueue: { paused: false, connected: true, queued, interrupted: 0 } },
        });
      }
      // Keep details pending to prove they cannot block the compact status.
      if (path.endsWith('/codex-queue')) {
        if (details === 'stalled') return;
        return route.fulfill({
          status: details === 'failed' ? 503 : 200,
          json: {
            queued: [
              { id: 'first', preview: 'Synthetic first preview' },
              { id: 'second', preview: 'Synthetic second preview' },
            ],
            cancelledIds: [],
          },
        });
      }
      if (path.startsWith('/api/')) return route.fulfill({ json: [] });
      const asset = files.find((file) =>
        path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'),
      );
      if (asset)
        return route.fulfill({
          contentType: asset.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          body: asset.text,
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="mint" data-font="georgia"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 844,
    });
    await page.goto('/');
    const emit = page.getByRole('button', { name: 'Emit queue metadata change', exact: true });
    await expect(emit).toBeVisible();
    await expect.poll(() => metadataReads).toBeGreaterThan(0);
    await expect(page.getByRole('status')).toHaveCount(0);

    queued = 1;
    await emit.click();
    await expect(page.getByRole('status')).toContainText('1 message is waiting', { timeout: 1000 });
    await page.getByRole('button', { name: 'Review queue' }).click();
    await expect(page.getByText('Checking queued messages…')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`queue-${theme}.png`) });
    const beforeForeignEvent = metadataReads;
    await page.getByRole('button', { name: 'Emit other chat change' }).click();
    expect(metadataReads).toBe(beforeForeignEvent);

    await page.getByRole('button', { name: 'Hide status' }).focus();
    await page.keyboard.press('Enter');
    const tab = page.getByRole('button', { name: 'Chat status' });
    await expect(tab).toBeFocused();
    queued = 2;
    await emit.click();
    await expect.poll(() => metadataReads).toBeGreaterThan(beforeForeignEvent);
    await expect(page.getByRole('status')).toHaveCount(0);
    await tab.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText('2 messages are waiting');
    await expect(page.getByRole('button', { name: 'Hide status' })).toBeFocused();

    details = 'loaded';
    await emit.click();
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(2);
    details = 'failed';
    queued = 1;
    await emit.click();
    await expect(page.getByRole('status')).toContainText('1 message is waiting', { timeout: 1000 });
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    await expect(page.getByText('Synthetic first preview')).toHaveCount(0);
    await expect(page.getByText('Synthetic second preview')).toHaveCount(0);

    failed = true;
    await emit.click();
    await expect(page.getByRole('alert')).toContainText('Queue status unavailable', {
      timeout: 1000,
    });
    failed = false;
    queued = 0;
    await emit.click();
    await expect(page.getByRole('status')).toHaveCount(0, { timeout: 1000 });
    expect(errors).toEqual([]);
  });
}
