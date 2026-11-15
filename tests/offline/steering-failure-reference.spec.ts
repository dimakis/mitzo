import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';

const output = build({
  entryPoints: [resolve('tests/fixtures/chat-queue-steering.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  external: ['/*.png', '/*.svg'],
  format: 'esm',
  write: false,
  outfile: '/tmp/mitzo-steering-failure-reference.js',
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
  test(`steering failure reference preserves the draft and hides upstream text (${theme})`, async ({
    page,
  }, info) => {
    const files = (await output).outputFiles!;
    const diagnosticId = '84b57f38-264c-4d56-aed1-cb5a9c381e92';
    const steering: Record<string, unknown>[] = [];
    const otherDispatches: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/codex-queue/steer')) {
        steering.push(route.request().postDataJSON());
        return route.fulfill({
          status: 409,
          json: {
            code: 'turn_steering_unconfirmed',
            diagnosticId,
            error: 'private upstream detail',
          },
        });
      }
      if (path === '/fixture/queue' || path === '/fixture/stop') {
        otherDispatches.push(path);
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
        body: `<!doctype html><html data-theme="${theme}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 844,
    });
    await page.goto('/');
    const input = page.getByRole('textbox', { name: 'Message Mitzo' });
    await input.fill('An unconfirmed correction');
    await page.getByRole('button', { name: 'Steer current turn' }).click();
    await expect(page.getByRole('alert')).toContainText('delivery not confirmed');
    await expect(page.getByRole('alert')).toContainText(diagnosticId);
    await expect(page.getByRole('alert')).not.toContainText('private upstream detail');
    await expect(input).toHaveValue('An unconfirmed correction');
    expect(steering).toHaveLength(1);
    expect(steering[0]).toMatchObject({
      targetCommandId: 'first',
      text: 'An unconfirmed correction',
    });
    expect(otherDispatches).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: info.outputPath(`chat-queue-steering-reference-${theme}.png`),
      fullPage: true,
    });
  });
