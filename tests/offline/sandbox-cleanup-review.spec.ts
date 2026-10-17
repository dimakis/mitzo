import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const bundle = build({
  entryPoints: [resolve('tests/fixtures/sandboxes.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/sandbox-cleanup-review.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});
for (const theme of ['dark', 'light'] as const)
  test(`sandbox ownership and selected cleanup (${theme})`, async ({ page }, info) => {
    const mobile = info.project.name.startsWith('mobile'),
      width = mobile ? 320 : 1280;
    await page.setViewportSize({ width, height: mobile ? 740 : 900 });
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
    const compiled = await bundle,
      writes: string[] = [],
      errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const conversations = ['one', 'two'].map((id) => ({
      conversationId: id,
      sandboxName: 'sandbox-' + id,
      physicalId: 'physical-' + id,
      state: 'stopped',
      account: 'Work API',
      title: id === 'one' ? 'Completed comparison report' : 'Protected active conversation',
      canReviewCleanup: true,
    }));
    const state = {
      revision: 1,
      available: true,
      busy: false,
      resting: false,
      reason: null,
      spares: [],
      conversations,
      settings: {
        enabled: false,
        capacity: 1,
        refill: 'manual',
        expiryMinutes: 120,
        cpu: 2,
        memoryGiB: 4,
      },
      capabilities: { cpu: true, memory: true, disk: false, diskReason: 'Unavailable' },
      physicalInventory: {
        available: true,
        total: 3,
        counts: { Stopped: 3 },
        items: [
          ...conversations.map((item) => ({
            id: item.physicalId,
            name: item.sandboxName,
            state: 'Stopped',
            management: 'conversation',
          })),
          {
            id: 'historical',
            name: 'older-sandbox-with-a-long-physical-resource-name',
            state: 'Stopped',
            management: 'needs_review',
          },
        ],
      },
    };
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://mitzo-ui.test') return route.abort();
      if (url.pathname === '/api/sandboxes') return route.fulfill({ json: state });
      if (url.pathname.endsWith('/ownership'))
        return route.fulfill({
          json: {
            physical: state.physicalInventory.items[2],
            owners: [
              {
                conversationId: 'archived',
                accountId: 'Work',
                ownerKind: 'ordinary',
                relation: 'runtime',
              },
            ],
            blockers: ['lifecycle_missing', 'checkpoint_unverified'],
            canDelete: false,
          },
        });
      if (url.pathname.endsWith('/preview')) {
        const id = url.pathname.includes('/two/') ? 'two' : 'one';
        return route.fulfill({
          json: {
            token: 'fresh-' + id,
            action: id === 'two' ? 'none' : 'delete',
            blockers: id === 'two' ? ['active_session'] : [],
            record: {
              conversationId: id,
              sandboxName: 'sandbox-' + id,
              physicalSandboxId: 'physical-' + id,
            },
          },
        });
      }
      if (url.pathname.endsWith('/confirm')) {
        writes.push(route.request().postDataJSON().token);
        state.physicalInventory.total = 2;
        state.physicalInventory.counts.Stopped = 2;
        state.physicalInventory.items = state.physicalInventory.items.filter(
          (item) => item.id !== 'physical-one',
        );
        return route.fulfill({ json: { action: 'deleted' } });
      }
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
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><link rel="stylesheet" href="/fixture.css"><script type="module" src="/fixture.js"></script></html>`,
      });
    });
    await page.goto('/sandboxes');
    await page.getByText('Needs ownership review', { exact: false }).click();
    await page.getByRole('button', { name: 'Review ownership', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('link', { name: 'Open saved chat' })).toHaveAttribute(
      'href',
      '/chat/archived',
    );
    await expect(dialog.getByText(/No managed lifecycle record/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Delete/ })).toHaveCount(0);
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath('sandbox-ownership-' + theme + '.png') });
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('button', { name: 'Review ownership', exact: true })).toBeFocused();
    for (const name of ['Completed comparison report', 'Protected active conversation'])
      await page.getByRole('checkbox', { name: 'Select sandbox for ' + name }).check();
    await page.getByRole('button', { name: 'Review selected cleanup' }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByText('active session', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Delete reviewed sandboxes' })).toBeDisabled();
    expect(writes).toEqual([]);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    // Cancel clears selection, so select only the eligible conversation for the next review.
    await page
      .getByRole('checkbox', { name: 'Select sandbox for Completed comparison report' })
      .check();
    await page.getByRole('button', { name: 'Review selected cleanup' }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Ready to delete', { exact: true })).toBeVisible();
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    const confirmation = dialog.getByRole('button', { name: 'Delete reviewed sandboxes' });
    await expect(confirmation).toBeDisabled();
    await dialog.getByRole('checkbox').check();
    await confirmation.scrollIntoViewIfNeeded();
    expect((await confirmation.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath('sandbox-batch-' + theme + '.png') });
    await confirmation.click();
    await expect(dialog.getByText('Deleted; chat and checkpoint retained')).toBeVisible();
    expect(writes).toEqual(['fresh-one']);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('2 sandboxes on this gateway')).toBeVisible();
    await expect(
      page.getByRole('checkbox', { name: 'Select sandbox for Completed comparison report' }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });
