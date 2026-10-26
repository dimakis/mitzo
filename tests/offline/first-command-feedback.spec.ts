import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const output = build({
  entryPoints: [resolve('tests/fixtures/first-command-feedback.tsx')],
  bundle: true,
  external: ['/*.png', '/*.svg'],
  format: 'esm',
  write: false,
  outfile: '/tmp/mitzo-first-command-feedback.js',
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
  for (const runOn of ['local', 'openshell'])
    test(`first-command refusal keeps draft and explains recovery (${theme}, ${runOn})`, async ({
      page,
    }, info) => {
      const files = (await output).outputFiles!;
      let sends = 0;
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/chat/local-codex/send' || path === '/api/chat/runtime/send') {
          sends++;
          const command = route.request().postDataJSON();
          expect(command.runOn).toBe(runOn);
          expect(path).toBe(
            runOn === 'local' ? '/api/chat/local-codex/send' : '/api/chat/runtime/send',
          );
          return route.fulfill({
            status: 202,
            json: {
              ok: true,
              clientMsgId: command.clientMsgId,
              sessionId: 'offline-accepted',
              dispatched: true,
              state: 'consumed',
            },
          });
        }
        if (path.startsWith('/api/')) return route.fulfill({ json: { ok: true } });
        const asset = files.find((f) => path.endsWith(f.path.endsWith('.css') ? '.css' : '.js'));
        if (asset)
          return route.fulfill({
            contentType: asset.path.endsWith('.css') ? 'text/css' : 'text/javascript',
            body: asset.text,
          });
        if (path !== '/') return route.abort();
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
        });
      });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`/?runOn=${runOn}`);
      const input = page.getByRole('textbox', { name: 'Message Mitzo' });
      await expect(input).toHaveValue('Inspect the attached screenshot and preserve my request.');
      await page.getByRole('button', { name: 'Start session', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveCount(1);
      await expect(page.getByRole('alert')).toHaveText(
        'Device storage could not retain the outgoing message. Your draft was kept.',
      );
      await expect(input).toHaveValue('Inspect the attached screenshot and preserve my request.');
      await expect(page.getByRole('button', { name: 'Preview attachment 1' })).toBeVisible();
      expect(sends).toBe(0);
      await page.screenshot({ path: info.outputPath(`first-command-feedback-${theme}.png`) });
      await page.getByRole('button', { name: 'Restore fixture storage' }).click();
      await page.getByRole('button', { name: 'Start session', exact: true }).click();
      await expect(input).toHaveValue('');
      expect(sends).toBe(1);
      await expect(page.getByRole('alert')).toHaveCount(0);
      expect(errors).toEqual([]);
    });
