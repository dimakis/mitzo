import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const output = build({
  entryPoints: [resolve('tests/fixtures/agent-messages.tsx')],
  bundle: true,
  external: ['/*.png', '/*.svg'],
  format: 'esm',
  write: false,
  outfile: '/tmp/mitzo-agent-messages.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
});
for (const theme of ['dark', 'light'])
  test(`visible peer messages and delivery state (${theme})`, async ({ page }, info) => {
    const files = (await output).outputFiles!;
    const errors: string[] = [];
    let chatName = 'PR coordinator — native subagents first';
    let metadataStatus = 200;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const metadata = /^\/api\/sessions\/([^/]+)\/meta$/.exec(path);
      if (metadata)
        return route.fulfill({
          status: metadataStatus,
          contentType: 'application/json',
          body: JSON.stringify({
            sessionId: metadata[1],
            summary: metadata[1] === 'feature' ? 'Independent feature session' : chatName,
          }),
        });
      if (/^\/(openai|claude|openshell|github)-mark.svg$/.test(path))
        return route.fulfill({
          contentType: 'image/svg+xml',
          body: await readFile(resolve('frontend/public' + path)),
        });
      if (path === '/fixture.js')
        return route.fulfill({
          contentType: 'text/javascript',
          body: files.find((file) => file.path.endsWith('.js'))!.text,
        });
      if (path === '/fixture.css')
        return route.fulfill({
          contentType: 'text/css',
          body: files.find((file) => file.path.endsWith('.css'))!.text,
        });
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="mint" data-font="georgia"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html{font-size:20px}</style><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
      });
    });
    await page.goto('/');
    const incoming = page.getByRole('article', { name: 'Agent message received' });
    await expect(incoming).toContainText('This entire message remains visible before delivery.');
    await expect(incoming.getByRole('status')).toContainText('Queued — not delivered');
    await page.getByRole('button', { name: 'Record delivery' }).click();
    await expect(incoming.getByRole('status')).toHaveText('Delivered to agent');
    await page.getByRole('button', { name: 'Show failure' }).click();
    await expect(incoming.getByRole('status')).toHaveText('Delivery failed');
    await incoming.getByText('Message details').click();
    await expect(incoming).toContainText('c5d70b9d-8b6f-4640-bdf4-a958abb272f6');
    await expect(page.getByRole('article', { name: 'Agent message sent' })).toContainText(
      'Holding PR work.',
    );
    const link = incoming.getByRole('link', { name: 'PR coordinator — native subagents first' });
    await link.focus();
    await expect(link).toBeFocused();
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await link.getAttribute('href')).toBe('/chat/64d8bed3-f73f-8939-8dcf-987cd24fcf6f');
    chatName = 'Renamed coordinator with a longer readable chat name';
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(incoming.getByRole('link')).toHaveText(chatName);
    metadataStatus = 503;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(incoming).toContainText('Chat name unavailable. Showing the last known name.');
    await expect(incoming.getByRole('link')).toHaveText(chatName);
    await expect(incoming.getByRole('status')).toHaveText('Delivery failed');
    metadataStatus = 404;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(incoming.getByRole('link')).toHaveText('Unavailable chat');
    await expect(incoming).toContainText('64d8bed3-f73f-8939-8dcf-987cd24fcf6f');
    metadataStatus = 200;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(incoming.getByRole('link')).toHaveText(chatName);
    const quote = page.locator('.chat-messages .chat-reply-link');
    await expect(quote).toContainText('You');
    await expect(quote.locator('time')).toBeVisible();
    await quote.click();
    const original = page.locator('[data-reply-source="original-question"]');
    await expect(original).toBeFocused();
    await expect(original).toHaveClass(/chat-reply-target/);
    await page.getByRole('button', { name: 'Back to reply' }).click();
    await expect(quote).toBeFocused();
    const composerQuote = page.locator('.fixture-composer .chat-reply-link');
    await composerQuote.click();
    await expect(original).toBeFocused();
    await page.getByRole('button', { name: 'Back to reply' }).click();
    await expect(composerQuote).toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath(`agent-messages-${theme}.png`), fullPage: true });
  });
