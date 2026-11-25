import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';

// Additive coverage uses the existing production-consumer fixture without
// changing the fingerprinted session-library design contract.
const bundle = build({
  plugins: [chatStorageBootstrap()],
  entryPoints: [resolve('tests/fixtures/session-library.tsx')],
  bundle: true,
  external: ['/*.png', '/*.svg'],
  write: false,
  outfile: '/tmp/session-library-shared-identity.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});

for (const theme of ['dark', 'light'])
  test(`shared discussion list and tree retain original navigation (${theme})`, async ({
    page,
    isMobile,
  }) => {
    const errors: string[] = [];
    const transcriptReads: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ theme }) => {
        class OfflineEventSource extends EventTarget {
          readyState = 1;
          close() {}
        }
        window.EventSource = OfflineEventSource as unknown as typeof EventSource;
        localStorage.setItem('mitzo-session-view-mode', 'all');
        localStorage.setItem('mitzo-theme', theme);
      },
      { theme },
    );
    const sourceId = 'original-discussion';
    // Desktop Chats selects the newest chat and loads its saved history in the
    // inspector. Keep an ordinary newer chat as that default so the shared row's
    // badge is checked without any transcript read of its own.
    const sessions = [
      {
        id: 'recent-ordinary',
        summary: 'Recent ordinary chat',
        lastModified: Date.now(),
        cwd: '/workspace/example',
        isActive: false,
      },
      {
        id: sourceId,
        summary: 'Shared design discussion',
        lastModified: Date.now() - 60_000,
        cwd: '/workspace/example',
        isActive: false,
        sharedConversation: {
          collaborationId: 'canonical-discussion',
          sourceConversationId: sourceId,
          membershipRevision: 3,
          participantSessionIds: [sourceId, 'joined-peer'],
          unavailableParticipantSessionIds: ['joined-peer'],
        },
      },
    ];
    const files = (await bundle).outputFiles!;
    await page.route('**/*', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/messages')) transcriptReads.push(path);
      if (path === '/api/sessions') return route.fulfill({ json: { sessions, hasMore: false } });
      if (path === '/api/config') return route.fulfill({ json: { quickActions: [] } });
      if (path === '/api/version') return route.fulfill({ json: { updateAvailable: false } });
      if (path === '/api/telos/work/collection')
        return route.fulfill({ json: { profiles: [], records: [], failures: [] } });
      if (path.startsWith('/api/')) return route.fulfill({ json: [] });
      if (path.endsWith('.svg') || path.endsWith('.png')) return route.abort();
      const file = files.find((file) => path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'));
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({ width: isMobile ? 390 : 1280, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/sessions');
    const list = page.locator('.session-list');
    await expect(list.getByText('Symposium · 2 agents', { exact: true })).toBeVisible();
    await expect(list.getByText('1 unavailable', { exact: true })).toBeVisible();
    await expect(list.getByText('Recent ordinary chat', { exact: true })).toBeVisible();
    expect(transcriptReads.filter((path) => path.includes(sourceId))).toEqual([]);
    if (isMobile) expect(transcriptReads).toEqual([]);
    await list.getByText('Shared design discussion', { exact: true }).click();
    if (!isMobile)
      await page.getByRole('button', { name: 'Open conversation', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Opened conversation' })).toHaveAttribute(
      'data-session-id',
      sourceId,
    );
    await page.getByRole('button', { name: 'Opened conversation' }).click();
    await page.getByRole('button', { name: 'Tree', exact: true }).click();
    const tree = page.getByRole('navigation', { name: 'Conversation tree' });
    await expect(tree.getByText('Symposium · 2 agents', { exact: true })).toBeVisible();
    await expect(tree.getByText('1 unavailable', { exact: true })).toBeVisible();
    await tree.getByRole('button', { name: /^Shared design discussion/ }).click();
    await expect(page.getByRole('button', { name: 'Opened conversation' })).toHaveAttribute(
      'data-session-id',
      sourceId,
    );
    expect(errors).toEqual([]);
  });
