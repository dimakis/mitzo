import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const bundled = build({
  entryPoints: [resolve('tests/fixtures/compaction-dialog.tsx')],
  external: ['/*.png', '/*.svg'],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-compaction.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});
for (const theme of ['dark', 'light'])
  test(`compaction dialog: lifecycle, usage, wrapping and focus (${theme})`, async ({
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
    const trigger = page.getByRole('button', { name: /Compacting context/ });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Context compaction' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Waiting for the runtime to report completion/)).toBeVisible();
    await expect(dialog.locator('dd').filter({ hasText: '189,054' })).toBeVisible();
    await expect(dialog.getByText('258,400')).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(isMobile ? 320 : 1280);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`compaction-${theme}-waiting.png`) });
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-complete')));
    await expect(dialog.getByText('6m 33s')).toBeVisible();
    await expect(dialog.locator('dd').filter({ hasText: '28,549' })).toBeVisible();
    await expect(dialog.getByText(/not exact compaction sizes/)).toBeVisible();
    await page.screenshot({ path: info.outputPath(`compaction-${theme}-completed.png`) });
    const close = dialog.getByRole('button', { name: 'Close', exact: true });
    const closeBounds = await close.boundingBox();
    if (isMobile) {
      expect(closeBounds!.width).toBeGreaterThanOrEqual(44);
      expect(closeBounds!.height).toBeGreaterThanOrEqual(44);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: /Context compacted/ })).toBeFocused();
    await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveValue('Keep my draft');
    await page.getByRole('button', { name: /Context compacted/ }).click();
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-interrupt')));
    await expect(dialog.getByText(/context reduction are unconfirmed/)).toBeVisible();
    await expect(dialog.locator('dd').filter({ hasText: '28,549' })).toHaveCount(0);
    await close.click();
    expect(errors).toEqual([]);
  });
