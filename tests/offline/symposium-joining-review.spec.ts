import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/symposium-joining-review.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-joining-review.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: { '@mitzo/protocol': resolve('packages/protocol/src/index.ts') },
});
for (const theme of ['dark', 'light']) {
  test(`Symposium joining review: approved frozen context and brief (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const files = (await bundle).outputFiles!;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'mitzo-ui.test' || route.request().method() !== 'GET')
        return route.abort();
      const file = files.find((f) =>
        url.pathname.endsWith(f.path.endsWith('.css') ? '.css' : '.js'),
      );
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (url.pathname !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'georgia' : 'system'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const width of isMobile ? [320, 390] : [1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/');
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { joiningFixture: { reviews: number } }).joiningFixture.reviews,
        ),
      ).toBe(0);
      await page.getByRole('button', { name: 'Review joining brief' }).click();
      const dialog = page.getByRole('dialog', { name: 'Before joining' });
      await expect(dialog.getByText('Context for the fresh agent')).toBeVisible();
      await expect(dialog.getByText('1 message · 1 artifact version')).toBeVisible();
      await dialog.getByText('Review included context').click();
      await expect(dialog.getByText('Saved version 2 · chat-experience-plan.md')).toBeVisible();
      const brief = dialog.getByRole('textbox', {
        name: /Joining brief · sent to every participant/,
      });
      await expect(brief).toHaveValue(/Shared messages and artifacts are source material/);
      const join = dialog.getByRole('button', { name: 'Join conversation', exact: true });
      await expect(join).toBeEnabled();
      expect(
        await dialog
          .locator('.conversation-agents-body')
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await expect(join).toBeInViewport();
      await page.screenshot({
        path: info.outputPath(`before-joining-${width}-${theme}.png`),
        style: '[data-fixture-controls] { visibility: hidden; }',
      });
      await brief.fill('Review recovery without changing the saved source versions.');
      await expect(join).toBeEnabled();
      await join.click();
      await expect(dialog.getByText(/Reviewer joining\./)).toBeVisible();
      await expect(brief).toBeDisabled();
      await dialog.getByRole('button', { name: 'Check again' }).click();
      await expect(dialog.getByText(/Reviewer joined\./)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('button', { name: 'Review joining brief' })).toBeFocused();
    }
    await page.goto('/?state=uncertain');
    await page.getByRole('button', { name: 'Review joining brief' }).click();
    const dialog = page.getByRole('dialog', { name: 'Before joining' });
    await dialog.getByRole('button', { name: 'Join conversation' }).click();
    await expect(dialog.getByRole('alert')).toContainText('same request');
    await dialog.getByRole('button', { name: 'Check again' }).click();
    const confirmations = await page.evaluate(
      () =>
        (window as unknown as { joiningFixture: { confirmations: unknown[] } }).joiningFixture
          .confirmations,
    );
    expect(confirmations).toHaveLength(2);
    expect(confirmations[0]).toEqual(confirmations[1]);
    await page.goto('/?state=capacity');
    await page.getByRole('button', { name: 'Review joining brief' }).click();
    await expect(page.getByRole('button', { name: 'Join conversation' })).toBeDisabled();
    await expect(page.getByRole('status')).toContainText('Choose less context');
    await page.goto('/?state=refreeze-error');
    await page.getByRole('button', { name: 'Review joining brief' }).click();
    await page
      .getByRole('textbox', { name: /Joining brief · sent to every participant/ })
      .fill('Keep this edited brief.');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: /Joining brief · sent to every participant/ }),
    ).toHaveValue('Keep this edited brief.');
    await expect(page.getByRole('button', { name: 'Join conversation' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
