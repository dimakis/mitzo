import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { reviewedContextBrowserData } from '../fixtures/telos-reviewed-context-data';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/telos-readable-context.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-telos-reviewed-context.js',
  jsx: 'automatic',
  minify: true,
  external: ['/mitzo-wordmark.png', '/openshell-mark.svg', '/github-mark.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});
test.setTimeout(60_000);
for (const theme of ['dark', 'light'])
  test(`canonical reviewed names and material revisions stay readable without replacement reads (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const data = await reviewedContextBrowserData();
    const files = (await bundle).outputFiles;
    const errors: string[] = [],
      calls: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) {
        calls.push(url.pathname + url.search);
        return url.pathname.startsWith('/api/telos/artifacts/')
          ? route.fulfill({ status: 503, json: { error: 'Retained material unavailable.' } })
          : route.fulfill({ status: 409, json: { error: 'No replacement reads permitted.' } });
      }
      const file = files.find(
        (value) => url.pathname === (value.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (url.pathname !== '/') return route.abort();
      const retained = JSON.stringify(data.review).replace(/</g, '\\u003c');
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{margin:0;height:100%;overflow:hidden}${theme === 'light' ? 'html{font-size:160%}' : ''}</style><div id="root"></div><script>window.__TELOS_REVIEW__=${retained}</script><script src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.goto('/');
    const composer = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
    await composer.fill('Keep this reviewed recording draft.');
    await composer.blur();
    const summary = page.locator('summary');
    await summary.focus();
    await summary.press('Enter');
    const details = page.locator('details');
    await expect(details).toHaveAttribute('open', '');
    await expect(
      details.getByRole('heading', { name: 'Home recording album', exact: true }),
    ).toBeVisible();
    await expect(
      details.getByRole('link', { name: 'First recording session', exact: true }),
    ).toHaveAttribute('href', '/todos/parent');
    await expect(details).toContainText('Studio planning');
    await expect(details).toContainText('Acoustic plan');
    await expect(details).toContainText('acoustic-plan.md');
    await expect(details).toContainText('Reviewed source record');
    await expect(details.locator('time').first()).toHaveAttribute(
      'datetime',
      data.review.presentation.sources[0].createdAt!,
    );
    const sourceLink = details.getByRole('link', { name: 'Open original chat' });
    await expect(sourceLink).toHaveAttribute(
      'href',
      `/chat/planning?telosItem=studio&telosSource=${data.source.snapshotId}`,
    );
    expect(calls).toEqual([]);
    await page.screenshot({ path: info.outputPath(`reviewed-context-top-${theme}.png`) });
    const material = details.locator('section').filter({ hasText: 'acoustic-plan.md' });
    const open = material.getByRole('button', { name: 'Open material revision 1', exact: true });
    await open.scrollIntoViewIfNeeded();
    await open.focus();
    await expect(open).toBeFocused();
    await open.press('Enter');
    await expect(page.getByRole('alert')).toHaveText('Retained material unavailable.');
    expect(calls).toEqual([`/api/telos/artifacts/${data.material.id}?revision=1`]);
    for (const control of [
      summary,
      ...(await details.getByRole('link').all()),
      ...(await details.getByRole('button').all()),
    ]) {
      await control.scrollIntoViewIfNeeded();
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(composer).toHaveValue('Keep this reviewed recording draft.');
    await expect(composer).toBeInViewport();
    await expect(details).not.toContainText(data.source.snapshotId);
    for (const pin of data.review.presentation.artifacts)
      await expect(details).not.toContainText(pin.sha256);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`reviewed-context-material-${theme}.png`) });
    await summary.focus();
    await summary.press('Enter');
    await expect(details).not.toHaveAttribute('open', '');
    await composer.focus();
    await expect(composer).toBeFocused();
    await page.reload();
    await expect(composer).toHaveValue('Keep this reviewed recording draft.');
    expect(calls).toHaveLength(1);
    expect(errors).toEqual([]);
  });
