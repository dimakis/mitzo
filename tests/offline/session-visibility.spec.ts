import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';

const bundle = build({
  plugins: [chatStorageBootstrap()],
  entryPoints: [resolve('tests/fixtures/session-library.tsx')],
  bundle: true,
  external: ['/*.png', '/*.svg'],
  write: false,
  outfile: '/tmp/hidden-chats-fixture.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});
for (const surface of ['/sessions', '/panel'])
  for (const theme of ['light', 'dark'])
    test(`hidden chats: history, restore and guarded cleanup ${surface} ${theme}`, async ({
      page,
      isMobile,
    }, testInfo) => {
      test.skip(isMobile && surface === '/panel', 'The sidebar is a desktop surface.');
      let hidden = false,
        failRestore = true;
      const writes: string[] = [];
      const chat = {
        id: 'completed',
        summary: 'Completed release work',
        lastModified: 100,
        resourcesReleased: false,
        canRestore: true,
      };
      await page.addInitScript(
        ({ theme }) => {
          class OfflineEventSource extends EventTarget {
            readyState = 1;
            onopen: (() => void) | null = null;
            constructor() {
              super();
              queueMicrotask(() => this.onopen?.());
            }
            close() {}
          }
          Object.assign(window, { EventSource: OfflineEventSource });
          localStorage.setItem('mitzo-session-view-mode', 'all');
          localStorage.setItem('mitzo-theme', theme);
          localStorage.setItem('mitzo-accent', theme === 'light' ? 'teal' : 'mint');
          localStorage.setItem('mitzo-font', theme === 'light' ? 'georgia' : 'system');
        },
        { theme },
      );
      const files = (await bundle).outputFiles!;
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url()),
          path = url.pathname;
        if (url.hostname !== 'mitzo-ui.test') return route.abort();
        if (route.request().method() !== 'GET') writes.push(`${route.request().method()} ${path}`);
        if (path === '/api/sessions/completed/visibility') {
          if (route.request().postDataJSON().hidden) {
            hidden = true;
            return route.fulfill({ json: { ok: true } });
          }
          if (failRestore)
            return route.fulfill({ status: 409, json: { error: 'Review recovery first.' } });
          hidden = false;
          return route.fulfill({ json: { ok: true } });
        }
        if (path === '/api/sessions/hidden')
          return route.fulfill({ json: { sessions: hidden ? [chat] : [], hasMore: false } });
        if (path === '/api/sessions')
          return route.fulfill({ json: { sessions: hidden ? [] : [chat], hasMore: false } });
        if (path.endsWith('/read-state'))
          return route.fulfill({
            json: { latestReplySeq: 0, readReplySeq: 0, markedUnread: false, revision: 0 },
          });
        if (path.endsWith('/messages'))
          return route.fulfill({
            json: [
              {
                messageId: 'reply',
                role: 'assistant',
                blocks: [
                  {
                    blockId: 'text',
                    blockType: 'text',
                    content: 'The pull request was merged. Saved history remains available.',
                  },
                ],
              },
            ],
          });
        if (path.endsWith('/deletion-preview'))
          return route.fulfill({
            json: {
              sandbox: null,
              needsPreparation: false,
              localWorkspace: {
                action: 'retain',
                reason:
                  'The runtime will stop. This workspace stays at its current location for review; deleting the chat will not reclaim its disk space.',
              },
            },
          });
        if (path.startsWith('/api/')) return route.fulfill({ json: {} });
        if (path.endsWith('.png') || path.endsWith('.svg'))
          return route.fulfill({ status: 404, body: '' });
        const file = files.find((file) =>
          path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'),
        );
        if (file)
          return route.fulfill({
            body: file.text,
            contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          });
        return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><link rel="stylesheet" href="/fixture.css"><script type="module" src="/fixture.js"></script></html>',
        });
      });
      await page.goto(surface);
      const row = page
        .locator(surface === '/panel' ? '.session-panel-item' : '.session-item')
        .filter({ hasText: chat.summary });
      await row.getByRole('button', { name: `Actions for ${chat.summary}` }).click();
      await page
        .getByRole(isMobile ? 'button' : 'menuitem', { name: 'Hide conversation', exact: true })
        .click();
      await expect(row).toHaveCount(0);
      const openHidden = async () => {
        if (surface === '/sessions')
          await page.getByLabel('Conversation options', { exact: true }).click();
        await page.getByRole('button', { name: 'Hidden chats', exact: true }).click();
        await page.getByRole('button', { name: chat.summary, exact: true }).click();
      };
      await openHidden();
      await expect(
        page.getByText('The pull request was merged. Saved history remains available.'),
      ).toBeVisible();
      expect(writes).toEqual(['POST /api/sessions/completed/visibility']);
      await page.getByRole('button', { name: 'Restore chat', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveText('Review recovery first.');
      await page.screenshot({
        path: testInfo.outputPath(`hidden-history-${surface.slice(1)}-${theme}.png`),
      });
      failRestore = false;
      await page.getByRole('button', { name: 'Restore chat', exact: true }).click();
      await expect(page.getByText('No hidden chats.', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: `Actions for ${chat.summary}` }).click();
      await page
        .getByRole(isMobile ? 'button' : 'menuitem', { name: 'Hide conversation', exact: true })
        .click();
      await openHidden();
      const before = writes.length;
      await page.getByRole('button', { name: 'Review resource cleanup', exact: true }).click();
      await expect(page.getByText(/will not reclaim its disk space/)).toBeVisible();
      expect(writes.length).toBe(before);
      await page.screenshot({
        path: testInfo.outputPath(`hidden-cleanup-${surface.slice(1)}-${theme}.png`),
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
