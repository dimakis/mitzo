import { readChatStorage } from '../support/persisted-chat-storage';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const output = build({
  entryPoints: [resolve('tests/fixtures/discard-chat-draft.tsx')],
  bundle: true,
  format: 'esm',
  write: false,
  outfile: '/tmp/mitzo-discard-chat-draft.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
  },
});

test.beforeEach(async ({ page }) => {
  const files = (await output).outputFiles;
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    const asset = files.find((file) =>
      url.pathname.endsWith(file.path.endsWith('.css') ? '.css' : '.js'),
    );
    if (asset)
      return route.fulfill({
        body: asset.text,
        contentType: asset.path.endsWith('.css') ? 'text/css' : 'text/javascript',
      });
    return route.fulfill({
      body: '<html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
      contentType: 'text/html',
    });
  });
});

test('confirmed discard survives immediate document replacement', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: /Discard only after commit/ })).toBeVisible();
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm discard', exact: true }).click();
  await expect(page.getByRole('link', { name: 'New chat', exact: true })).toBeFocused();
  await page.reload();
  await expect(page.getByText('No drafts yet', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /Discard only after commit/ })).toHaveCount(0);
});

test('plain edits reach durable storage before cold recovery', async ({ page }) => {
  await page.goto('/text');
  const input = page.getByRole('textbox', { name: 'Plain draft' });
  await input.fill('Keep this independent unsent edit');
  await expect
    .poll(() =>
      readChatStorage(page, (storage) => storage.getItem('mitzo-draft-plain-cold-reload')),
    )
    .toBe('Keep this independent unsent edit');
  await page.reload();
  await expect(input).toHaveValue('Keep this independent unsent edit');
});
