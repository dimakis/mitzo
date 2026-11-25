import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import { contextSnapshotFixture } from '../support/context-snapshot-fixture';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/context-snapshot-inspector.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  write: false,
  format: 'esm',
  outfile: '/tmp/context-snapshot-inspector.js',
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

for (const theme of ['dark', 'light']) {
  test(`context inspector: passive read, consent, composer and focus (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const errors: string[] = [];
    const requests: { method: string; path: string; body: unknown; intent: string | undefined }[] =
      [];
    page.on('pageerror', (error) => errors.push(error.message));
    const files = (await bundle).outputFiles;
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
    await page.emulateMedia({ reducedMotion: theme === 'light' ? 'reduce' : 'no-preference' });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== 'http://mitzo-ui.test') return route.abort();
      if (url.pathname.includes('/context-snapshot')) {
        requests.push({
          method: request.method(),
          path: url.pathname,
          body: request.postData() ? request.postDataJSON() : undefined,
          intent: request.headers()['x-mitzo-context-intent'],
        });
        return route.fulfill({
          json: contextSnapshotFixture(url.pathname.includes('/two/') ? 'two' : 'one'),
        });
      }
      if (url.pathname.startsWith('/api/')) {
        if (request.method() !== 'GET') return route.abort();
        return route.fulfill({ json: [] });
      }
      const asset = files.find(
        (file) => url.pathname === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (asset)
        return route.fulfill({
          body: asset.text,
          contentType: asset.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (url.pathname !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'light' ? 'teal' : 'mint'}" data-font="${theme === 'light' ? 'georgia' : 'system'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
      });
    });
    await page.goto('/');
    if (theme === 'light') await page.addStyleTag({ content: 'html { font-size: 125%; }' });
    const draft = page.getByRole('textbox', { name: 'Message' });
    await draft.fill('Keep my draft');
    const wheel = page.getByRole('button', { name: 'Token usage', exact: true });
    await page.getByRole('button', { name: 'Record voice message' }).click();
    await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible();
    await wheel.click();
    expect(requests).toEqual([]);
    const trigger = page.getByRole('button', { name: 'Inspect context' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Context snapshot' });
    await expect(dialog.getByText('12,001 tokens (estimated)')).toBeVisible();
    expect(requests.map((request) => request.method)).toEqual(['GET']);
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`context-inspector-${theme}.png`) });
    await dialog.getByRole('button', { name: 'Full detail…' }).click();
    const full = dialog.getByRole('button', { name: 'Refresh full detail' });
    await expect(full).toBeDisabled();
    const consent = dialog.getByRole('checkbox');
    await consent.focus();
    await page.keyboard.press('Space');
    await expect(full).toBeEnabled();
    for (const control of [
      full,
      dialog.getByRole('button', { name: 'Refresh summary' }),
      dialog.getByRole('button', { name: 'Close', exact: true }),
    ]) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await full.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`context-consent-${theme}.png`) });
    await full.click();
    await expect(dialog.getByText('Snapshot partial')).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      method: 'POST',
      intent: 'refresh-full',
      body: {
        detail: 'full',
        allowTokenCount: true,
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(draft).toHaveValue('Keep my draft');
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByRole('button', { name: 'Transcribing audio' })).toBeDisabled();
    await trigger.click();
    await expect(dialog.getByText('Snapshot partial')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Transcribing audio' })).toBeDisabled();
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-transcribed')));
    await expect(page.getByRole('button', { name: 'Record voice message' })).toBeVisible();
    await trigger.click();
    await expect(dialog).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-switch-chat')));
    await expect(dialog).toBeHidden();
    expect(errors).toEqual([]);
  });
}
