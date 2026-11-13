import { createTelosWorkFixtures } from '../../frontend/src/test-utils/telos-work-fixtures';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitForNewFixtureReads } from '../support/fixture-reads';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
const linkedWork = {
  ...createTelosWorkFixtures().homeStudio.items[0],
  itemId: 'work-one',
  summary: 'Linked quarterly review',
};
const sessionListReads = [
  '/api/telos/work/collection',
  '/api/sessions',
  '/api/config',
  '/api/version',
];
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
  plugins: [chatStorageBootstrap()],
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
  for (const surface of ['/sessions', '/panel'])
    test(`conversation read state and finished grouping: ${surface} (${theme})`, async ({
      page,
      isMobile,
    }, testInfo) => {
      test.skip(isMobile && surface === '/panel', 'The desktop sidebar is a desktop surface.');
      const fixtures = sessions.slice(0, 3).map((session, index) => ({
        ...session,
        telosTaskId: undefined,
        isActive: true,
        replyReadState: {
          latestReplySeq: index + 10,
          readReplySeq: index + 10,
          markedUnread: false,
          revision: 0,
        },
      }));
      let failWrite = true;
      await page.addInitScript(
        ({ theme }) => {
          class OfflineEventSource extends EventTarget {
            readyState = 1;
            onopen: (() => void) | null = null;
            constructor() {
              super();
              queueMicrotask(() => this.onopen?.());
              window.addEventListener('offline-session-activity', (event) =>
                this.dispatchEvent(
                  new MessageEvent('session_activity', {
                    data: JSON.stringify((event as CustomEvent).detail),
                  }),
                ),
              );
            }
            close() {}
          }
          Object.assign(window, { EventSource: OfflineEventSource });
          localStorage.setItem('mitzo-session-view-mode', 'all');
          localStorage.setItem('mitzo-theme', theme);
          localStorage.setItem('mitzo-accent', theme === 'light' ? 'teal' : 'mint');
          localStorage.setItem('mitzo-font', theme === 'light' ? 'arial' : 'georgia');
        },
        { theme },
      );
      const files = (await bundle).outputFiles!;
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url()),
          path = url.pathname;
        if (url.hostname !== 'mitzo-ui.test') return route.abort();
        if (path.endsWith('/read-state')) {
          const session = fixtures.find((item) => path.includes(`/${item.id}/`))!;
          if (route.request().method() === 'PUT') {
            if (failWrite) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
            const update = route.request().postDataJSON();
            session.replyReadState = {
              ...session.replyReadState,
              readReplySeq: update.readReplySeq ?? session.replyReadState.readReplySeq,
              markedUnread: update.markedUnread === true,
              revision: session.replyReadState.revision + 1,
            };
          }
          return route.fulfill({ json: session.replyReadState });
        }
        if (path === '/api/sessions')
          return route.fulfill({ json: { sessions: fixtures, hasMore: false } });
        if (path === '/api/home/preferences')
          return route.fulfill({
            json: {
              revision: 1,
              names: { briefing: 'Mitzo', terminal: 'Mitzo' },
              pins: [],
              showDailyQuote: false,
            },
          });
        if (path.endsWith('/messages')) return route.fulfill({ json: [] });
        if (path.startsWith('/api/')) return route.fulfill({ json: {} });
        if (path.endsWith('.png') || path.endsWith('.svg'))
          return route.fulfill({
            body: await readFile(resolve('frontend/public', path.slice(1))),
            contentType: path.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
          });
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
      const selector = surface === '/panel' ? '.session-panel-item' : '.session-item';
      const row = page.locator(selector).filter({ hasText: fixtures[0].summary });
      await expect(row).toBeVisible();
      await row.click({ button: 'right' });
      const actionRole = isMobile ? 'button' : 'menuitem';
      await page.getByRole(actionRole, { name: 'Mark as unread', exact: true }).click();
      await expect(
        page.getByRole('alert').filter({ hasText: 'Couldn’t save read status' }),
      ).toBeVisible();
      failWrite = false;
      await page.getByRole(actionRole, { name: 'Mark as unread', exact: true }).click();
      await expect(row.getByLabel('Unread reply')).toBeVisible();
      if (isMobile) await page.getByRole('button', { name: 'Close preview' }).click();
      await row.click({ button: 'right' });
      await page.getByRole(actionRole, { name: 'Mark as read', exact: true }).click();
      await expect(row.getByLabel('Unread reply')).toHaveCount(0);
      if (isMobile) await page.getByRole('button', { name: 'Close preview' }).click();
      await page.evaluate(
        (detail) => window.dispatchEvent(new CustomEvent('offline-session-activity', { detail })),
        fixtures.map((session, index) => ({
          sessionId: session.id,
          clientId: session.id,
          title: session.summary,
          flags: [],
          state: index === 0 ? 'done' : 'working',
          lastEventAt: session.lastModified,
          completedAt: index === 0 ? Date.now() : undefined,
        })),
      );
      await page.getByRole('button', { name: /1 updated · [Ss]how latest/ }).click();
      await expect(page.locator(selector).last()).toContainText(fixtures[0].summary);
      await expect(page.getByRole('heading', { name: 'In progress', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Finished', exact: true })).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`conversation-read-${surface.slice(1)}-${theme}.png`),
      });
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
          onopen: (() => void) | null = null;
          constructor() {
            super();
            queueMicrotask(() => this.onopen?.());
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
        localStorage.setItem(
          'mitzo-chat-draft:visual-draft',
          JSON.stringify({
            version: 1,
            id: 'visual-draft',
            text: 'An unsent prompt',
            images: [],
            contextBlocks: [],
            updatedAt: Date.now(),
            settings: {
              selection: null,
              mode: 'agent',
              isolation: true,
              search: '',
              summary: null,
            },
          }),
        );
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
              model: 'gpt-6-luna',
              accountLabel: 'Home archive',
              snippet: 'Matching saved message',
              matchedAt: Date.now() - 90 * 86400000,
              updatedAt: Date.now() - 90 * 86400000,
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
        '/api/telos/work/collection': { profiles: [], records: [linkedWork], failures: [] },
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
    const newChat = page.getByRole('button', { name: 'New chat', exact: true });
    const pinToggle = page.getByRole('button', { name: 'Collapse pinned conversations' });
    const draftToggle = page.locator('.conversation-drafts-section > summary');
    await expect(draftToggle).toBeVisible();
    const labelGeometry = async (locator: typeof pinToggle) =>
      locator.evaluate((element) => {
        const style = getComputedStyle(element);
        const label = element.querySelector('span')!.getBoundingClientRect();
        const count = element.querySelector('span:last-child')!.getBoundingClientRect();
        const row = element.getBoundingClientRect();
        return {
          font: style.fontSize,
          weight: style.fontWeight,
          lineHeight: style.lineHeight,
          labelInset: label.left - row.left,
          countInset: row.right - count.right,
          height: row.height,
          icons: [...element.querySelectorAll('svg')].map(
            (icon) => icon.getBoundingClientRect().width,
          ),
        };
      });
    const pinGeometry = await labelGeometry(pinToggle);
    const draftGeometry = await labelGeometry(draftToggle);
    expect(draftGeometry.font).toBe(pinGeometry.font);
    expect(draftGeometry.weight).toBe(pinGeometry.weight);
    expect(draftGeometry.lineHeight).toBe(pinGeometry.lineHeight);
    expect(draftGeometry.labelInset).toBeCloseTo(pinGeometry.labelInset, 0);
    expect(draftGeometry.countInset).toBeCloseTo(pinGeometry.countInset, 0);
    expect(draftGeometry.icons).toEqual(pinGeometry.icons);
    for (const height of [pinGeometry.height, draftGeometry.height])
      expect(height).toBeGreaterThanOrEqual(44);
    for (const filter of await page.locator('.conversation-filters button').all())
      expect((await filter.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await newChat.locator('svg').getAttribute('width')).toBe('20');
    await expect(newChat).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(newChat).toHaveCSS('border-top-width', '0px');
    if (isMobile) {
      await page.getByRole('link', { name: 'Search chats', exact: true }).click();
      await expect(page.getByRole('searchbox', { name: 'Search conversations' })).toBeFocused();
      await page.getByRole('searchbox', { name: 'Search conversations' }).blur();
    }
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
    const rows = page.locator('.session-list .session-item-summary');
    const initialOrder = await rows.allTextContents();
    const emit = async (state: string, extra: Record<string, unknown> = {}) => {
      await page.evaluate(
        (activities) => {
          window.dispatchEvent(new CustomEvent('offline-session-activity', { detail: activities }));
        },
        [
          activity(11, state, {
            waitReason: 'permission',
            lastEventAt: Date.now(),
            stateChangedAt: state === 'waiting' ? Date.now() : undefined,
            completedAt: state === 'done' ? Date.now() : undefined,
            ...extra,
          }),
        ],
      );
    };
    const lastRowBefore = await page.locator('.session-list .session-item').last().boundingBox();
    await emit('working', {
      phase: 'reading',
      turnStartedAt: Date.now() - 60_000,
      lastMessageAt: sessions[11].lastModified,
    });
    await expect(page.locator('.session-list .session-item').last()).toContainText('Reading files');
    await expect(page.locator('.session-list .session-item').last()).toContainText('elapsed 1m');
    expect(
      Math.abs(
        (await page.locator('.session-list .session-item').last().boundingBox())!.height -
          lastRowBefore!.height,
      ),
    ).toBeLessThanOrEqual(1);
    const bars = page.locator('.session-list .session-activity-bars');
    await expect(bars).toBeVisible();
    await expect(rows).toHaveText(initialOrder);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('.session-list').evaluate((element) => {
      new MutationObserver(() => {
        if (
          [...element.children].some((row) =>
            row.getAnimations().some((a) => a.id === 'mitzo:reorder'),
          )
        )
          element.setAttribute('data-observed-move', 'true');
      }).observe(element, { childList: true });
      element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 77 }));
    });
    await emit('waiting');
    await expect(page.locator('.session-list .session-item').last()).toContainText(
      'Permission needed',
    );
    // Wait beyond the batch window: a held pointer must keep its target still.
    await page.waitForTimeout(800);
    await expect(rows).toHaveText(initialOrder);
    await expect(page.getByRole('button', { name: /1 updated · show latest/ })).toBeVisible();
    await page.evaluate(() =>
      document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 77 })),
    );
    // Mouse hover holds browsing too. Explicitly request the held promotion.
    await page.getByRole('button', { name: /1 updated · show latest/ }).click();
    await expect(rows.first()).toHaveText('Conversation 11');
    await page.mouse.move(0, 0);
    await page.locator('.session-list-scroll').evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(page.locator('.session-list')).toHaveAttribute('data-observed-move', 'true');
    await page.screenshot({ path: testInfo.outputPath(`session-library-reordered-${theme}.png`) });
    await emit('done');
    await expect(page.locator('.session-list .session-item').first()).toContainText('Finished');
    await emit('idle');
    await expect(page.locator('.session-list .session-item').first()).toContainText('Idle');
    await expect(rows).toHaveText(['Conversation 11', ...initialOrder.slice(0, -1)]);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // A new user message promotes an already working chat without animation.
    await page.evaluate(
      (detail) => window.dispatchEvent(new CustomEvent('offline-session-activity', { detail })),
      [activity(10, 'working', { lastUserMessageAt: Date.now() + 1000 })],
    );
    // The preceding finished-group move drains first; the reply promotion gets
    // its own five-second cooldown. Reduced Motion removes animation, not pacing.
    await expect(rows.first()).toHaveText('Conversation 10', { timeout: 12000 });
    expect(
      await page
        .locator('.session-list')
        .evaluate(
          (el) =>
            [...el.children]
              .flatMap((row) => row.getAnimations())
              .filter((a) => a.id === 'mitzo:reorder').length,
        ),
    ).toBe(0);
    // A visible assistant update during the same turn also advances freshness.
    await page.evaluate(
      (detail) => window.dispatchEvent(new CustomEvent('offline-session-activity', { detail })),
      [activity(9, 'working', { phase: 'reply', lastMessageAt: Date.now() + 2000 })],
    );
    await expect(rows.first()).toHaveText('Conversation 9');
    await expect(page.locator('.session-list .session-item').first()).toContainText(
      'Writing a reply',
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const scroller = page.locator('.session-list-scroll');
    const searchBox = page.getByRole('searchbox', { name: 'Search conversations' });
    await searchBox.focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'All', exact: true })).toBeFocused();
    await scroller.evaluate((element) => {
      element.scrollTop = 400;
    });
    await expect(searchBox).not.toBeInViewport();
    await expect(page.getByRole('button', { name: 'All', exact: true })).not.toBeInViewport();
    await expect(page.getByRole('heading', { name: 'Chats', exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`session-library-scrolled-${theme}.png`) });
    await scroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(searchBox).toBeInViewport();
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
      const lastRow = page.locator('.session-list .session-item-navigation').last();
      await expect(lastRow).toBeInViewport();
      const last = await lastRow.boundingBox(),
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
      if (kind === 'search') {
        await page.evaluate(() => {
          window.dispatchEvent(
            new CustomEvent('offline-session-activity', {
              detail: [
                {
                  sessionId: 'search-only',
                  title: 'Search-only conversation',
                  state: 'working',
                  model: 'gpt-6-luna',
                  accountLabel: 'Raw archive',
                  lastEventAt: Date.now(),
                  flags: [],
                },
              ],
            }),
          );
        });
        await page.getByRole('searchbox', { name: 'Search conversations' }).fill('Matching');
      }
      const row =
        kind === 'pin'
          ? page
              .getByRole('region', { name: 'Pinned conversations' })
              .getByRole('button', { name: /^Conversation 1 / })
          : page.getByRole(isMobile ? 'link' : 'button', {
              name: `${isMobile ? 'Open' : 'Preview'} ${kind === 'search' ? 'Search-only conversation' : 'Conversation 2'}`,
            });
      if (kind === 'search') {
        await expect(row.getByText('gpt-6-luna', { exact: true })).toBeVisible();
        await expect(row.getByText('Home archive', { exact: true })).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath(`session-search-identity-${theme}.png`),
        });
      }
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
        if (kind === 'search') {
          await expect(row.getByText('Home archive', { exact: true })).toBeVisible();
          await expect(row.getByText('Raw archive', { exact: true })).toHaveCount(0);
        }
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
    await page.goto('/activity-composer');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const composer = page.getByRole('region', { name: 'Conversation status' });
    const input = page.getByRole('textbox', { name: 'Message Mitzo' });
    await input.fill('Keep my next draft');
    const emitComposer = async (phase: string) =>
      page.evaluate(
        (detail) => window.dispatchEvent(new CustomEvent('offline-session-activity', { detail })),
        [
          activity(0, 'working', {
            phase,
            turnStartedAt: Date.now() - 60_000,
            lastMessageAt: Date.now() - 30_000,
          }),
        ],
      );
    await emitComposer('reading');
    await expect(composer.getByRole('status')).toHaveText('Reading files');
    await expect(composer).toContainText('elapsed 1m');
    await expect(composer.locator('.session-activity-bars i').first()).toHaveCSS(
      'animation-name',
      'session-activity-pulse',
    );
    await emitComposer('reply');
    await expect(composer.getByRole('status')).toHaveText('Writing a reply');
    await expect(input).toHaveValue('Keep my next draft');
    expect(
      await composer.evaluate(
        (el) =>
          el.getBoundingClientRect().height ===
          parseFloat(getComputedStyle(el).getPropertyValue('--control-height')),
      ),
    ).toBe(true);
    await expect(page.getByRole('button', { name: 'Stop generation' })).toBeVisible();
    await composer.getByRole('button', { name: 'Conversation status details' }).click();
    const status = page.getByRole('dialog', { name: 'Conversation status' });
    await expect(status.getByText('Last activity', { exact: true })).toBeVisible();
    await expect(status.getByText('Last message', { exact: true })).toBeVisible();
    await status.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(input).toHaveValue('Keep my next draft');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`session-library-composer-activity-${theme}.png`),
    });
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
      '/api/telos/work/collection': { profiles: [], records: [linkedWork], failures: [] },
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
