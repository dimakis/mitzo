import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const output = build({
  entryPoints: [resolve('tests/fixtures/chat-queue-steering.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  external: ['/*.png', '/*.svg'],
  format: 'esm',
  write: false,
  outfile: '/tmp/mitzo-prepared-steering.js',
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
  test(`steers an internal repository continuation without a user row (${theme})`, async ({
    page,
  }, info) => {
    const files = (await output).outputFiles!;
    const corrections: Record<string, unknown>[] = [];
    const stops: string[] = [];
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/codex-queue/steer')) {
        const input = route.request().postDataJSON();
        corrections.push(input);
        return route.fulfill({ json: { requestId: input.requestId, status: 'accepted' } });
      }
      if (path === '/fixture/stop') {
        stops.push(path);
        return route.fulfill({ json: { ok: true } });
      }
      if (path.startsWith('/api/')) return route.fulfill({ json: [] });
      const file = files.find((file) => path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'));
      if (file)
        return route.fulfill({
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          body: file.text,
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 844,
    });
    await page.goto('/?prepared=1');
    const input = page.getByRole('textbox', { name: 'Message Mitzo' });
    await input.fill('Pause at a safe point for the server update.');
    await expect(page.getByRole('button', { name: 'Steer current turn' })).toBeEnabled();
    await page.screenshot({
      path: info.outputPath(`chat-queue-prepared-continuation-${theme}.png`),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Steer current turn' }).click();
    await expect.poll(() => corrections.length).toBe(1);
    expect(corrections[0]).toMatchObject({
      targetCommandId: 'prepared-repository-fixture',
      text: 'Pause at a safe point for the server update.',
    });
    await expect(input).toHaveValue('');
    expect(stops).toEqual([]);
  });
