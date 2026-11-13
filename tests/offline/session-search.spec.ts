import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/session-search.tsx')],
  bundle: true,
  external: ['/*.png', '/*.svg'],
  write: false,
  outfile: '/tmp/session-search-fixture.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});
const results = Array.from({ length: 20 }, (_, i) => ({
  sessionId: 'match-' + i,
  summary: i ? 'Personal Claude notes ' + i : 'Billing review',
  model: 'claude-opus-4-8',
  accountLabel: 'Personal',
  snippet: 'Compare personal subscriptions and the Claude billing plans.',
  matchedAt: 1794050000000 - i,
  updatedAt: 1794050000000 - i,
  matchedFields: ['model', 'account'],
}));

for (const theme of ['dark', 'light'])
  test(
    'chat search evidence, recovery and return (' + theme + ')',
    async ({ page, isMobile }, testInfo) => {
      const errors: string[] = [];
      const mutations: string[] = [];
      let failed = false;
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(
        ({ theme }) => {
          localStorage.setItem('mitzo-theme', theme);
          localStorage.setItem('mitzo-accent', theme === 'dark' ? 'mint' : 'teal');
          localStorage.setItem('mitzo-font', theme === 'dark' ? 'system' : 'georgia');
          localStorage.setItem(
            'mitzo-conversation-pins',
            JSON.stringify([{ id: 'pinned', summary: 'Pinned conversation', lastModified: 1 }]),
          );
          class OfflineEventSource extends EventTarget {
            close() {}
          }
          window.EventSource = OfflineEventSource as unknown as typeof EventSource;
          document.addEventListener('DOMContentLoaded', () => {
            document.body.style.cssText = 'height:100dvh;overflow:hidden';
          });
        },
        { theme },
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
        if (path === '/api/sessions/search') {
          const query = url.searchParams.get('q') ?? '';
          if (query === 'offline' && !failed) {
            failed = true;
            return route.fulfill({ status: 503, json: { error: 'Search failed' } });
          }
          return route.fulfill({ json: { results: query === 'missing topic' ? [] : results } });
        }
        const data: Record<string, unknown> = {
          '/api/sessions': {
            sessions: [{ id: 'pinned', summary: 'Pinned conversation', lastModified: 1 }],
            hasMore: false,
          },
          '/api/config': { quickActions: [] },
          '/api/version': { updateAvailable: false },
          '/api/home/preferences': { revision: 1, pins: [], names: {}, showDailyQuote: false },
          '/api/telos/work/collection': { profiles: [], records: [], failures: [] },
          '/api/service-health': { services: [] },
        };
        if (path in data) return route.fulfill({ json: data[path] });
        if (path.startsWith('/api/')) return route.fulfill({ json: [] });
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
          body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
        });
      });
      await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/sessions');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('html')).toHaveAttribute(
        'data-accent',
        theme === 'dark' ? 'mint' : 'teal',
      );
      await expect(page.locator('html')).toHaveAttribute(
        'data-font',
        theme === 'dark' ? 'system' : 'georgia',
      );
      const drafts = page.locator('.conversation-drafts-section');
      await expect(drafts.locator('summary')).toBeVisible();
      await drafts.locator('summary').click();
      await expect(page.getByRole('link', { name: /All Drafts/ })).toBeVisible();
      await expect(
        page.getByRole('link', { name: 'Unsent thought Saved', exact: false }),
      ).toBeVisible();
      await expect(page.getByText('Pinned', { exact: true })).toBeVisible();
      const input = page.getByRole('searchbox', { name: 'Search conversations' });
      await input.fill('Claude personal');
      await expect(page.getByText('Searching…', { exact: true })).toBeVisible();
      await expect(page.locator('.conversation-results .session-item')).toHaveCount(20);
      await expect(drafts).toHaveCount(0);
      await expect(page.getByText('Pinned', { exact: true })).toHaveCount(0);
      const first = page.getByRole(isMobile ? 'link' : 'button', {
        name: (isMobile ? 'Open' : 'Preview') + ' Billing review',
      });
      await expect(first.getByText('Matches model · account')).toBeVisible();
      for (const control of [input, page.getByRole('button', { name: 'Clear search' }), first]) {
        const box = await control.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      expect(await first.locator('mark').allTextContents()).toEqual([
        'personal',
        'Claude',
        'claude',
        'Personal',
      ]);
      await expect(
        page.getByText('20 best matches · refine your search to narrow results'),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath('session-library-search-results-' + theme + '.png'),
      });
      const scroller = page.locator('.session-list-scroll');
      await scroller.evaluate((el) => {
        el.scrollTop = 350;
      });
      await expect(input).toBeInViewport();
      const row = page.getByRole(isMobile ? 'link' : 'button', {
        name: (isMobile ? 'Open' : 'Preview') + ' Personal Claude notes 5',
      });
      await row.focus();
      await row.press('Enter');
      await page.getByRole('link', { name: 'Back to chats' }).click();
      await expect(input).toHaveValue('Claude personal');
      await expect(page.locator('.conversation-results .session-item')).toHaveCount(20);
      expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
      await row.focus();
      await row.press('Enter');
      await page.getByRole('button', { name: 'Back to search' }).click();
      await expect(input).toHaveValue('Claude personal');
      await expect(page.locator('.conversation-results .session-item')).toHaveCount(20);
      if (isMobile) {
        await page.getByRole('link', { name: 'Search chats', exact: true }).click();
        await expect(input).toHaveValue('');
        await input.fill('Claude personal');
        await expect(page.locator('.conversation-results .session-item')).toHaveCount(20);
      }
      await input.fill('missing topic');
      await expect(page.getByText('No matching conversations')).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath('session-library-search-empty-' + theme + '.png'),
      });
      await page.getByRole('button', { name: 'Search for “missing”' }).click();
      await expect(input).toHaveValue('missing');
      await expect(page.locator('.conversation-results .session-item')).toHaveCount(20);
      await input.fill('offline');
      await expect(page.getByRole('alert')).toContainText('Couldn’t search sessions');
      await expect(page.getByText('No matching conversations')).toHaveCount(0);
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect(page.locator('.conversation-results .session-item')).toHaveCount(20);
      await input.focus();
      await page.getByRole('button', { name: 'Clear search' }).click();
      await expect(input).toHaveValue('');
      await expect(drafts.locator('summary')).toBeVisible();
      await drafts.locator('summary').click();
      await expect(page.getByRole('link', { name: /All Drafts/ })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(errors).toEqual([]);
      expect(mutations).toEqual([]);
    },
  );
