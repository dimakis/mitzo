import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const output = build({
  entryPoints: [resolve('tests/fixtures/message-text-selection.tsx')],
  bundle: true,
  external: ['/*.png', '/*.svg'],
  format: 'esm',
  write: false,
  outfile: '/tmp/mitzo-message-selection.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: { '@mitzo/protocol': resolve('packages/protocol/src/index.ts') },
});

for (const theme of ['dark', 'light']) {
  test(`message selection stays native with reachable actions (${theme})`, async ({
    page,
  }, info) => {
    const files = (await output).outputFiles!;
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
        });
      const file = files.find((file) => path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'));
      return file
        ? route.fulfill({
            contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
            body: file.text,
          })
        : route.abort();
    });
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 844,
    });
    await page.emulateMedia({ reducedMotion: theme === 'light' ? 'reduce' : 'no-preference' });
    await page.goto('/');
    for (const role of ['user', 'assistant']) {
      const message = page.getByLabel(`Message from ${role === 'user' ? 'you' : 'Mitzo'}`, {
        exact: true,
      });
      const text = message.locator(
        role === 'user' ? '.msg-bubble-content' : '.msg-bubble-markdown p',
      );
      await text.dispatchEvent('pointerdown', {
        pointerType: 'touch',
        button: 0,
        clientX: 20,
        clientY: 20,
      });
      await page.waitForTimeout(600);
      await expect(page.getByRole('menu')).toHaveCount(0);
      const selection = await text.evaluate((el) => {
        const range = document.createRange();
        range.setStart(el.firstChild!, 0);
        range.setEnd(el.firstChild!, 6);
        const selected = window.getSelection()!;
        selected.removeAllRanges();
        selected.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        el.dispatchEvent(event);
        return { text: selected.toString(), prevented: event.defaultPrevented };
      });
      expect(selection.text).toHaveLength(6);
      expect(selection.prevented).toBe(false);
      await text.dispatchEvent('pointerup', { pointerType: 'touch', clientX: 120, clientY: 20 });
      await expect(page.getByLabel('Replies', { exact: true })).toHaveText('0');
      await expect(page.getByRole('menu')).toHaveCount(0);
      await page.evaluate(() => window.getSelection()!.removeAllRanges());
      const actions = message.getByRole('button', { name: 'Message actions', exact: true });
      const box = await actions.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      await actions.click();
      await expect(page.getByRole('menuitem', { name: 'Reply', exact: true })).toBeFocused();
      await page.screenshot({ path: info.outputPath(`message-actions-${role}-${theme}.png`) });
      await page.keyboard.press('Escape');
      await expect(actions).toBeFocused();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
