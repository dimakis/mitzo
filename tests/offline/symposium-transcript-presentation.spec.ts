import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import { sharedPrompt, sharedReply } from '../fixtures/symposium-shared-conversation-data';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/symposium-transcript-presentation.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  write: false,
  outfile: '/tmp/s5-transcript.js',
  jsx: 'automatic',
  minify: true,
  external: ['/openai-mark.svg', '/claude-mark.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});

for (const theme of ['light', 'dark'])
  test(`retains author, reply, activity and color through completion and reload (${theme})`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const files = (await bundle).outputFiles!;
    await page.route('**/*', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: `<html data-theme="${theme}"><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
        });
      if (path === '/fixture.js')
        return route.fulfill({
          contentType: 'application/javascript',
          body: files.find((file) => file.path.endsWith('.js'))!.text,
        });
      if (path === '/fixture.css')
        return route.fulfill({
          contentType: 'text/css',
          body: files.find((file) => file.path.endsWith('.css'))!.text,
        });
      return route.fulfill({ json: {} });
    });
    await page.goto('/');
    const assignment = page.locator('[data-speaker-session="reader"]');
    await expect(assignment).toContainText(sharedPrompt.text);
    await expect(assignment).toContainText('Lead agent');
    const answer = page.locator('[data-speaker-session="architect"]');
    await expect(answer).toContainText(sharedReply.text);
    const accent = await answer.evaluate((node) =>
      (node as HTMLElement).style.getPropertyValue('--message-speaker-color'),
    );
    const activity = page.getByRole('button', {
      name: /Architect with a long readable name.*Activity: Run command/,
    });
    await expect(activity).not.toContainText('technical-reference');
    await page.getByRole('button', { name: 'Complete reply', exact: true }).click();
    await expect(
      page.getByRole('button', { name: `Replying to: ${sharedPrompt.text}` }),
    ).toHaveCount(1);
    await page.getByRole('button', { name: 'Remove reviewer', exact: true }).click();
    await page.getByRole('button', { name: 'Reload transcript', exact: true }).click();
    await expect(answer).toContainText(sharedReply.text);
    expect(
      await answer.evaluate((node) =>
        (node as HTMLElement).style.getPropertyValue('--message-speaker-color'),
      ),
    ).toBe(accent);
    await expect(activity).toHaveAttribute('aria-expanded', 'false');
    await activity.focus();
    await page.keyboard.press('Enter');
    await expect(activity).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: /^mcp__mitzo__TaskExecution/ }).click();
    await expect(page.locator('.tool-pill-detail')).toBeVisible();
    await expect(page.locator('.tool-pill-detail')).toContainText('technical-reference');
    // WebKit reports a 44px target as e.g. 43.99999; compare at 1/100px.
    expect(
      await activity.evaluate(
        (node) => Math.round(node.getBoundingClientRect().height * 100) / 100,
      ),
    ).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath(`s5-transcript-${theme}.png`), fullPage: true });
  });
