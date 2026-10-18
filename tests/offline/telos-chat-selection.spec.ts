import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

// Component adoption fixture: actual ordinary renderer/composer, entirely intercepted.
// Full ResponsiveChatView adoption and current S5b integration remain separate gates.
const bundle = build({
  entryPoints: [resolve('tests/fixtures/telos-chat-selection.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-s8-chat-selection.js',
  jsx: 'automatic',
  minify: true,
  external: ['/mitzo-wordmark.png', '/openshell-mark.svg', '/github-mark.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});
for (const theme of ['dark', 'light']) {
  test(`S8 chooser and collapsed tree retain ordinary chat state (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const errors: string[] = [];
    const writes: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const files = (await bundle).outputFiles!;
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/api/')) {
        if (route.request().method() !== 'GET') writes.push(path);
        return route.fulfill({ json: [] });
      }
      const file = files.find(
        (file) => path === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>body{margin:0;background:var(--color-bg);color:var(--color-text);font-family:var(--font-ui)}main{padding:var(--page-gutter)}.fixture-header{display:flex;gap:var(--space-2);align-items:center;padding:var(--space-3)}.fixture-header button{min-height:var(--control-height);min-width:var(--control-height);font:inherit;background:transparent;color:var(--color-accent);border:0}.fixture-header h1{font-size:var(--text-lg);margin:0;overflow-wrap:anywhere}.fixture-header output{font-size:var(--text-xs)}.fixture-conversation{padding:var(--page-gutter);min-width:0}.fixture-conversation .chat-area{position:static} ${theme === 'light' ? 'html{font-size:125%}' : ''}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Chats · 3' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message Mitzo', exact: true })).toHaveCount(0);
    await expect(page.locator('[aria-current], [aria-selected="true"]')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`chooser-${theme}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Open Assigned worker', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
    await input.fill('Keep this unsent worker draft.');
    await expect(page.getByText('Worker transcript')).toBeVisible();
    const trigger = page.getByRole('button', { name: 'Toggle work tree' });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    const transcript = page.locator('.telos-chat-transcript');
    const fullWidth = (await transcript.boundingBox())!.width;
    await trigger.click();
    await expect(page.getByRole('region', { name: 'Work tree' })).toBeVisible();
    await expect(page.getByText('Awaiting review')).toBeVisible();
    await expect(page.getByText('P7', { exact: true })).toBeVisible();
    if (isMobile) await expect(input).toBeHidden();
    else expect((await transcript.boundingBox())!.width).toBeLessThan(fullWidth);
    await page.screenshot({ path: info.outputPath(`tree-open-${theme}.png`), fullPage: true });
    const close = page.getByRole('button', { name: 'Close work tree' });
    await close.focus();
    await close.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('Keep this unsent worker draft.');
    expect((await transcript.boundingBox())!.width).toBeCloseTo(fullWidth, 0);
    await page.screenshot({ path: info.outputPath(`chat-closed-${theme}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Chats · 3' })).toBeVisible();
    await page.getByRole('button', { name: 'Open Reviewer', exact: true }).click();
    await expect(input).toHaveValue('');
    await input.fill('Independent reviewer draft.');
    await expect(page.getByText('Reviewer transcript')).toBeVisible();
    await expect(page.getByLabel('Fixture account')).toHaveText('Review account');
    await page.getByRole('button', { name: 'Chats for this item: 3' }).click();
    await page.getByRole('button', { name: 'Open Assigned worker', exact: true }).click();
    await expect(input).toHaveValue('Keep this unsent worker draft.');
    await expect(page.getByLabel('Fixture account')).toHaveText('Work account');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Chats · 3' })).toBeVisible();
    await page.getByRole('button', { name: 'Open Assigned worker', exact: true }).click();
    await expect(input).toHaveValue('Keep this unsent worker draft.');
    for (const button of await page.locator('.telos-chat-context-row button').all()) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });
}
