import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createTelosWorkFixtures } from '../../frontend/src/test-utils/telos-work-fixtures';

test.use({ baseURL: 'https://mitzo-ui.test' });
const bundle = build({
  entryPoints: [resolve('tests/fixtures/telos-chat-routes.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  write: false,
  outfile: '/tmp/telos-chooser-hydration.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});
for (const theme of ['dark', 'light'])
  test(`same item keeps original focused provenance through collection and related hydration (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const files = (await bundle).outputFiles!;
    const source = createTelosWorkFixtures().homeStudio.items[0];
    const root = { ...source, itemId: 'studio', parentId: 'parent' };
    const parent = {
      ...source,
      itemId: 'parent',
      parentId: null,
      summary: 'Recording programme',
      kind: 'coordinator',
    };
    const work = {
      itemId: 'studio',
      kind: 'outcome',
      parentId: 'parent',
      revision: 'a'.repeat(64),
      sources: [],
      attempts: [],
      assignments: [],
      links: ['origin', 'discussion'].map((id) => ({
        version: 1,
        linkId: id,
        itemId: 'studio',
        role: id === 'origin' ? 'origin' : 'lead',
        conversation: { namespace: 'mitzo', conversationId: id },
        linkedAt: '2026-10-16T10:00:00Z',
        linkedBy: 'operator:fixture',
        availability: 'available',
        attemptId: null,
      })),
    };
    const legacy = {
      ...root,
      id: 'studio',
      urgency: 0.5,
      ageDays: 0,
      children: [],
      childCount: 0,
      completedChildCount: 0,
      goalId: null,
    };
    let releaseCollection!: () => void,
      releaseParent!: () => void,
      primaryReads = 0,
      parentReads = 0;
    const collectionGate = new Promise<void>((resolve) => {
      releaseCollection = resolve;
    });
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    const errors: string[] = [],
      writes: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const file = files.find(
        (file) => path === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (path.startsWith('/todos'))
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
        });
      if (route.request().method() !== 'GET') {
        writes.push(path);
        return route.fulfill({ status: 405, json: { error: 'No writes' } });
      }
      if (path === '/api/todos') {
        await collectionGate;
        return route.fulfill({ json: { profiles: ['manual'], items: [legacy] } });
      }
      if (path === '/api/telos/work/items/studio/record') {
        primaryReads++;
        return route.fulfill({ json: root });
      }
      if (path === '/api/telos/work/items/parent/record') {
        parentReads++;
        await parentGate;
        return route.fulfill({ json: parent });
      }
      if (path === '/api/telos/work/items/studio') return route.fulfill({ json: work });
      if (path === '/api/sessions')
        return route.fulfill({
          json: {
            sessions: [
              { id: 'origin', summary: 'Original planning', lastModified: 1 },
              { id: 'discussion', summary: 'Independent discussion', lastModified: 1 },
            ],
            hasMore: false,
          },
        });
      const metadata = path.match(/^\/api\/sessions\/(origin|discussion)\/meta$/);
      if (metadata)
        return route.fulfill({
          json: { sessionId: metadata[1], createdAt: Date.parse('2026-10-16T10:00:00Z') },
        });
      if (path.includes('/artifacts'))
        return route.fulfill({ json: { artifacts: [], hasMore: false } });
      if (path === '/api/home/preferences')
        return route.fulfill({
          json: { revision: 0, names: { briefing: 'Minion', terminal: 'Minion' }, pins: [] },
        });
      if (path === '/api/service-health')
        return route.fulfill({ json: { services: [], checkedAt: 1 } });
      if (['/mitzo-icon.png', '/mitzo-wordmark.png'].includes(path))
        return route.fulfill({
          body: await readFile('frontend/public' + path),
          contentType: 'image/png',
        });
      return route.fulfill({
        json:
          path.includes('skills') || path.includes('proposals') || path.includes('briefing-chats')
            ? []
            : {},
      });
    });
    await page.goto('/todos/studio?view=Chat&chooseChat=1');
    const opener = page.getByRole('button', {
      name: 'Open Originating conversation: Original planning',
      exact: true,
    });
    await expect(opener).toBeVisible();
    const summary = opener.locator('..').locator('summary');
    const original = (await summary.elementHandle())!;
    await summary.focus();
    await page.keyboard.press('Enter');
    const identity = () =>
      original.evaluate((node) => ({
        connected: node.isConnected,
        focused: document.activeElement === node,
        open: (node.parentElement as HTMLDetailsElement).open,
        current: node === document.querySelector('.telos-chat-provenance summary'),
      }));
    expect(await identity()).toEqual({ connected: true, focused: true, open: true, current: true });
    releaseCollection();
    await expect.poll(() => parentReads).toBeGreaterThan(0);
    expect(await identity()).toEqual({ connected: true, focused: true, open: true, current: true });
    releaseParent();
    await expect(
      page.getByRole('button', { name: 'Recording programme', exact: true }),
    ).toBeVisible();
    expect(await identity()).toEqual({ connected: true, focused: true, open: true, current: true });
    expect(primaryReads).toBe(1);
    await page.keyboard.press('Enter');
    await expect(summary.locator('..')).not.toHaveAttribute('open', '');
    await expect(summary).toBeFocused();
    expect(errors).toEqual([]);
    expect(writes).toEqual([]);
    await page.screenshot({
      path: info.outputPath(`hydrated-chooser-${theme}.png`),
      fullPage: true,
    });
  });
