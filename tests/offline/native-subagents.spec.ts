import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import type { NativeSubagentSnapshot } from '@mitzo/protocol';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/native-subagents.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  external: ['/*.png', '/*.svg'],
  format: 'esm',
  write: false,
  outfile: '/tmp/mitzo-native-subagents.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});
const agents: NativeSubagentSnapshot[] = [
  {
    commandId: 'command',
    threadId: 'edge',
    parentThreadId: 'parent',
    name: 'Edge cases',
    task: 'Check whitespace, empty queries and Unicode matching.',
    model: 'fixture',
    available: true,
    state: 'working',
    turnId: 'edge-turn',
    revision: 1,
    blocks: [
      {
        id: 'output',
        type: 'text',
        content: 'Checking the empty-query behavior and combined filters.',
      },
      { id: 'tool', type: 'tool', name: 'Read', content: 'inbox/search.ts', status: 'completed' },
    ],
  },
  {
    commandId: 'command',
    threadId: 'tests',
    parentThreadId: 'parent',
    name: 'Test review',
    task: 'Review regression coverage.',
    model: 'fixture',
    available: true,
    state: 'completed',
    revision: 1,
    blocks: [
      { id: 'result', type: 'text', content: 'The regression tests cover both filters together.' },
    ],
  },
];
for (const theme of ['dark', 'light'])
  test(`native subagents preserve the composer and target child controls (${theme})`, async ({
    page,
  }, info) => {
    const output = (await bundle).outputFiles!;
    const controls: Record<string, unknown>[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((seed) => {
      const original = window.fetch.bind(window);
      const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
      const encode = (value: unknown) =>
        new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
      (window as unknown as { nativeActivity: { publish(value: unknown): void } }).nativeActivity =
        {
          publish(value) {
            for (const controller of streams) controller.enqueue(encode(value));
          },
        };
      window.fetch = async (input, init) => {
        if (String(input).endsWith('/codex-subagents/events')) {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              streams.add(controller);
              controller.enqueue(encode({ type: 'reset', available: true }));
              for (const agent of seed) controller.enqueue(encode({ type: 'agent', agent }));
              init?.signal?.addEventListener(
                'abort',
                () => {
                  streams.delete(controller);
                  try {
                    controller.close();
                  } catch {
                    /* already closed */
                  }
                },
                { once: true },
              );
            },
          });
          return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
        }
        return original(input, init);
      };
    }, agents);
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/codex-subagents/control')) {
        const input = route.request().postDataJSON();
        controls.push(input);
        return route.fulfill({ json: { requestId: input.requestId, status: 'accepted' } });
      }
      if (path.startsWith('/api/')) return route.fulfill({ json: [] });
      const file = output.find((file) =>
        path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'),
      );
      if (file)
        return route.fulfill({
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          body: file.text,
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 844,
    });
    await page.goto('https://mitzo-ui.test/');
    const parent = page.getByRole('textbox', { name: 'Message Mitzo' });
    await parent.fill('Keep my parent draft');
    await expect(page.getByRole('button', { name: 'Token usage' })).toBeVisible();
    const group = page.getByRole('button', { name: /2 subagents.*1 working/ });
    await group.click();
    const child = page.getByRole('button', { name: /Edge cases.*Working/ });
    await child.click();
    const dialog = page.getByRole('dialog', { name: 'Edge cases' });
    await expect(
      dialog.getByText('Checking the empty-query behavior and combined filters.'),
    ).toBeVisible();
    const message = dialog.getByRole('textbox', { name: 'Message Edge cases' });
    await message.fill('Check tabs too');
    await page.evaluate(() =>
      (window as unknown as { completeFixtureParent(): void }).completeFixtureParent(),
    );
    await expect(dialog).toBeVisible();
    await expect(message).toHaveValue('Check tabs too');
    await dialog.getByRole('button', { name: 'Send to Edge cases' }).click();
    expect(errors).toEqual([]);
    await expect(message).toHaveValue('');
    expect(controls[0]).toMatchObject({
      action: 'message',
      threadId: 'edge',
      text: 'Check tabs too',
    });
    await dialog.getByRole('button', { name: 'Stop Edge cases' }).click();
    await expect.poll(() => controls.length).toBe(2);
    expect(controls[1]).toMatchObject({ action: 'stop', threadId: 'edge' });
    await page.screenshot({ path: info.outputPath(`native-subagents-${theme}.png`) });
    for (const button of await dialog.getByRole('button').all()) {
      const box = await button.boundingBox();
      if (box) expect(box.height).toBeGreaterThanOrEqual(44);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await dialog.getByRole('button', { name: 'Back to conversation' }).click();
    await expect(parent).toHaveValue('Keep my parent draft');
    await expect(child).toBeFocused();
    if (info.project.name.startsWith('mobile'))
      await page.getByRole('button', { name: 'More composer actions' }).click();
    await expect(page.getByRole('link', { name: 'Terminal', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
