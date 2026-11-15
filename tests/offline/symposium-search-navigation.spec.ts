import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';

const bundle = build({
  plugins: [chatStorageBootstrap()],
  entryPoints: [resolve('tests/fixtures/session-library.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/symposium-search-navigation.js',
  external: ['/*.png', '/*.svg'],
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});

for (const theme of ['light', 'dark'])
  test(`grouped search previews and opens the exact participant history (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const historyReads: string[] = [],
      errors: string[] = [],
      mutations: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        close() {}
      } as unknown as typeof EventSource;
      localStorage.setItem('mitzo-session-view-mode', 'all');
    });
    const files = (await bundle).outputFiles!;
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'mitzo-ui.test') return route.abort();
      const path = url.pathname;
      if (route.request().method() !== 'GET') {
        mutations.push(path);
        return route.abort();
      }
      if (path === '/api/sessions')
        return route.fulfill({ json: { sessions: [], hasMore: false } });
      if (path === '/api/sessions/search')
        return route.fulfill({
          json: {
            results: [
              {
                sessionId: 'source',
                matchedSessionId: 'participant',
                summary: 'Original discussion',
                snippet: 'Participant-only evidence',
                matchedAt: 100,
                updatedAt: 500,
              },
            ],
          },
        });
      if (path.endsWith('/messages')) {
        historyReads.push(path);
        return route.fulfill({
          json: [
            {
              messageId: 'answer',
              role: 'assistant',
              blocks: [
                { blockId: 'text', blockType: 'text', content: `Saved evidence from ${path}` },
              ],
            },
          ],
        });
      }
      if (path.startsWith('/api/')) return route.fulfill({ json: {} });
      const file = path.endsWith('.css')
        ? files.find((f) => f.path.endsWith('.css'))
        : path.endsWith('.js')
          ? files.find((f) => f.path.endsWith('.js'))
          : undefined;
      return route.fulfill(
        file
          ? { body: file.text, contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' }
          : {
              contentType: 'text/html',
              body: `<!doctype html><html data-theme="${theme}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
            },
      );
    });
    await page.goto('/sessions');
    await page.getByRole('searchbox', { name: 'Search conversations' }).fill('Participant-only');
    const row = page.getByRole(isMobile ? 'link' : 'button', {
      name: `${isMobile ? 'Open' : 'Preview'} Original discussion`,
    });
    await expect(row).toBeVisible();
    if (isMobile) await row.tap();
    else {
      await row.click();
      const inspector = page.getByRole('complementary', { name: 'Conversation preview' });
      await expect(inspector.locator('.session-history')).toContainText(
        '/api/sessions/participant/messages',
      );
      await expect(inspector.getByRole('heading', { name: 'Original discussion' })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`grouped-search-${theme}.png`) });
      await inspector.getByRole('button', { name: 'Open conversation', exact: true }).click();
      expect(historyReads).toEqual(['/api/sessions/participant/messages']);
    }
    await expect(page.getByRole('button', { name: 'Opened conversation' })).toHaveAttribute(
      'data-session-id',
      'participant',
    );
    expect(errors).toEqual([]);
    expect(mutations).toEqual([]);
  });
