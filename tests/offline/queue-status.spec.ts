import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const output = build({
  entryPoints: [resolve('tests/fixtures/queue-status.tsx')],
  bundle: true,
  external: ['/*.png', '/*.svg'],
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
    // Exercise the preview/cancellation path with the older WebKit API surface.
    await page.addInitScript(() => {
      Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
    });
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
    await expect(page.getByRole('status')).toContainText('1 message queued', { timeout: 1000 });
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
    await expect(page.getByRole('status')).toContainText('2 messages queued');
    await expect(page.getByRole('button', { name: 'Hide status' })).toBeFocused();

    details = 'loaded';
    await emit.click();
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(2);
    details = 'failed';
    queued = 1;
    await emit.click();
    await expect(page.getByRole('status')).toContainText('1 message queued', { timeout: 1000 });
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

for (const theme of ['dark', 'light']) {
  test(`successful queue recovery clears the attention banner (${theme})`, async ({
    page,
  }, info) => {
    const files = (await output).outputFiles!;
    let continued = false;
    let recovering = true;
    let failed = 0;
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/meta'))
        return route.fulfill({
          json: {
            codexQueue: {
              paused: !continued,
              connected: true,
              recovering,
              recoveryPhase: recovering ? 'reconnecting' : undefined,
              queued: continued ? 0 : 1,
              interrupted: continued ? 0 : 1,
              failed,
            },
          },
        });
      if (path.endsWith('/continue')) {
        continued = true;
        return route.fulfill({ json: { ok: true } });
      }
      if (path.endsWith('/codex-queue'))
        return route.fulfill({
          json: {
            queued: [{ id: 'saved', preview: 'Synthetic saved work' }],
            cancelledIds: [],
          },
        });
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
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 844,
    });
    await page.goto('/');
    await expect(page.getByRole('status')).toContainText('Reconnecting…');
    await expect(page.getByRole('button', { name: 'Reconnect and continue' })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`recovering-${theme}.png`) });
    // A sustained failure keeps the explicit fallback; success must remove its old warning.
    recovering = false;
    await page.getByRole('button', { name: 'Emit queue metadata change', exact: true }).click();
    const reconnect = page.getByRole('button', { name: 'Reconnect and continue' });
    await expect(reconnect).toBeVisible();
    await reconnect.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(page.getByText('An earlier step may be incomplete.')).toHaveCount(0);
    await expect(page.getByText('Reconnected. Continuing saved messages.')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`recovered-${theme}.png`) });
    await page.getByRole('button', { name: 'Show delivery progress' }).click();
    const progress = page.getByRole('status');
    await expect(progress).toContainText('Preparing response…');
    await expect(page.locator('.codex-queue-status--attention')).toHaveCount(0);
    expect(
      await progress.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    ).toBeLessThanOrEqual(14);
    const input = page.getByRole('textbox', { name: 'Message Mitzo' });
    await input.fill('Synthetic unsent draft');
    await page.screenshot({ path: info.outputPath(`delivery-progress-${theme}.png`) });
    await page
      .locator('.queue-status-composer')
      .screenshot({ path: info.outputPath(`composer-progress-${theme}.png`) });
    await page.getByRole('button', { name: 'Clear delivery progress' }).click();
    await expect(page.getByText('Preparing response…')).toHaveCount(0);
    await expect(input).toHaveValue('Synthetic unsent draft');
    failed = 1;
    await page.getByRole('button', { name: 'Emit queue metadata change', exact: true }).click();
    const warning = page.locator('.codex-queue-status-attention');
    await expect(warning).toBeVisible();
    await expect(warning.locator('svg[data-icon="warning"]')).toHaveCount(1);
    const warningColor = await page.evaluate(() => {
      const reference = document.createElement('span');
      reference.style.color = 'var(--color-warning)';
      document.body.append(reference);
      const color = getComputedStyle(reference).color;
      reference.remove();
      return color;
    });
    expect(await warning.evaluate((element) => getComputedStyle(element).color)).toBe(warningColor);
    expect(await warning.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
      'rgba(0, 0, 0, 0)',
    );
  });
}
