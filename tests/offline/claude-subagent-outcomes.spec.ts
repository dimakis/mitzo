import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/claude-subagent-outcomes.tsx')],
  bundle: true,
  write: false,
  format: 'esm',
  outfile: '/tmp/claude-child.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});

for (const theme of ['dark', 'light']) {
  test(`Claude child outcomes retain output and keyboard access (${theme})`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 900,
    });
    const files = (await bundle).outputFiles!;
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
        });
      const file = files.find((file) => path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'));
      return file
        ? route.fulfill({
            body: file.text,
            contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          })
        : route.abort();
    });
    await page.goto('/');
    for (const [status, label] of [
      ['running', 'Working...'],
      ['completed', 'Complete'],
      ['failed', 'Failed'],
      ['cancelled', 'Cancelled'],
      ['unavailable', 'Status unavailable'],
    ]) {
      const child = page.getByRole('region', { name: `${status} child`, exact: true });
      const button = child.getByRole('button', { expanded: false });
      await expect(button).toContainText(label);
      await button.focus();
      await page.keyboard.press('Enter');
      await expect(child.getByText('Retained public output', { exact: true })).toBeVisible();
      if (status === 'unavailable')
        await expect(child.getByText('cancellation-reference')).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(button).toBeFocused();
    }
    const empty = page.getByRole('region', { name: 'Failed before output', exact: true });
    await expect(empty.getByRole('button')).toContainText('Failed');
    await empty.getByRole('button').click();
    await expect(
      empty.getByText('Subagent failed. Review retained output before asking the parent to retry.'),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message draft' })).toHaveValue('Keep my draft');
    await expect(page.locator('body')).toHaveJSProperty(
      'scrollWidth',
      await page.locator('body').evaluate((e) => e.clientWidth),
    );
    await page.screenshot({
      path: info.outputPath(`claude-outcomes-${theme}.png`),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
}
