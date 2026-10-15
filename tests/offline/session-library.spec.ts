import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const sessions = Array.from({ length: 12 }, (_, index) => ({
  id: `session-${index}`,
  summary:
    index === 0
      ? 'A very long technical conversation identifier with enough context to wrap cleanly without clipping its title'
      : `Conversation ${index}`,
  lastModified: Date.now() - index * 3600000,
  cwd: '/workspace/mgmt',
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
  external: ['/mitzo-wordmark.png', '/openshell-mark.svg', '/github-mark.svg'],
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
          readyState = 2;
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
        '/api/config': { quickActions: [] },
        '/api/briefings/latest': null,
        '/api/version': { updateAvailable: false },
        '/api/home/preferences': {
          revision: 1,
          names: { briefing: 'Minion', terminal: 'Minion' },
          showDailyQuote: false,
          pins: [{ kind: 'session', id: 'session-0', title: sessions[0].summary }],
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
      await page.goto('/sessions');
    }
    await page.screenshot({ path: testInfo.outputPath(`session-library-${theme}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.goto('/');
    await expect(page.getByRole('meter', { name: 'Context used' }).first()).toHaveAttribute(
      'aria-valuenow',
      '24',
    );
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
