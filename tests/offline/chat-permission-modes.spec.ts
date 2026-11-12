import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/chat-permission-modes.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/chat-permission-modes.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.svg', '/*.png'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: { '@mitzo/protocol': resolve('packages/protocol/src/index.ts') },
});

for (const theme of ['dark', 'light'])
  test(`permission controls retain modes, errors and drafts (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const saved: Record<string, string> = { '/mode/chat': 'agent', '/mode/draft': 'agent' };
    let rejectNext = true;
    const files = (await bundle).outputFiles!;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 850 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/*', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path in saved) {
        if (route.request().method() === 'POST') {
          if (rejectNext) {
            rejectNext = false;
            return route.fulfill({ status: 409, json: { error: 'Owner unavailable' } });
          }
          saved[path] = route.request().postDataJSON().mode;
        }
        return route.fulfill({ json: { mode: saved[path] } });
      }
      const asset = files.find(
        (file) => path === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (asset)
        return route.fulfill({
          body: asset.text,
          contentType: asset.path.endsWith('.css') ? 'text/css' : 'application/javascript',
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}" style="font-size:${theme === 'dark' ? 16 : 20}px"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    async function openModes() {
      await page.getByRole('button', { name: /^Workspace controls/ }).click();
      await page.getByRole('button', { name: /^More options/ }).click();
    }
    await page.goto('/');
    await expect(page.getByRole('status')).toHaveText('Saved mode: agent');
    await openModes();
    await page.getByRole('button', { name: 'Auto', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('The mode was not changed. Try again.');
    await expect(page.getByRole('button', { name: 'Agent', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Auto', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Saved mode: auto');
    for (const mode of ['Ask', 'Agent', 'Auto']) {
      const button = page.getByRole('button', { name: mode, exact: true });
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
    }
    await page.screenshot({ path: info.outputPath(`chat-modes-${theme}.png`) });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /^Workspace controls/ })).toBeFocused();
    await expect(page.getByRole('textbox', { name: 'Message draft' })).toHaveValue('Keep my draft');
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('Saved mode: auto');
    await page.goto('/?new');
    await expect(page.getByRole('status')).toHaveText('Saved mode: agent');
    await openModes();
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Saved mode: ask');
    await page.goto('/');
    await expect(page.getByRole('status')).toHaveText('Saved mode: auto');
    await expect(page.locator('body')).toHaveJSProperty(
      'scrollWidth',
      await page.locator('body').evaluate((body) => body.clientWidth),
    );
    expect(errors).toEqual([]);
  });
