import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { telosSourceBrowserData } from '../fixtures/telos-source-data';
test.use({ baseURL: 'https://mitzo-ui.test' });
const compiled = build({
  entryPoints: [resolve('tests/fixtures/telos-source-navigation.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/telos-source.js',
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
for (const theme of ['dark', 'light'] as const)
  test(`retained source restores the actual exchange and returns to its item (${theme})`, async ({
    page,
  }, info) => {
    const data = await telosSourceBrowserData();
    const files = (await compiled).outputFiles;
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const mobile = info.project.name.startsWith('mobile');
    await page.setViewportSize({ width: mobile ? 320 : 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://mitzo-ui.test') return route.abort();
      const path = url.pathname;
      if (path === '/fixture.js' || path === '/fixture.css')
        return route.fulfill({
          contentType: path.endsWith('.js') ? 'application/javascript' : 'text/css',
          body: files.find((file) => file.path.endsWith(path.endsWith('.js') ? '.js' : '.css'))!
            .text,
        });
      if (path.endsWith('.png') || path.endsWith('.svg'))
        return route.fulfill({
          body: await readFile(resolve('frontend/public', path.slice(1))),
          contentType: path.endsWith('.png') ? 'image/png' : 'image/svg+xml',
        });
      if (path === '/api/telos/work/links') {
        expect(route.request().postDataJSON()).toEqual({
          namespace: 'mitzo',
          conversationId: 'planning',
        });
        return route.fulfill({ json: [{ ...data.work.links[0], itemId: 'studio' }] });
      }
      expect(route.request().method()).toBe('GET');
      if (path === '/api/telos/work/items/studio') return route.fulfill({ json: data.work });
      if (path === '/api/telos/work/items/studio/sources/' + data.source.snapshot.snapshotId)
        return route.fulfill({ json: data.source });
      if (path === '/api/telos/items/studio/artifacts')
        return route.fulfill({ json: { artifacts: data.outputs, limit: 100 } });
      if (path === '/api/todos')
        return route.fulfill({
          json: {
            items: [{ id: 'studio', summary: 'Home studio', children: [] }],
            profiles: ['personal'],
          },
        });
      if (path === '/fixture-messages') return route.fulfill({ json: data.messages });
      if (path.startsWith('/api/')) return route.fulfill({ json: { outputs: [], blocks: [] } });
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'light' ? 'blue' : 'mint'}" data-font="georgia"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:100%;margin:0}.chat-page{min-height:0}.workspace-work{padding:var(--page-gutter)}.todo-detail-source-content>span{display:block}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.goto('/todos/studio');
    await expect(page.getByText('0 saved files')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`telos-item-sources-${theme}.png`) });
    await page.getByRole('button', { name: 'Open original chat' }).click();
    await expect(page).toHaveURL(new RegExp('/chat/planning\\?telosItem=studio&telosSource='));
    const anchor = page.locator('[data-telos-source-anchor="true"]');
    await expect(anchor).toContainText('Use the approved acoustic plan.');
    await expect(anchor).toBeInViewport();
    await expect(page.getByRole('link', { name: 'Home studio', exact: true })).toBeVisible();
    await expect(page.getByText('Studio discussion 60:', { exact: false })).toBeAttached();
    const scroll = page.locator('.chat-messages');
    expect(await scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const input = page.getByRole('textbox', { name: 'Message Mitzo' });
    await input.fill('Keep my draft');
    await page.getByRole('button', { name: 'Open session tray' }).click();
    const resources = page.getByRole('dialog', { name: 'Resources', exact: true });
    await expect(resources.getByRole('link', { name: 'Home studio', exact: true })).toBeVisible();
    await resources.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(input).toHaveValue('Keep my draft');

    const height = await page.locator('.telos-chat-context').boundingBox();
    expect(height!.height).toBeLessThan(90);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`telos-source-${theme}.png`) });
    await page.getByRole('link', { name: 'Home studio', exact: true }).click();
    await expect(page).toHaveURL(/\/todos\/studio$/);
    await expect(page.getByRole('button', { name: 'Open original chat' })).toBeVisible();
    expect(errors).toEqual([]);
  });
