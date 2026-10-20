import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const compiled = build({
  entryPoints: [resolve('tests/fixtures/telos-selected-ancestor.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/telos-selected-ancestor.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
  },
});
for (const theme of ['dark', 'light'] as const)
  test(`selected path follows canonical hydration with manual collapse and retained draft (${theme})`, async ({
    page,
  }, info) => {
    const files = (await compiled).outputFiles;
    const errors: string[] = [];
    const outside: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://mitzo-ui.test') {
        outside.push(url.href);
        return route.abort();
      }
      if (url.pathname === '/fixture.js' || url.pathname === '/fixture.css') {
        const css = url.pathname.endsWith('.css');
        return route.fulfill({
          contentType: css ? 'text/css' : 'application/javascript',
          body: files.find((file) => file.path.endsWith(css ? '.css' : '.js'))!.text,
        });
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, json: {} });
      return route.fulfill({
        contentType: 'text/html',
        body: `<html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      });
    });
    await page.goto('/');
    const backlink = page.getByRole('link', {
      name: 'Open Created acoustic outcome · Created from this exchange',
    });
    await expect(backlink).toHaveAttribute('href', '/todos/created?view=Overview');
    await expect(page.locator('.telos-created-item')).toContainText(
      'Selected exchange · 2 messages',
    );
    expect(await page.locator('.telos-created-item').textContent()).not.toMatch(/11|2–11/);
    await page.screenshot({ path: info.outputPath('inline-created-item.png'), fullPage: true });
    const draft = page.getByRole('textbox', { name: 'Unsent draft' });
    await draft.fill('Keep this exact unsent worker draft');
    const node = await draft.elementHandle();
    await page.getByRole('button', { name: 'Toggle work tree' }).click();
    const tree = page.getByRole('region', { name: 'Work tree' });
    await tree.getByRole('button', { name: 'Load canonical parent' }).click();
    await expect(tree.getByRole('button', { name: 'Collapse Home studio' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(tree.locator('[aria-current="page"]')).toContainText('Record one sample');
    await page.screenshot({ path: info.outputPath('selected-hydrated.png'), fullPage: true });
    await tree.getByRole('button', { name: 'Collapse Home studio' }).click();
    await tree.getByRole('button', { name: 'Refresh canonical records' }).click();
    await tree.getByRole('button', { name: 'Withdraw canonical parent' }).click();
    await tree.getByRole('button', { name: 'Load canonical parent' }).click();
    await expect(tree.getByRole('button', { name: 'Expand Home studio' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await tree.getByRole('button', { name: 'Close work tree' }).click();
    await expect(draft).toHaveValue('Keep this exact unsent worker draft');
    expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(page.getByRole('button', { name: 'Toggle work tree' })).toBeFocused();
    await page.getByRole('button', { name: 'Toggle work tree' }).click();
    await expect(tree.getByRole('button', { name: 'Collapse Home studio' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(errors).toEqual([]);
    expect(outside).toEqual([]);
  });
