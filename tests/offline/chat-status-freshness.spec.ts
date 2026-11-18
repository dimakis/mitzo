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
  outfile: '/tmp/chat-status-fixture.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});

for (const theme of ['dark', 'light']) {
  test(`chat status follows completion and selection without another broadcast (${theme})`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    const mutations: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 844,
    });
    await page.addInitScript(() => {
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
    });
    const files = (await bundle).outputFiles!;
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'mitzo-ui.test') return route.abort();
      if (route.request().method() !== 'GET') {
        mutations.push(url.pathname);
        return route.abort();
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
      const asset = files.find((file) =>
        url.pathname.endsWith(file.path.endsWith('.css') ? '.css' : '.js'),
      );
      if (asset)
        return route.fulfill({
          contentType: asset.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          body: asset.text,
        });
      if (url.pathname !== '/activity-composer') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
      });
    });
    await page.goto('/activity-composer');
    const row = page.getByRole('region', { name: 'Conversation status' });
    const input = page.getByRole('textbox', { name: 'Message Mitzo' });
    await input.fill('Keep my next draft');
    const idle = {
      sessionId: 'session-1',
      clientId: 'second',
      title: 'Idle chat',
      flags: [],
      state: 'idle',
      lastEventAt: Date.now() - 90_000,
    };
    const working = {
      sessionId: 'session-0',
      clientId: 'first',
      title: 'Command',
      flags: [],
      state: 'working',
      phase: 'command',
      turnStartedAt: Date.now() - 60_000,
      lastEventAt: Date.now(),
    };
    await page.evaluate(
      (detail) => window.dispatchEvent(new CustomEvent('offline-session-activity', { detail })),
      [working, idle],
    );
    await expect(row.getByRole('status')).toHaveText('Running command');
    await expect(row).toContainText('elapsed 1m');
    await page.evaluate(
      (detail) => window.dispatchEvent(new CustomEvent('offline-session-activity', { detail })),
      [{ ...working, state: 'done', phase: undefined, completedAt: Date.now() }, idle],
    );
    await expect(row.getByRole('status')).toHaveText('Finished');
    await expect(row.locator('.session-activity-bars')).toHaveCount(0);
    await expect(row).not.toContainText('elapsed');
    await expect(input).toHaveValue('Keep my next draft');
    await expect(input).toBeFocused();
    await row.getByRole('button', { name: 'Conversation status details' }).click();
    const dialog = page.getByRole('dialog', { name: 'Conversation status' });
    await expect(dialog.getByText('Agent working', { exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('offline-activity-conversation', { detail: 'session-1' }),
      ),
    );
    await expect(row.getByRole('status')).toHaveText('Idle');
    await expect(row.locator('.session-activity-bars')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`chat-status-switched-${theme}.png`) });
    expect(errors).toEqual([]);
    expect(mutations).toEqual([]);
  });
}
