import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const bundled = build({
  entryPoints: [resolve('tests/fixtures/tool-results.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-tool-results.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});

for (const theme of ['dark', 'light'])
  test(`tool results: readable data, raw, paging and wrapping (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const files = (await bundled).outputFiles!;
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      const file = files.find((file) => path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'));
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (path !== '/' || route.request().method() !== 'GET') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    if (theme === 'light') await page.addStyleTag({ content: 'html { font-size: 125%; }' });
    await page.getByRole('button', { name: /GitHubRead/ }).click();
    await expect(page.getByText('Endpoint', { exact: true })).toBeVisible();
    const result = page.getByRole('region', { name: 'Result', exact: true }).first();
    const first = result.getByRole('button', { name: /Item 1 Improve tool result readability 1$/ });
    await first.focus();
    await page.keyboard.press('Enter');
    await result.getByRole('button', { name: /Commit/ }).click();
    await expect(result.getByText('Message', { exact: true })).toBeVisible();
    await expect(result.getByText('false', { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: info.outputPath(`tool-results-${theme}.png`) });
    for (const body of await page.locator('.tool-result-body').all()) {
      expect(await body.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (isMobile)
      for (const button of await result.getByRole('button').all()) {
        const bounds = await button.boundingBox();
        if (bounds) expect(bounds.height).toBeGreaterThanOrEqual(44);
      }
    await result.getByRole('button', { name: 'Raw', exact: true }).click();
    await expect(result.locator('pre')).toContainText('"sha":"9c65d8ef');
    expect(
      await result.locator('.tool-result-body').evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await result.getByRole('button', { name: 'Readable', exact: true }).click();
    await result.getByRole('button', { name: /Show more/ }).click();
    await result.getByRole('button', { name: /Show more/ }).click();
    await result
      .getByRole('button', { name: /Item 23 Improve tool result readability 23/ })
      .click();
    await page.getByRole('button', { name: /Empty result/ }).click();
    await expect(page.getByText('No items')).toBeVisible();
    await page.getByRole('button', { name: /Failed lookup/ }).click();
    await expect(page.getByText(/Could not load results/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Pending lookup.*Running/ })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveValue('Keep my draft');
    expect(errors).toEqual([]);
  });
