import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Keep the protected approval tests intact. This additional regression exercises
// their production preview and actual footer at the width the old guard missed.
const bundle = build({
  entryPoints: [resolve('frontend/src/preview/main.tsx')],
  bundle: true,
  external: ['/*.png', '/*.svg'],
  write: false,
  outfile: '/tmp/mitzo-symposium-footer.js',
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
  test(`Symposium footer retains the approved readable note track (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const files = (await bundle).outputFiles!;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'mitzo-ui.test' || route.request().method() !== 'GET')
        return route.abort();
      if (
        [
          '/mitzo-wordmark.png',
          '/mitzo-icon.png',
          '/openshell-mark.svg',
          '/github-mark.svg',
        ].includes(url.pathname)
      )
        return route.fulfill({
          body: await readFile(resolve('frontend/public', url.pathname.slice(1))),
          contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        });
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
      await page.getByRole('button', { name: 'Agents, Architect, Reviewer' }).click();
      await page.getByRole('button', { name: 'Add agent', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Add agent', exact: true });
      const note = dialog.getByText('Fresh session · starts with a prompt.', { exact: true });
      await expect(note).toBeInViewport();
      // The approved HTML specifies a 72px minimum; at 390px the old footer
      // collapsed this note to one-word lines while every button still fit.
      expect((await note.boundingBox())!.width).toBeGreaterThanOrEqual(72);
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
      await expect(dialog.getByRole('button', { name: 'Review joining brief' })).toBeInViewport();
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({
        style: '[data-ui-preview-banner] { visibility:hidden; }',
        path: info.outputPath(`fresh-setup-footer-${width}-${theme}.png`),
      });
    }
    expect(errors).toEqual([]);
  });
