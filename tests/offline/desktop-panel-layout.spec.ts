import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const bundle = build({
  entryPoints: [resolve('tests/fixtures/desktop-panel-layout.tsx')],
  bundle: true,
  format: 'esm',
  write: false,
  outfile: '/tmp/desktop-panel-layout.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});
for (const theme of ['dark', 'light'])
  test(`desktop panels resize and messages use available width (${theme})`, async ({
    page,
  }, info) => {
    const files = (await bundle).outputFiles!;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/api/')) return route.fulfill({ json: [] });
      const file = files.find((f) => path.endsWith(f.path.endsWith('.css') ? '.css' : '.js'));
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
    const mobile = info.project.name.startsWith('mobile');
    await page.setViewportSize({ width: mobile ? 320 : 1600, height: 1000 });
    await page.goto('/');
    const draft = page.getByRole('textbox', { name: 'Message Mitzo' });
    await draft.fill('Preserve this unsent draft');
    if (!mobile) {
      for (const name of ['navigation', 'conversations', 'resources']) {
        const divider = page.getByRole('separator', { name: `Resize ${name}`, exact: true });
        const panel = page.locator(
          name === 'navigation'
            ? '.workspace-rail'
            : name === 'conversations'
              ? '.desktop-sidebar-left'
              : '.desktop-sidebar-right',
        );
        const initialPanelWidth = (await panel.boundingBox())!.width;
        const initial = Number(await divider.getAttribute('aria-valuenow'));
        const bounds = (await divider.boundingBox())!;
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.down();
        await page.mouse.move(
          bounds.x + bounds.width / 2 + (name === 'resources' ? -40 : 40),
          bounds.y + bounds.height / 2,
          { steps: 6 },
        );
        await page.mouse.up();
        expect(Number(await divider.getAttribute('aria-valuenow'))).toBe(initial + 40);
        expect(Math.abs((await panel.boundingBox())!.width - initialPanelWidth - 40)).toBeLessThan(
          1,
        );
        await expect(divider).toBeFocused();
        await divider.press(name === 'resources' ? 'ArrowLeft' : 'ArrowRight');
        expect(Number(await divider.getAttribute('aria-valuenow'))).toBe(initial + 50);
        expect(Math.abs((await panel.boundingBox())!.width - initialPanelWidth - 50)).toBeLessThan(
          1,
        );
      }
      await expect(draft).toHaveValue('Preserve this unsent draft');
      await page.screenshot({ path: info.outputPath(`responsiveness-panels-wide-${theme}.png`) });
      const saved = await page
        .getByRole('separator', { name: 'Resize conversations', exact: true })
        .getAttribute('aria-valuenow');
      await page.reload();
      await expect(
        page.getByRole('separator', { name: 'Resize conversations', exact: true }),
      ).toHaveAttribute('aria-valuenow', saved!);
      await draft.fill('Preserve this unsent draft');
      await page.getByRole('button', { name: 'Collapse navigation', exact: true }).click();
      await page.getByTitle('Hide sidebar', { exact: true }).click();
      await page.getByTitle('Hide context', { exact: true }).click();
      const dimensions = await page.locator('.chat-messages').evaluate((element) => {
        const css = getComputedStyle(element);
        return {
          content: element.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight),
          bubble: element.querySelector('.msg-bubble--assistant')!.getBoundingClientRect().width,
        };
      });
      expect(dimensions.content).toBeGreaterThan(1200);
      expect(dimensions.bubble).toBeGreaterThanOrEqual(dimensions.content - 1);
      await page.screenshot({
        path: info.outputPath(`responsiveness-panels-full-chat-${theme}.png`),
      });
      await page.getByRole('button', { name: 'Toggle preview' }).click();
      const preview = page.getByRole('separator', { name: 'Resize conversation preview' });
      const previewWidth = Number(await preview.getAttribute('aria-valuenow'));
      await preview.press('ArrowLeft');
      await expect(preview).toHaveAttribute('aria-valuenow', String(previewWidth + 2));
      const previewPane = page.locator('.session-inspector');
      const initialPreviewWidth = (await previewPane.boundingBox())!.width;
      const layoutWidth = (await page.locator('.session-library-body').boundingBox())!.width;
      const previewBounds = (await preview.boundingBox())!;
      await page.mouse.move(
        previewBounds.x + previewBounds.width / 2,
        previewBounds.y + previewBounds.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        previewBounds.x + previewBounds.width / 2 - layoutWidth * 0.04,
        previewBounds.y + previewBounds.height / 2,
        { steps: 6 },
      );
      await page.mouse.up();
      await expect(preview).toHaveAttribute('aria-valuenow', String(previewWidth + 6));
      expect(
        Math.abs(
          (await previewPane.boundingBox())!.width - initialPreviewWidth - layoutWidth * 0.04,
        ),
      ).toBeLessThan(2);
      await page.getByRole('button', { name: 'Toggle preview' }).click();
      await expect(draft).toHaveValue('Preserve this unsent draft');
      await page.setViewportSize({ width: 800, height: 1000 });
      await page.getByRole('button', { name: 'Expand navigation' }).click();
      await page.getByTitle('Show sidebar', { exact: true }).click();
      await page.getByTitle('Show context', { exact: true }).click();
      await expect
        .poll(() =>
          page.locator('.desktop-center').evaluate((e) => e.getBoundingClientRect().width),
        )
        .toBeGreaterThanOrEqual(265);
    } else await expect(page.getByRole('separator')).toHaveCount(0);
    await expect(draft).toHaveValue('Preserve this unsent draft');
    expect(
      await page
        .locator('.msg-bubble--assistant td')
        .first()
        .evaluate((e) => getComputedStyle(e).whiteSpace),
    ).toBe('normal');
    const overflow = await page
      .locator('.table-scroll-wrapper')
      .evaluate((e) => e.scrollWidth - e.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`responsiveness-panels-${theme}.png`) });
    expect(errors).toEqual([]);
  });
