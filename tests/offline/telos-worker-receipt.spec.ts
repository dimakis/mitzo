import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/telos-worker-receipt.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-telos-worker-receipt.js',
  jsx: 'automatic',
  minify: true,
  external: ['/mitzo-wordmark.png', '/openshell-mark.svg', '/github-mark.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});
for (const theme of ['dark', 'light']) {
  test(`worker receipt retains the lead until explicit navigation (${theme})`, async ({
    page,
    isMobile,
  }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const files = (await bundle).outputFiles!;
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      const file = files.find(
        (file) => path === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>body{margin:0;background:var(--color-bg);color:var(--color-text);font-family:var(--font-ui)}.receipt-fixture{max-width:42rem;margin:auto;padding:var(--space-4)}h1{font-size:var(--text-lg)}textarea{display:block;width:100%;box-sizing:border-box;min-height:var(--control-height);font:inherit;background:var(--color-panel);color:var(--color-text);border:1px solid var(--color-border);padding:var(--space-3)}label,output{display:block;margin-top:var(--space-5)}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const link = page.getByRole('link', { name: /Plan recording setup/ });
    await expect(link).toBeVisible();
    await expect(page.getByLabel('Current conversation')).toHaveText('/chat/lead');
    await expect(page.getByText(/Running|Completed|Work has not started/)).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue(
      'Keep this draft in the lead conversation.',
    );
    expect(
      await link.evaluate((element) => {
        const row = getComputedStyle(element);
        const icon = getComputedStyle(element.querySelector('.telos-worker-receipt-icon')!);
        return {
          gap: row.gap,
          padding: row.paddingTop,
          width: icon.width,
          height: icon.height,
          radius: icon.borderRadius,
        };
      }),
    ).toEqual({ gap: '10px', padding: '13px', width: '30px', height: '36px', radius: '6px' });
    const bounds = await link.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`worker-receipt-${theme}.png`),
      fullPage: true,
    });
    if (isMobile) {
      await link.tap();
    } else {
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await expect(link).toBeFocused();
      await page.keyboard.press('Enter');
    }
    await expect(page.getByLabel('Current conversation')).toHaveText('/chat/worker');
    expect(errors).toEqual([]);
  });
}
