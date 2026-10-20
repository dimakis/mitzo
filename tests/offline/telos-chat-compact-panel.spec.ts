import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/telos-chat-compact-panel.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-chat-compact.js',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});
for (const theme of ['dark', 'light'])
  test(`chat-panel tree preserves readable titles and full-workspace controls (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const files = (await bundle).outputFiles!;
    const writes: string[] = [];
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) {
        if (route.request().method() !== 'GET') writes.push(url.pathname);
        return route.fulfill({
          json: {
            itemId: url.pathname.split('/').at(-1),
            kind: 'coordinator',
            parentId: null,
            revision: 'a'.repeat(64),
            links: [],
            sources: [],
            attempts: [],
            assignments: [],
          },
        });
      }
      const asset = files.find(
        (file) => url.pathname === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (asset)
        return route.fulfill({
          body: asset.text,
          contentType: asset.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (url.pathname !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Toggle work tree' }).click();
    const panel = page.getByRole('region', { name: 'Work tree', exact: true });
    const title = panel.getByRole('button', { name: 'Recording programme', exact: true });
    await expect(title).toBeVisible();
    const geometry = await title.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return {
        width: element.closest('.telos-node-copy')!.getBoundingClientRect().width,
        lines: range.getClientRects().length,
      };
    });
    expect(geometry.width).toBeGreaterThan(150);
    expect(geometry.lines).toBeLessThanOrEqual(2);
    await expect(panel.locator('[aria-label^="Priority "]').first()).toBeVisible();
    await expect(panel.locator('.telos-tree-conversation').first()).toBeHidden();
    await expect(panel.locator('.telos-node-status').first()).toBeVisible();
    await expect(panel.locator('.telos-node-icon').first()).toBeHidden();
    await expect(panel.getByText('Coordinator', { exact: true }).first()).toBeVisible();
    await expect(panel.getByText('Coordinator', { exact: true }).first()).toHaveCSS(
      'white-space',
      'nowrap',
    );
    await expect(panel.getByRole('button', { name: /Expand Recording programme/ })).toBeVisible();
    await panel.getByRole('button', { name: /Expand Recording programme/ }).click();
    await expect(panel.locator('.telos-tree .telos-tree').first()).toBeVisible();
    const workspace = page.getByRole('region', { name: 'Full workspace child tree' });
    await expect(workspace.locator('.telos-tree-row-end').first()).toBeVisible();
    await expect(workspace.locator('[aria-label^="Priority "]').first()).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'View coordinator' }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`compact-tree-${theme}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Close work tree' }).click();
    await expect(page.getByRole('button', { name: 'Toggle work tree' })).toBeFocused();
    await expect(page.getByRole('textbox', { name: 'Retained draft' })).toHaveValue(
      'Keep this draft',
    );
    expect(writes).toEqual([]);
  });
