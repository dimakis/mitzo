import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

// Real parser, reducer, transcript and composer; all traffic is intercepted.
// This focused fixture needs no app build, backend, credentials or model.
const bundle = build({
  entryPoints: [resolve('tests/fixtures/device-continuity.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-device-continuity.js',
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
  test(`device handoff preserves a live reply, approvals and composer (${theme})`, async ({
    page,
    isMobile,
  }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const files = (await bundle).outputFiles!;
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/api/')) return route.fulfill({ json: [] });
      const file = files.find((file) => path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'));
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="teal" data-font="georgia"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{margin:0;height:100%;overflow:hidden}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
    await page.goto('/');
    const input = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
    await expect(input).toBeVisible();
    const emit = (message: Record<string, unknown>) =>
      page.evaluate(
        (message) =>
          window.dispatchEvent(
            new CustomEvent('fixture-server-message', {
              detail: { sessionId: 'shared-chat', ...message },
            }),
          ),
        message,
      );
    await emit({ type: 'session_state_changed', state: 'running' });
    await emit({ type: 'message_start', messageId: 'reply' });
    await emit({ type: 'block_start', messageId: 'reply', blockId: 'answer', blockType: 'text' });
    await emit({
      type: 'block_delta',
      messageId: 'reply',
      blockId: 'answer',
      blockType: 'text',
      delta: 'Continuing our shared conversation.',
    });
    await emit({
      type: 'permission_request',
      permId: 'approval',
      toolName: 'Bash',
      toolInput: '{"command":"git status"}',
    });
    await expect(page.getByText('git status', { exact: false })).toBeVisible();
    await input.fill('Continue from this device');
    await input.focus();
    for (const extra of [{}, { seq: 42 }, { seq: 42, replayed: true }]) {
      await emit({ type: 'session_takeover', ...extra });
      await expect(
        page.getByText('Session resumed on another device.', { exact: false }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Stop generation', exact: true }),
      ).toBeVisible();
      await expect(page.getByText('git status', { exact: false })).toBeVisible();
      await expect(input).toHaveValue('Continue from this device');
      await expect(input).toBeFocused();
    }
    await emit({
      type: 'block_delta',
      messageId: 'reply',
      blockId: 'answer',
      blockType: 'text',
      delta: ' The next reply arrives here too.',
    });
    await expect(
      page.getByText('Continuing our shared conversation. The next reply arrives here too.', {
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`device-continuity-${theme}.png`) });
    await emit({ type: 'permission_resolved', permId: 'approval' });
    await expect(page.getByText('git status', { exact: false })).toHaveCount(0);
    await expect(input).toHaveValue('Continue from this device');
    await expect(input).toBeFocused();
    await emit({
      type: 'permission_request',
      permId: 'next-approval',
      toolName: 'Bash',
      toolInput: 'git diff',
    });
    await expect(page.getByText('git diff', { exact: false })).toBeVisible();
    await emit({ type: 'permission_timeout', permId: 'next-approval' });
    await expect(page.getByText('git diff', { exact: false })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible();
    await expect(input).toBeFocused();
    expect(errors).toEqual([]);
  });
}
