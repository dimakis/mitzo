import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const bundled = build({
  entryPoints: [resolve('tests/fixtures/background-tasks.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/background-tasks.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: { '@mitzo/protocol': resolve('packages/protocol/src/index.ts') },
});

for (const theme of ['dark', 'light']) {
  test(`Background tasks: lifecycle, unavailable Stop and original-request recovery (${theme})`, async ({
    page,
    isMobile,
  }, testInfo) => {
    const files = (await bundled).outputFiles!;
    const unexpected: string[] = [];
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      const file = files.find((file) => file.path.endsWith(url.pathname));
      if (url.origin === 'http://mitzo-ui.test' && file)
        return route.fulfill({
          contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
          body: file.text,
        });
      if (url.href === 'http://mitzo-ui.test/')
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html data-theme="${theme}" data-accent="teal" data-font="georgia"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/background-tasks.css"><div id="root"></div><script src="/background-tasks.js"></script></html>`,
        });
      unexpected.push(url.href);
      return route.abort();
    });
    await page.goto('/');
    const header = page.getByRole('button', { name: /Background task/ });
    await header.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeDisabled();
    await expect(page.getByText(/Task-only Stop is not available/)).toBeVisible();
    await expect(page.getByText(/Showing the latest/)).toBeVisible();
    await expect(page.getByLabel('Task output')).toBeVisible();
    await expect(page.locator('.background-task-output script')).toHaveCount(0);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '20px';
    });
    for (const [value, label] of [
      ['completed', 'Completed'],
      ['failed', 'Failed'],
      ['cancelled', 'Cancelled'],
      ['unavailable', 'Status unavailable'],
      ['restart', 'Stopped after restart'],
    ]) {
      await page.getByLabel('Task evidence').selectOption(value);
      await expect(header).toContainText(label);
      await expect(page.getByLabel('Task output')).toBeVisible();
    }
    await page.getByLabel('Task evidence').selectOption('running');
    await page.getByLabel('Use fixture Stop adapter').check();
    const stop = page.getByRole('button', { name: 'Stop task', exact: true });
    expect((await stop.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await stop.click();
    await expect(page.getByText('Stop outcome unconfirmed')).toBeVisible();
    await page.getByRole('button', { name: 'Toggle task view' }).click();
    await page.getByRole('button', { name: 'Toggle task view' }).click();
    await header.click();
    await expect(page.getByText('Stop outcome unconfirmed')).toBeVisible();
    await page.getByRole('button', { name: 'Check Stop request', exact: true }).click();
    await expect(page.getByText('Stop requested; waiting for task outcome')).toBeVisible();
    await expect(header).toContainText('Running');
    await page.getByRole('button', { name: 'Inspect dispatch count' }).click();
    await expect(page.getByLabel('Dispatch count')).toHaveText('1');
    await expect(page.getByLabel('Composer draft')).toHaveValue('Keep this draft');
    const bounds = await page.locator('.tool-pill--background-task').boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual((isMobile ? 320 : 1280) + 1);
    await page.getByLabel('Task output').focus();
    await page.keyboard.press('End');
    await page.screenshot({
      path: testInfo.outputPath(`background-tasks-${theme}.png`),
      fullPage: true,
    });
    expect(unexpected).toEqual([]);
  });
}
