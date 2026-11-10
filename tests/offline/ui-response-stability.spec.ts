import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';

// Reuse the real store/composer/transcript fixture without changing protected
// approved-design suites. All traffic remains intercepted and synthetic.
const bundle = build({
  entryPoints: [resolve('tests/fixtures/chat-queue-steering.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  external: ['/*.png', '/*.svg'],
  format: 'esm',
  write: false,
  outfile: '/tmp/mitzo-response-stability.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});

for (const theme of ['dark', 'light']) {
  test(`send receipt and response completion preserve the composer and transcript (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const files = (await bundle).outputFiles!;
    const errors: string[] = [];
    const sends: unknown[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/fixture/queue') sends.push(route.request().postDataJSON());
      if (path.startsWith('/api/') || path.startsWith('/fixture/'))
        return route.fulfill({ json: [] });
      const asset = files.find((file) =>
        path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'),
      );
      if (asset)
        return route.fulfill({
          contentType: asset.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          body: asset.text,
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/stability.css"><div id="root"></div><script type="module" src="/stability.js"></script></html>`,
      });
    });
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
    await page.goto('/');
    const input = page.getByRole('textbox', { name: 'Message Mitzo' });
    await expect(input).toBeVisible();
    const retainedInput = await input.elementHandle();
    const retainedTranscript = await page.locator('.chat-messages').elementHandle();
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          queueFixture: { holdDelivery(value: boolean): void; emit(event: object): void };
        }
      ).queueFixture;
      fixture.holdDelivery(true);
      fixture.emit({ type: 'session_state_changed', state: 'idle' });
    });
    await input.fill('A submitted prompt\nwith multiple lines\nand a retained receipt.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(input).toHaveValue('');
    await expect.poll(() => sends.length).toBe(1);
    await input.fill('My next independent draft');
    await page.evaluate(() => {
      const fixture = (
        window as unknown as { queueFixture: { acceptDelivery(): void; emit(event: object): void } }
      ).queueFixture;
      fixture.acceptDelivery();
      fixture.emit({ type: 'session_state_changed', state: 'running' });
      fixture.emit({ type: 'message_start', messageId: 'stable-stream' });
      fixture.emit({
        type: 'block_start',
        messageId: 'stable-stream',
        blockId: 'stable-text',
        blockType: 'text',
      });
      fixture.emit({
        type: 'block_delta',
        messageId: 'stable-stream',
        blockId: 'stable-text',
        blockType: 'text',
        delta: 'Response stays mounted through completion.',
      });
    });
    const response = page.getByText('Response stays mounted through completion.', { exact: true });
    await expect(response).toBeVisible();
    const retainedResponse = await response.elementHandle();
    await page.evaluate(() => {
      const fixture = (window as unknown as { queueFixture: { emit(event: object): void } })
        .queueFixture;
      fixture.emit({
        type: 'block_end',
        messageId: 'stable-stream',
        blockId: 'stable-text',
        blockType: 'text',
      });
      fixture.emit({ type: 'message_end', messageId: 'stable-stream' });
    });
    await expect(page.locator('.msg-turn--streaming')).toHaveCount(0);
    expect(await retainedResponse!.evaluate((element) => element.isConnected)).toBe(true);
    expect(await retainedInput!.evaluate((element) => element.isConnected)).toBe(true);
    expect(await retainedTranscript!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(input).toHaveValue('My next independent draft');
    for (const height of [500, 844]) {
      await page.setViewportSize({ width: isMobile ? 320 : 1280, height });
      await expect(input).toBeInViewport();
      await expect(input).toHaveValue('My next independent draft');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    expect(sends).toHaveLength(1);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: info.outputPath(`response-stability-${theme}.png`),
      fullPage: true,
    });
  });
}
