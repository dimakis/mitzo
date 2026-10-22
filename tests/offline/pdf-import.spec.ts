import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pdfFixture } from '../support/pdf-fixture';
import { deployedSecurityHeaders } from '../support/response-security';

const pdfRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const output = build({
  entryPoints: [resolve('tests/fixtures/pdf-import.tsx')],
  bundle: true,
  format: 'esm',
  write: false,
  outfile: '/tmp/mitzo-pdf-import.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"BASE_URL":"/"}' },
  alias: {
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
  plugins: [
    {
      name: 'offline-pdf-worker',
      setup(build) {
        build.onResolve({ filter: /pdf\.worker\.min\.mjs\?url$/ }, () => ({
          path: 'pdf-worker',
          namespace: 'pdf-worker',
        }));
        build.onLoad({ filter: /.*/, namespace: 'pdf-worker' }, () => ({
          contents: 'export default "/pdf.worker.min.mjs";',
          loader: 'js',
        }));
      },
    },
  ],
});

for (const theme of ['dark', 'light']) {
  test(`PDF import renders complete text and scanned pages (${theme})`, async ({ page }, info) => {
    const files = (await output).outputFiles!;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'mitzo-ui.test') return route.abort();
      const path = url.pathname;
      if (path.startsWith('/api/'))
        return route.fulfill({ json: path === '/api/config' ? { contextBlocks: [] } : [] });
      if (path === '/pdf.worker.min.mjs')
        return route.fulfill({
          body: await readFile(resolve(pdfRoot, 'build/pdf.worker.min.mjs')),
          contentType: 'application/javascript',
        });
      if (path.startsWith('/pdfjs/')) {
        const asset = resolve(pdfRoot, path.slice('/pdfjs/'.length));
        if (!asset.startsWith(pdfRoot + '/')) return route.abort();
        return route.fulfill({
          body: await readFile(asset),
          contentType: path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream',
        });
      }
      const file = files.find((file) => path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'));
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: path.endsWith('.css') ? 'text/css' : 'application/javascript',
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        headers: deployedSecurityHeaders(),
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 844,
    });
    await page.goto('/');
    const input = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
    await input.fill('Summarize the attached report');
    const more = page.getByRole('button', { name: 'More composer actions', exact: true });
    if (await more.isVisible()) await more.click();
    await expect(
      page.getByRole('button', { name: 'Attach images or PDF', exact: true }),
    ).toBeVisible();
    if (await more.isVisible()) await page.keyboard.press('Escape');
    const picker = page.locator('input[type=file]');
    await picker.setInputFiles({
      name: 'report.pdf',
      mimeType: 'application/pdf',
      buffer: pdfFixture(),
    });
    await expect(page.getByAltText('report.pdf — page 1 of 2')).toBeVisible();
    await expect(page.getByAltText('report.pdf — page 2 of 2')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    for (const pageNumber of [1, 2]) {
      const image = page.getByAltText(`report.pdf — page ${pageNumber} of 2`);
      expect(await image.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(600);
    }
    await page.screenshot({ path: info.outputPath(`pdf-import-${theme}.png`) });
    await page
      .getByRole('button', { name: 'Preview report.pdf — page 1 of 2', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`pdf-preview-${theme}.png`) });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByLabel('Submitted message')).toContainText('report.pdf — page 2 of 2');
    const sent = JSON.parse((await page.getByLabel('Submitted message').textContent()) ?? '{}');
    expect(sent.images).toHaveLength(2);
    expect(
      sent.images.every(
        (image: { mediaType: string; bytes: number }) =>
          image.mediaType === 'image/jpeg' && image.bytes > 100,
      ),
    ).toBe(true);
    expect(sent.text).toContain('Summarize the attached report');
    await picker.setInputFiles({
      name: 'broken.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('invalid PDF'),
    });
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(input).toHaveValue('Summarize the attached report');
    await page.screenshot({ path: info.outputPath(`pdf-error-${theme}.png`) });
    expect(errors).toEqual([]);
  });
}
