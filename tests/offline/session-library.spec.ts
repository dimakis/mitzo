import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitForNewFixtureReads } from '../support/fixture-reads';
const sessionListReads = ['/api/todos', '/api/sessions', '/api/config', '/api/version'];
const sessions = Array.from({ length: 12 }, (_, index) => ({
  id: `session-${index}`,
  summary:
    index === 0
      ? 'A very long technical conversation identifier with enough context to wrap cleanly without clipping its title'
      : `Conversation ${index}`,
  lastModified: Date.now() - index * 3600000,
  cwd: '/workspace/mgmt',
  model: index % 2 ? 'claude-opus-4-8' : 'gpt-6.1-sol',
  accountLabel: index % 2 ? 'Work' : 'Personal',
  totalTokens: 1200000,
  isActive: false,
  telosTaskId: index === 1 ? 'work-one' : undefined,
  contextUsage: {
    used: 48000,
    measuredAt: Date.now(),
    limits: { model: 'fixture', source: 'runtime', contextWindow: 200000, stale: false },
  },
}));
const bundle = build({
  entryPoints: [resolve('tests/fixtures/session-library.tsx')],
  bundle: true,
  external: ['/*.png', '/*.svg'],
  write: false,
  outfile: '/tmp/session-library-fixture.js',
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
  test(`session library: pinned groups, gestures, actions and context (${theme})`, async ({
    page,
    isMobile,
  }, testInfo) => {
    const accent = theme === 'light' ? 'blue' : 'mint';
    const font = theme === 'light' ? 'arial' : 'georgia';
    const errors: string[] = [],
      mutations: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ theme, accent, font }) => {
        class OfflineEventSource extends EventTarget {
          readyState = 1;
          constructor() {
            super();
            window.addEventListener('offline-session-activity', (event) => {
              this.dispatchEvent(
                new MessageEvent('session_activity', {
                  data: JSON.stringify((event as CustomEvent).detail),
                }),
              );
            });
          }
          close() {}
        }
        window.EventSource = OfflineEventSource as unknown as typeof EventSource;
        localStorage.setItem('mitzo-session-view-mode', 'all');
        localStorage.setItem('mitzo-theme', theme);
        localStorage.setItem('mitzo-accent', accent);
        localStorage.setItem('mitzo-font', font);
        if (!sessionStorage.getItem('pins-seeded')) {
          localStorage.setItem('mitzo-today-tokens', 'true');
          localStorage.setItem(
            'mitzo-conversation-pins',
            JSON.stringify(
              Array.from({ length: 6 }, (_, i) => ({
                id: `session-${i + 1}`,
                summary: `Conversation ${i + 1}`,
                lastModified: 1,
              })),
            ),
          );
          sessionStorage.setItem('pins-seeded', 'true');
        }
        document.addEventListener('DOMContentLoaded', () => {
          document.body.style.cssText = 'height:100dvh;overflow:hidden';
        });
      },
      { theme, accent, font },
    );
    const files = (await bundle).outputFiles!;
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url()),
        path = url.pathname;
      if (url.hostname !== 'mitzo-ui.test') return route.abort();
      if (route.request().method() !== 'GET') {
        mutations.push(path);
        return route.abort();
      }
      if (path.startsWith('/api/sessions/') && path.endsWith('/messages'))
        return route.fulfill({
          json: [
            {
              messageId: path,
              role: 'assistant',
              blocks: [
                {
                  blockType: 'text',
                  content:
                    'Saved history for ' +
                    path +
                    '\n\n' +
                    'Readable conversation context. '.repeat(60),
                },
              ],
            },
          ],
        });
      const data: Record<string, unknown> = {
        '/api/sessions': { sessions, hasMore: false },
        '/api/sessions/older-pin/context': {
          sessionId: 'older-pin',
          contextUsage: sessions[0].contextUsage,
        },
        '/api/config': { quickActions: [] },
        '/api/sessions/search': {
          results: [
            {
              sessionId: 'search-only',
              summary: 'Search-only conversation',
              snippet: 'Matching saved message',
              updatedAt: 1,
            },
          ],
        },
        '/api/briefings/latest': null,
        '/api/version': { updateAvailable: false },
        '/api/home/preferences': {
          revision: 1,
          names: { briefing: 'Minion', terminal: 'Minion' },
          showDailyQuote: false,
          pins: [
            { kind: 'session', id: 'session-0', title: sessions[0].summary },
            { kind: 'session', id: 'older-pin', title: 'Older pinned conversation' },
          ],
        },
        '/api/todos': {
          profiles: [],
          items: [{ id: 'work-one', summary: 'Linked quarterly review', children: [] }],
        },
        '/api/service-health': { services: [] },
        '/api/home/quote': null,
      };
      if (path in data) return route.fulfill({ json: data[path] });
      if (path.startsWith('/api/')) return route.fulfill({ json: [] });
      if (path.endsWith('.png') || path.endsWith('.svg'))
        return route.fulfill({
          body: await readFile(resolve('frontend/public', path.slice(1))),
          contentType: path.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        });
      const file = files.find((file) => path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'));
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${accent}" data-font="${font}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({ width: isMobile ? 390 : 1280, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/sessions');
    await expect(page.getByRole('button', { name: 'New chat', exact: true })).toBeVisible();
    const pinned = page.getByRole('region', { name: 'Pinned conversations' });
    await expect(pinned.locator('.conversation-pin-row')).toHaveCount(6);
    expect(await pinned.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await page.getByRole('button', { name: 'Collapse pinned conversations' }).click();
    await expect(pinned).toBeHidden();
    await page.getByRole('button', { name: 'Expand pinned conversations' }).click();
    await page.screenshot({ path: testInfo.outputPath(`session-library-top-${theme}.png`) });
    const first = page.getByRole(isMobile ? 'link' : 'button', {
      name: `${isMobile ? 'Open' : 'Preview'} ${sessions[0].summary}`,
    });
    await expect(first.getByLabel('Model: gpt-6.1-sol')).toBeVisible();
    await expect(first.getByText('Personal', { exact: true })).toBeVisible();
    const activity = (index: number, state: string, extra: Record<string, unknown> = {}) => ({
      sessionId: sessions[index].id,
      clientId: `client-${index}`,
      title: sessions[index].summary,
      state,
      flags: [],
      lastEventAt: sessions[index].lastModified,
      ...extra,
    });
    await page.evaluate(
      (activities) => {
        window.dispatchEvent(new CustomEvent('offline-session-activity', { detail: activities }));
      },
      [
        activity(1, 'waiting', { waitReason: 'permission' }),
        activity(2, 'done', { awaitingReply: true }),
        activity(3, 'idle', { uncommittedWork: true }),
        activity(4, 'waiting', { waitReason: 'blocked' }),
      ],
    );
    await expect(page.getByRole('button', { name: 'Needs you 1', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Needs you 1', exact: true }).click();
    await expect(page.locator('.session-list .session-item-navigation')).toHaveCount(1);
    await expect(page.locator('.session-list').getByText('Permission needed')).toBeVisible();
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('offline-session-activity', { detail: [] }));
    });
    await expect(page.getByRole('button', { name: 'Needs you 0', exact: true })).toBeVisible();
    await expect(page.getByText('Nothing needs you right now')).toBeVisible();
    await page.getByRole('button', { name: 'All', exact: true }).click();
    if (isMobile) {
      await expect(first.locator('.session-item-summary')).toHaveCSS('display', 'block');
      const box = await first.boundingBox();
      await first.evaluate(
        (element, point) => {
          const event = new Event('touchstart', { bubbles: true });
          Object.defineProperty(event, 'touches', { value: [point] });
          element.dispatchEvent(event);
        },
        { clientX: box!.x + 8, clientY: box!.y + 8 },
      );
      const dialog = page.getByRole('dialog', { name: `Preview ${sessions[0].summary}` });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Unpin from Today', exact: true })).toHaveCSS(
        'display',
        'flex',
      );
      const deleteAction = await dialog
        .getByRole('button', { name: 'Delete conversation' })
        .boundingBox();
      expect(deleteAction!.y + deleteAction!.height).toBeLessThanOrEqual(844);
      await page.screenshot({ path: testInfo.outputPath(`session-preview-${theme}.png`) });
      await dialog.getByText('Session details', { exact: true }).click();
      const cumulative = dialog.getByText('Cumulative usage: 1.2M tokens');
      await cumulative.scrollIntoViewIfNeeded();
      await expect(cumulative).toBeInViewport();
      await expect(dialog.getByRole('button', { name: 'Delete conversation' })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`session-preview-usage-${theme}.png`) });
      await dialog.getByRole('button', { name: 'Close preview' }).click();
      await page.locator('.session-list-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
      await expect(page.getByText('Conversation 11', { exact: true })).toBeVisible();
      const last = await page.getByText('Conversation 11', { exact: true }).boundingBox(),
        nav = await page.locator('.workspace-tabs').boundingBox();
      expect(last!.y + last!.height).toBeLessThanOrEqual(nav!.y + 1);
      await page.setViewportSize({ width: 320, height: 740 });
    } else {
      await expect(
        page
          .getByRole('complementary', { name: 'Conversation preview' })
          .getByText(/Saved history/),
      ).toBeVisible();
      const divider = page.getByRole('separator', { name: 'Resize conversation preview' });
      await divider.focus();
      await page.keyboard.press('ArrowLeft');
      await expect(divider).toHaveAttribute('aria-valuenow', '38');
      const box = await divider.boundingBox();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + 100);
      await page.mouse.down();
      await page.mouse.move(box!.x - 40, box!.y + 100, { steps: 4 });
      await page.mouse.up();
      expect(Number(await divider.getAttribute('aria-valuenow'))).toBeGreaterThan(38);
      await first.click({ button: 'right' });
      await expect(page.getByRole('menuitem', { name: 'Preview conversation' })).toHaveCount(0);
      await page.getByRole('menuitem', { name: 'Pin conversation', exact: true }).click();
      await expect(pinned.locator('.conversation-pin-row')).toHaveCount(7);
      await page.goto('/panel');
      await page.locator('.session-panel-select').first().click({ button: 'right' });
      await expect(page.getByRole('menuitem', { name: 'Unpin conversation' })).toBeVisible();
      await page.keyboard.press('Escape');
      // List refresh and saved-history errors have independent retry controls.
      await page.route('**/api/sessions/*/messages', (route) =>
        route.fulfill({ status: 503, json: {} }),
      );
      await page.goto('/sessions');
      await expect(
        page
          .getByRole('complementary', { name: 'Conversation preview' })
          .getByRole('button', { name: 'Try again' }),
      ).toBeVisible();
      await page.route('**/api/sessions', (route) => route.fulfill({ status: 503, json: {} }));
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      const listError = page.getByRole('alert');
      await expect(listError).toContainText('Couldn’t refresh chats');
      await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(2);
      await page.unroute('**/api/sessions');
      await listError.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(listError).toHaveCount(0);
      await page.unroute('**/api/sessions/*/messages');
    }
    await page.screenshot({ path: testInfo.outputPath(`session-library-${theme}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    // Opening works directly from recent, pinned and search rows. Single desktop
    // clicks keep previewing; a mobile tap keeps its existing immediate navigation.
    for (const kind of ['recent', 'pin', 'search']) {
      if (kind === 'search')
        await page.getByRole('searchbox', { name: 'Search conversations' }).fill('Matching');
      const row =
        kind === 'pin'
          ? page
              .getByRole('region', { name: 'Pinned conversations' })
              .getByRole('button', { name: /^Conversation 1 / })
          : page.getByRole(isMobile ? 'link' : 'button', {
              name: `${isMobile ? 'Open' : 'Preview'} ${kind === 'search' ? 'Search-only conversation' : 'Conversation 2'}`,
            });
      if (isMobile) await row.tap();
      else await row.click();
      if (!isMobile) {
        await expect(page.getByRole('button', { name: 'Opened conversation' })).toHaveCount(0);
        await expect(
          page.getByRole('complementary', { name: 'Conversation preview' }).getByRole('heading', {
            name:
              kind === 'pin'
                ? 'Conversation 1'
                : kind === 'search'
                  ? 'Search-only conversation'
                  : 'Conversation 2',
          }),
        ).toBeVisible();
        await row.dblclick();
      }
      await expect(page.getByRole('button', { name: 'Opened conversation' })).toBeVisible();
      await waitForNewFixtureReads(page, sessionListReads, () =>
        page.getByRole('button', { name: 'Opened conversation' }).click(),
      );
    }
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Today', exact: true })
      .click();
    await expect(page.getByRole('meter', { name: 'Context used' }).first()).toHaveAttribute(
      'aria-valuenow',
      '24',
    );
    await expect(
      page.getByRole('link', { name: /Older pinned conversation/ }).getByRole('meter'),
    ).toHaveAttribute('aria-valuenow', '24');
    await page.screenshot({ path: testInfo.outputPath(`session-context-${theme}.png`) });
    await page.goto('/settings');
    const toggle = page.getByRole('checkbox', { name: 'Show session context on Today' });
    await expect(toggle).toBeChecked();
    await toggle.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`session-appearance-${theme}.png`) });
    await toggle.uncheck();
    await page.goto('/');
    await expect(page.locator('.session-context-usage')).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(mutations).toEqual([]);
  });

test('session library: returning waits for newly started reads before a hard reload', async ({
  page,
  isMobile,
}) => {
  const errors: string[] = [],
    mutations: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    class OfflineEventSource extends EventTarget {
      readyState = 2;
      close() {}
    }
    window.EventSource = OfflineEventSource as unknown as typeof EventSource;
  });
  const files = (await bundle).outputFiles!;
  const held = new Map<string, () => void>();
  let holdReads = false;
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (route.request().method() !== 'GET') {
      mutations.push(url.pathname);
      return route.abort();
    }
    if (holdReads && sessionListReads.includes(url.pathname))
      await new Promise<void>((release) => {
        held.set(`${url.search ? 'earlier' : 'return'}:${url.pathname}`, release);
      });
    const data: Record<string, unknown> = {
      '/api/sessions': { sessions, hasMore: false },
      '/api/config': { quickActions: [] },
      '/api/version': { updateAvailable: false },
      '/api/todos': {
        profiles: [],
        items: [{ id: 'work-one', summary: 'Linked quarterly review', children: [] }],
      },
      '/api/briefings/latest': null,
      '/api/home/quote': null,
      '/api/service-health': { services: [] },
      '/api/home/preferences': {
        revision: 1,
        names: { briefing: 'Minion', terminal: 'Minion' },
        showDailyQuote: false,
        pins: [],
      },
    };
    if (url.pathname in data) return route.fulfill({ json: data[url.pathname] });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: [] });
    if (url.pathname.endsWith('.png') || url.pathname.endsWith('.svg'))
      return route.fulfill({
        body: await readFile(resolve('frontend/public', url.pathname.slice(1))),
        contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
      });
    const file = files.find((file) =>
      url.pathname.endsWith(file.path.endsWith('.css') ? '.css' : '.js'),
    );
    if (file)
      return route.fulfill({
        body: file.text,
        contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
      });
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>',
    });
  });
  const initialRequests = Promise.all(
    sessionListReads.map((path) =>
      page.waitForRequest((request) => new URL(request.url()).pathname === path),
    ),
  );
  await page.goto('/sessions');
  for (const request of await initialRequests) {
    const response = await request.response();
    expect(response).not.toBeNull();
    expect(await response!.finished()).toBeNull();
  }
  await expect(page.getByRole('link', { name: 'Linked quarterly review' })).toBeVisible();
  const row = page.getByRole(isMobile ? 'link' : 'button', {
    name: `${isMobile ? 'Open' : 'Preview'} Conversation 2`,
  });
  if (isMobile) await row.tap();
  else await row.dblclick();
  const returnButton = page.getByRole('button', { name: 'Opened conversation' });
  await expect(returnButton).toBeVisible();
  holdReads = true;
  // Earlier requests have the same paths. Finishing those responses must not
  // satisfy the witnesses for the reads caused by the actual return click.
  const earlierRequests = Promise.all(
    sessionListReads.map((path) =>
      page.waitForRequest((request) => new URL(request.url()).pathname === path),
    ),
  );
  await page.evaluate((paths) => {
    void Promise.all(paths.map((path) => fetch(`${path}?barrier=earlier`)));
  }, sessionListReads);
  const earlier = await earlierRequests;
  await expect.poll(() => held.size).toBe(4);
  let clicked = false,
    returned = false;
  const returning = waitForNewFixtureReads(page, sessionListReads, async () => {
    await returnButton.click();
    clicked = true;
  }).then(() => {
    returned = true;
  });
  try {
    await expect.poll(() => held.size).toBe(8);
    await expect.poll(() => clicked).toBe(true);
    for (const path of sessionListReads) held.get(`earlier:${path}`)!();
    for (const request of earlier) {
      const response = await request.response();
      expect(response).not.toBeNull();
      expect(await response!.finished()).toBeNull();
    }
    expect(returned).toBe(false);
  } finally {
    holdReads = false;
    for (const release of held.values()) release();
    await returning;
  }
  expect(returned).toBe(true);
  // Keep the real cross-document reload and the same strict error checks.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  expect(mutations).toEqual([]);
});
