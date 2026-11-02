import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import { compactDisplayResponse } from '../fixtures/compact-display-data';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/compact-display.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  format: 'esm',
  write: false,
  outfile: '/tmp/mitzo-compact-display.js',
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

test.beforeEach(async ({ page }) => {
  const files = (await bundle).outputFiles;
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (url.pathname === '/fixture.js' || url.pathname === '/fixture.css') {
      const css = url.pathname.endsWith('.css');
      return route.fulfill({
        body: files.find((file) => file.path.endsWith(css ? '.css' : '.js'))!.text,
        contentType: css ? 'text/css' : 'text/javascript',
      });
    }
    if (url.pathname.startsWith('/api/'))
      return route.fulfill({ json: compactDisplayResponse(url.pathname, url.searchParams) });
    if (url.pathname.endsWith('.png') || url.pathname.endsWith('.svg')) {
      const path = resolve('frontend/public', url.pathname.slice(1));
      if (!path.startsWith(resolve('frontend/public') + '/')) return route.abort();
      return route.fulfill({
        body: await readFile(path),
        contentType: url.pathname.endsWith('.png') ? 'image/png' : 'image/svg+xml',
      });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>',
    });
  });
});

test('preview controls share one row on phones and retain local interactions', async ({ page }) => {
  const html = await readFile('mockups/compact-file-viewer/v004.html', 'utf8');
  await page.route('**/preview', (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  );
  await page.goto('/preview');
  const controls = page.locator('.preview-controls');
  await expect(page.getByRole('button', { name: 'File options', exact: true })).toBeVisible();
  for (const width of [280, 320, 393, 1280]) {
    await page.setViewportSize({ width, height: 852 });
    const boxes = [];
    for (const select of await controls.getByRole('combobox').all()) {
      await expect(select).toBeInViewport();
      const box = (await select.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
      boxes.push(box);
    }
    expect(boxes).toHaveLength(3);
    expect(
      Math.max(...boxes.map((box) => box.y)) - Math.min(...boxes.map((box) => box.y)),
    ).toBeLessThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.setViewportSize({ width: 320, height: 852 });
  await page.getByLabel('Theme', { exact: true }).selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'teal');
  await expect(page.locator('html')).toHaveAttribute('data-font', 'georgia');
  await page.getByLabel('View', { exact: true }).selectOption('/chat');
  await expect(page.getByRole('textbox', { name: 'Message Mitzo', exact: true })).toBeVisible();
  await page.getByLabel('Screen', { exact: true }).selectOption('320');
  expect((await page.locator('#root').boundingBox())!.width).toBeLessThanOrEqual(320);
  await expect(page.getByText('Draft autosaves on this device', { exact: true })).toBeVisible();
  await controls.getByLabel('Theme', { exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(controls.getByLabel('View', { exact: true })).toBeFocused();
});

for (const theme of ['dark', 'light']) {
  test(`compact document header and screenshot autosave (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    await page.setViewportSize({ width: isMobile ? 393 : 1280, height: 852 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.accent = theme === 'dark' ? 'mint' : 'teal';
      document.documentElement.dataset.font = theme === 'dark' ? 'system' : 'georgia';
    }, theme);
    await page.goto('/files?path=v001.md');
    const header = page.locator('.viewer-header');
    await expect(header.getByRole('button', { name: 'Read', exact: true })).toBeVisible();
    if (isMobile) expect((await header.boundingBox())!.height).toBeLessThanOrEqual(64);
    await page.screenshot({
      path: info.outputPath(`responsiveness-compact-display-${theme}-header.png`),
    });
    for (const width of isMobile ? [320, 393] : [1280]) {
      await page.setViewportSize({ width, height: 852 });
      for (const button of await header.getByRole('button').all()) {
        const box = (await button.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        await expect(button).toBeInViewport();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.getByRole('button', { name: 'File options', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'File options', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Share file' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'File options', exact: true })).toBeFocused();
    }
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '20px';
    });
    await expect(header.getByRole('button', { name: 'Edit', exact: true })).toBeInViewport();
    await page.locator('.viewer-content').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(page.getByText('Last paragraph.', { exact: true })).toBeInViewport();
    await page.goto('/chat');
    const input = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
    const status = page.locator('.chat-draft-save-status').first();
    await expect(status).toHaveText('Draft autosaves on this device');
    await input.focus();
    await page.evaluate(() => {
      const node = document.querySelector('.chat-draft-save-status')!;
      const messages: string[] = [];
      new MutationObserver(() => {
        if (node.textContent) messages.push(node.textContent);
      }).observe(node, { childList: true, subtree: true, characterData: true });
      Object.assign(window, { autosaveStatusNode: node, autosaveMessages: messages });
    });
    await input.pressSequentially(' with a few more details', { delay: 30 });
    await page.evaluate(() =>
      (window as unknown as { displayStorage: { flush(): Promise<void> } }).displayStorage.flush(),
    );
    await expect(status).toHaveText('Draft autosaves on this device');
    await expect(input).toBeFocused();
    expect(
      await page.evaluate(() => {
        const state = window as unknown as { autosaveStatusNode: Node; autosaveMessages: string[] };
        return (
          state.autosaveStatusNode === document.querySelector('.chat-draft-save-status') &&
          state.autosaveMessages.every((text) => text === 'Draft autosaves on this device')
        );
      }),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`responsiveness-compact-display-${theme}-draft.png`),
    });
  });
}
