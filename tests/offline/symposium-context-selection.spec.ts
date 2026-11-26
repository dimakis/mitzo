import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/symposium-context-selection.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-context-selection.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: { '@mitzo/protocol': resolve('packages/protocol/src/index.ts') },
});

test.use({ baseURL: 'https://mitzo-ui.test' });
for (const theme of ['dark', 'light'] as const) {
  test(`starting-context selection retains exact sources and accessible disclosure (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const files = (await bundle).outputFiles!;
    const errors: string[] = [];
    const unexpectedRequests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === 'https://mitzo-ui.test' && route.request().method() === 'GET') {
        if (url.pathname === '/fixture.js' || url.pathname === '/fixture.css') {
          const extension = url.pathname.endsWith('.js') ? '.js' : '.css';
          return route.fulfill({
            body: files.find((file) => file.path.endsWith(extension))!.text,
            contentType: extension === '.js' ? 'text/javascript' : 'text/css',
          });
        }
        if (url.pathname === '/')
          return route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
          });
      }
      unexpectedRequests.push(`${route.request().method()} ${url.pathname}`);
      return route.abort();
    });
    await page.goto('/');
    const open = page.getByRole('button', { name: 'Choose starting context' });
    await open.click();
    const dialog = page.getByRole('dialog', { name: 'Starting context' });
    await expect(dialog).toBeVisible();
    await expect(
      page.getByText(/Progress classification below is synthetic metadata/),
    ).toBeVisible();
    const operator = page.getByRole('checkbox', {
      name: /You Message.*Review the source selector/,
    });
    await operator.focus();
    await operator.press('Space');
    await expect(operator).toBeChecked();
    const search = page.getByRole('searchbox', { name: 'Search messages' });
    await search.fill('Source findings');
    await expect(page.getByRole('status')).toContainText('1 selected messages hidden by filters');
    await page.getByRole('combobox', { name: 'Author' }).selectOption('reviewer');
    const answer = page.getByRole('checkbox', { name: /Astra reviewer Reply/ });
    await answer.check();
    await page.getByRole('checkbox', { name: 'Review selected only' }).check();
    await search.fill('');
    await page.getByRole('combobox', { name: 'Author' }).selectOption('');
    await expect(operator).toBeChecked();
    await expect(answer).toBeChecked();
    await expect(page.getByRole('status')).toContainText('2 messages');
    await expect(page.getByText('Progress (1) · 0 selected', { exact: true })).toBeHidden();

    const answerRow = page.locator('.context-source-row').filter({ has: answer });
    const preview = answerRow.locator('summary');
    await preview.focus();
    await preview.press('Enter');
    await expect(page.getByRole('heading', { name: 'Source findings' })).toBeVisible();
    await expect(
      answerRow.locator('strong').filter({ hasText: 'Recorded evidence' }),
    ).toBeVisible();
    await expect(
      page.getByText('Image reference: Remote image reference (not loaded)'),
    ).toBeVisible();
    await expect(dialog.locator('img')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Local report' })).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath(`context-preview-${theme}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    await preview.press('Escape');
    await expect(preview).toBeFocused();
    await expect(preview).toHaveAttribute('aria-expanded', 'false');
    await expect(dialog).toBeVisible();

    await page.getByRole('checkbox', { name: 'Review selected only' }).uncheck();
    const progress = page.getByText('Progress (1) · 0 selected', { exact: true });
    await progress.focus();
    await progress.press('Enter');
    const progressChoice = page.getByRole('checkbox', { name: /Astra reviewer Progress/ });
    await progressChoice.check();
    await progressChoice.focus();
    await progressChoice.press('Escape');
    await expect(page.getByText('Progress (1) · 1 selected', { exact: true })).toBeFocused();
    await expect(progressChoice).toBeHidden();

    const artifact = page.getByRole('checkbox', {
      name: /Source selection review.*Saved version 2/,
    });
    await artifact.check();
    await expect(
      page.getByRole('checkbox', { name: /Source selection review.*Saved version 3/ }),
    ).toBeDisabled();
    await expect(page.getByRole('status')).toContainText('3 messages · 1 artifacts selected');
    await expect(page.getByTestId('selection')).toHaveText(
      JSON.stringify({
        messageIds: ['operator-message', 'reviewer-message', 'synthetic-progress'],
        artifacts: [{ artifactId: 'retained-review', revision: 2, sha256: 'a'.repeat(64) }],
      }),
    );
    const labelHeight = await artifact.evaluate(
      (element) => element.closest('label')!.getBoundingClientRect().height,
    );
    expect(labelHeight).toBeGreaterThanOrEqual(44);
    expect((await search.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await preview.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    expect(
      await page
        .locator('.context-source-selector')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    expect(
      await page.locator('html').evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    const font = await dialog.evaluate((element) => getComputedStyle(element).fontFamily);
    if (theme === 'light') expect(font.toLowerCase()).toContain('georgia');
    await page.getByRole('checkbox', { name: 'Review selected only' }).check();
    await page.getByRole('status').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`context-selected-${theme}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(open).toBeFocused();
    await open.click();
    await expect(operator).toBeChecked();
    await expect(artifact).toBeChecked();
    expect(errors).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
  });
}
