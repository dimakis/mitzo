import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const output = build({
  entryPoints: [resolve('tests/fixtures/chat-claude-retractions.tsx')],
  bundle: true,
  external: ['/*.png', '/*.svg'],
  format: 'esm',
  write: false,
  outfile: '/tmp/mitzo-chat-retractions.js',
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
  test(`retracted output stays absent and tool activity survives (${theme})`, async ({
    page,
  }, info) => {
    const files = (await output).outputFiles!;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
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
    await page.goto('/');
    await expect(page.getByText('Superseded draft answer.', { exact: true })).toBeVisible();
    const draft = page.getByRole('textbox', { name: 'Unsent draft' });
    await draft.fill('The operator draft survives replacement.');
    await draft.focus();
    await page.evaluate(() =>
      (window as unknown as { retractionFixture: { replace(): void } }).retractionFixture.replace(),
    );
    await expect(page.getByText('Superseded draft answer.', { exact: true })).toHaveCount(0);
    await expect(
      page.getByText('The corrected answer is retained.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Keep this original request.', { exact: true })).toBeVisible();
    await expect(draft).toHaveValue('The operator draft survives replacement.');
    await expect(draft).toBeFocused();
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { retractionFixture: { running(): boolean } }
        ).retractionFixture.running(),
      ),
    ).toBe(true);
    await page.evaluate(() =>
      (
        window as unknown as { retractionFixture: { staleRestore(): void } }
      ).retractionFixture.staleRestore(),
    );
    await expect(page.getByText('Superseded draft answer.', { exact: true })).toHaveCount(0);
    await expect(
      page.getByText('The corrected answer is retained.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Superseded tool result.', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Read', { exact: true }).first()).toBeVisible();
    expect(errors).toEqual([]);
    await page.screenshot({
      path: info.outputPath(`chat-queue-retractions-${theme}.png`),
      fullPage: true,
    });
  });
