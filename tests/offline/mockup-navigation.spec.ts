import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HTML_PREVIEW_BOOTSTRAP, htmlPreviewPolicy } from '../../server/html-preview-shell';
import { deployedSecurityHeaders } from '../support/response-security';
const bundle = build({
  entryPoints: [resolve('tests/fixtures/mockup-navigation.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mockup-navigation.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});
for (const theme of ['dark', 'light'])
  test(`More opens a saved chat's mockups without attaching it (${theme})`, async ({
    page,
  }, info) => {
    const compiled = await bundle;
    const histories: string[] = [];
    let failed = false;
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 900,
    });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme as 'dark' | 'light' });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      expect(route.request().method()).toBe('GET');
      if (url.origin !== 'http://mitzo-ui.test') return route.abort();
      if (['/fixture.js', '/fixture.css'].includes(url.pathname))
        return route.fulfill({
          contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css',
          body: compiled.outputFiles.find((file) =>
            file.path.endsWith(url.pathname.endsWith('.js') ? '.js' : '.css'),
          )!.text,
        });
      if (url.pathname === '/api/sessions')
        return route.fulfill({
          json: [{ id: 'saved-chat', summary: 'Product exploration', lastModified: 1 }],
        });
      if (url.pathname === '/api/sessions/search')
        return route.fulfill({
          json: {
            results: [
              {
                sessionId: 'saved-chat',
                summary: 'Product exploration',
                snippet: 'release',
                updatedAt: 1,
                matchedAt: 1,
              },
            ],
          },
        });
      if (url.pathname === '/api/sessions/saved-chat/messages') {
        histories.push(url.pathname);
        if (!failed) {
          failed = true;
          return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
        }
        return route.fulfill({
          json: [
            {
              messageId: 'm',
              role: 'assistant',
              blocks: [
                {
                  blockId: 'b',
                  blockType: 'text',
                  content: '[Release checklist](/task/mockups/release/v001.html)',
                },
              ],
            },
          ],
        });
      }
      if (url.pathname === '/api/html-preview')
        return route.fulfill({
          contentType: 'text/html',
          headers: { 'content-security-policy': htmlPreviewPolicy() },
          body: HTML_PREVIEW_BOOTSTRAP,
        });
      if (url.pathname === '/api/files/read') {
        expect(url.searchParams.get('sessionId')).toBe('saved-chat');
        return route.fulfill({
          json: {
            path: '/task/mockups/release/v001.html',
            content:
              '<h1>Release checklist</h1><button onclick="this.textContent=\'Ready\'">Mark ready</button>',
          },
        });
      }
      if (url.pathname === '/api/service-health')
        return route.fulfill({ json: { services: [], checkedAt: 0 } });
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
      if (['/mitzo-wordmark.png', '/openshell-mark.svg', '/github-mark.svg'].includes(url.pathname))
        return route.fulfill({
          body: await readFile(resolve('frontend/public', url.pathname.slice(1))),
          contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        });
      return route.fulfill({
        contentType: 'text/html',
        headers: deployedSecurityHeaders(),
        body: `<html data-theme="${theme}" data-accent="mint" data-font="georgia"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      });
    });
    await page.goto('/more');
    await page.getByRole('link', { name: 'Mockups', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Mockups', exact: true })).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('link', { name: 'More', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    expect(histories).toEqual([]);
    await page.getByRole('searchbox', { name: 'Find a chat' }).fill('Product');
    await page.getByRole('link', { name: 'Product exploration', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Couldn’t load');
    await page.getByRole('button', { name: 'Retry history' }).click();
    await page.getByRole('button', { name: 'Open Release checklist' }).click();
    await expect(
      page.frameLocator('iframe').getByRole('heading', { name: 'Release checklist' }),
    ).toBeVisible();
    await page.frameLocator('iframe').getByRole('button', { name: 'Mark ready' }).click();
    await expect(page.frameLocator('iframe').getByRole('button', { name: 'Ready' })).toBeVisible();
    await page.getByRole('link', { name: 'Choose another chat' }).click();
    await expect(page.getByRole('searchbox', { name: 'Find a chat' })).toHaveValue('Product');
    await expect(
      page.getByRole('link', { name: 'Product exploration', exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath(`mockups-navigation-${theme}.png`) });
    expect(histories).toHaveLength(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
  });
