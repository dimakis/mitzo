import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

// Actual retained-context renderer and ordinary composer; no app build or backend.
const bundle = build({
  entryPoints: [resolve('tests/fixtures/telos-readable-context.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-telos-readable-context.js',
  jsx: 'automatic',
  minify: true,
  external: ['/mitzo-wordmark.png', '/openshell-mark.svg', '/github-mark.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});

for (const theme of ['dark', 'light']) {
  test(`retained Telos context stays readable and preserves the ordinary draft (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const errors: string[] = [];
    const apiCalls: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const files = (await bundle).outputFiles!;
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) {
        apiCalls.push(url.pathname + url.search);
        return url.pathname.startsWith('/api/telos/artifacts/')
          ? route.fulfill({ status: 503, json: { error: 'Retained material unavailable.' } })
          : route.fulfill({ json: [] });
      }
      const file = files.find((file) =>
        url.pathname.endsWith(file.path.endsWith('.css') ? '.css' : '.js'),
      );
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (url.pathname !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{margin:0;height:100%;overflow:hidden}${theme === 'light' ? 'html{font-size:160%}' : ''}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
    await page.goto('/');
    const input = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
    await input.fill('Keep this unsent recording plan.');
    const summary = page.locator('summary');
    await summary.focus();
    await expect(summary).toBeFocused();
    await page.waitForLoadState('networkidle');
    const callsBeforeOpening = [...apiCalls];
    await summary.press('Enter');
    const details = page.locator('details');
    await expect(details).toHaveAttribute('open', '');
    expect(apiCalls).toEqual(callsBeforeOpening);
    const sections = ['Overall goal', 'Parent outcome', 'This item', 'Done when'];
    expect(
      (await details.getByRole('heading').allTextContents()).filter((text) =>
        sections.includes(text),
      ),
    ).toEqual(sections);
    await expect(input).toHaveValue('Keep this unsent recording plan.');
    await page.screenshot({ path: info.outputPath(`linked-context-top-${theme}.png`) });

    for (const control of [
      summary,
      ...(await details.getByRole('link').all()),
      details.getByRole('button'),
    ]) {
      await control.scrollIntoViewIfNeeded();
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(
      await details.getByRole('link', { name: 'Open overall goal' }).getAttribute('href'),
    ).toBe('/todos/studio');
    expect(await details.getByRole('link', { name: 'Parent item' }).getAttribute('href')).toBe(
      '/todos/session-plan',
    );
    expect(
      await details.getByRole('link', { name: 'Open original chat' }).getAttribute('href'),
    ).toBe('/chat/planning?telosItem=recording&telosSource=opaque-retained-snapshot');
    await details.getByRole('button', { name: 'Open material revision 2' }).click();
    await expect(page.getByRole('alert')).toHaveText('Retained material unavailable.');
    await page.getByRole('alert').scrollIntoViewIfNeeded();
    await expect(page.getByRole('alert')).toBeInViewport();
    expect(apiCalls.filter((url) => url.startsWith('/api/telos/artifacts/'))).toEqual([
      `/api/telos/artifacts/${'e'.repeat(32)}?revision=2`,
    ]);
    await expect(input).toHaveValue('Keep this unsent recording plan.');
    await expect(input).toBeInViewport();
    await expect(details).not.toContainText('opaque-retained-snapshot');
    await expect(details).not.toContainText('f'.repeat(64));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`linked-context-material-${theme}.png`) });
    await summary.focus();
    await summary.press('Enter');
    await expect(details).not.toHaveAttribute('open', '');
    await input.focus();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Keep this unsent recording plan.');
    expect(errors).toEqual([]);
  });
}
