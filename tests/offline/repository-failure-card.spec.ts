import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const output = build({
  entryPoints: [resolve('tests/fixtures/repository-failure-card.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-repository-failure-card.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.svg', '/*.png'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});
for (const theme of ['dark', 'light'] as const)
  test(`failed repository tools retain their recovery card (${theme})`, async ({ page }, info) => {
    const compiled = (await output).outputFiles!;
    const requests: string[] = [];
    const unexpected: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 844,
    });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://mitzo-ui.test') return route.abort();
      if (url.pathname.endsWith('/chat-preparation') && route.request().method() === 'GET') {
        requests.push(url.pathname);
        return route.fulfill({
          json: {
            repositoryChat: {
              id: '8ca30b0d-3e65-4eeb-8244-f6277350818f',
              sourceConversationId: 'parent-chat',
              repository: 'example/repo',
              baseBranch: 'main',
              baseOid: 'a'.repeat(40),
              featureBranch: 'mitzo/task',
              state: 'failed',
              accountId: 'work',
              model: 'offline-fixture',
              prompt: 'Inspect the original failed repository preparation.',
              setupUrl: '/chat?repositoryPreparation=8ca30b0d-3e65-4eeb-8244-f6277350818f',
              failure: { code: 'repository_space', message: 'Free at least 3 GiB, then retry.' },
            },
          },
        });
      }
      if (url.pathname.startsWith('/api/')) {
        unexpected.push(url.pathname);
        return route.abort();
      }
      if (url.pathname === '/fixture.js' || url.pathname === '/fixture.css') {
        const extension = url.pathname.endsWith('.js') ? '.js' : '.css';
        return route.fulfill({
          contentType: extension === '.js' ? 'application/javascript' : 'text/css',
          body: compiled.find((file) => file.path.endsWith(extension))!.text,
        });
      }
      if (url.pathname !== '/chat/parent-chat') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
      });
    });
    await page.goto('/chat/parent-chat');
    await expect(page.getByRole('button', { name: /2 tool calls.*2 failed/ })).toBeVisible();
    const link = page.getByRole('link', { name: 'Open repository chat', exact: true });
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute(
      'href',
      '/chat?repositoryPreparation=8ca30b0d-3e65-4eeb-8244-f6277350818f',
    );
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '125%';
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`repository-failed-card-${theme}.png`) });
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Repository task draft' })).toContainText(
      'example/repo',
    );
    await expect(page.getByRole('alert')).toContainText('Repository preparation is failed');
    expect(requests).toEqual([
      '/api/repository-workspaces/8ca30b0d-3e65-4eeb-8244-f6277350818f/chat-preparation',
    ]);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
