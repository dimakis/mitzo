import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const output = build({
  entryPoints: [resolve('tests/fixtures/composer-receipt.tsx')],
  bundle: true,
  external: ['/*.png', '/*.svg'],
  format: 'esm',
  write: false,
  outfile: '/tmp/mitzo-composer-receipt.js',
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
  for (const newer of [false, true]) {
    test(`cold composer receipt preserves revision ownership (${theme}, newer=${newer})`, async ({
      page,
    }, info) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let consumed = false;
      let sends = 0;
      const files = (await output).outputFiles!;
      await page.route('**/*', (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/commands/continue/receipt')) {
          const request = route.request().postDataJSON();
          return route.fulfill({
            status: 202,
            json: {
              ok: true,
              sessionId: 'cold-chat',
              clientMsgId: request.clientMsgId,
              dispatched: false,
              state: consumed ? 'consumed' : 'reserved',
            },
          });
        }
        if (path.endsWith('/commands/continue')) {
          sends++;
          return route.abort();
        }
        if (path.includes('/messages'))
          return route.fulfill({ json: { messages: [], current: null, cursor: 0 } });
        if (path.startsWith('/api/')) return route.fulfill({ json: {} });
        const asset = files.find((file) =>
          path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'),
        );
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
      await page.setViewportSize({
        width: info.project.name.startsWith('mobile') ? 320 : 1280,
        height: 844,
      });
      await page.goto('/');
      const input = page.getByRole('textbox', { name: 'Message Mitzo' });
      await input.fill('Submitted exactly once');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(page.getByTestId('receipt-state')).toHaveText('uncertain');
      if (newer) {
        await input.fill('Independent newer edit');
        await input.fill('Submitted exactly once');
      }
      consumed = true;
      // No composer exists while the verified receipt retires the outbox. Its
      // durable accepted marker must survive another complete document reload.
      await page.goto('/?hide=1');
      await expect(page.getByTestId('receipt-state')).toHaveText('consumed');
      await page.goto('/');
      await expect(input).toHaveValue(newer ? 'Submitted exactly once' : '');
      expect(sends).toBe(1);
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: info.outputPath(`composer-receipt-${theme}-${newer ? 'newer' : 'accepted'}.png`),
      });
    });
  }
}
