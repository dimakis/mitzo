import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/native-subagents.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  external: ['/*.png', '/*.svg'],
  format: 'esm',
  write: false,
  outfile: '/tmp/mitzo-native-agent-presence.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});
for (const theme of ['dark', 'light'])
  test(`persistent agent chat, snap positions and retained drafts (${theme})`, async ({
    page,
  }, info) => {
    const output = (await bundle).outputFiles!;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        if (String(input).endsWith('/codex-subagents/events'))
          return new Response(
            new ReadableStream({
              start(controller) {
                const send = (value: unknown) =>
                  controller.enqueue(
                    new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`),
                  );
                send({ type: 'reset', available: true });
                send({
                  type: 'agent',
                  agent: {
                    commandId: 'command',
                    threadId: 'peirce',
                    parentThreadId: 'parent',
                    name: 'Peirce',
                    task: 'Review retry safety',
                    model: 'fixture',
                    state: 'working',
                    available: true,
                    revision: 1,
                    blocks: [
                      {
                        id: 'output',
                        type: 'text',
                        content:
                          'No remaining blocker in this delta. Read-only review; no tests run.',
                      },
                    ],
                  },
                });
                init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
              },
            }),
          );
        return original(input, init);
      };
    });
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/control'))
        return route.fulfill({
          json: { requestId: route.request().postDataJSON().requestId, status: 'accepted' },
        });
      if (path.startsWith('/api/')) return route.fulfill({ json: [] });
      const file = output.find((file) =>
        path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'),
      );
      if (file)
        return route.fulfill({
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          body: file.text,
        });
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
      });
    });
    await page.goto('https://mitzo-ui.test/');
    const parent = page.getByRole('textbox', { name: 'Message Mitzo' });
    await parent.fill('Keep parent draft');
    const launcher = page.getByRole('button', { name: 'Agents in this session' });
    await expect(launcher).toBeVisible();
    await launcher.click();
    await page.getByRole('button', { name: /Peirce.*Working/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Peirce' });
    const child = dialog.getByRole('textbox', { name: 'Message Peirce' });
    await child.fill('Keep child draft');
    await dialog.getByRole('button', { name: 'Full screen', exact: true }).click();
    await expect(dialog).toHaveAttribute('data-snap', 'full');
    await expect
      .poll(async () => (await dialog.boundingBox())?.width ?? 0)
      .toBeGreaterThan(page.viewportSize()!.width * 0.8);
    await dialog.getByRole('button', { name: 'Half screen', exact: true }).click();
    await expect(dialog).toHaveAttribute('data-snap', 'half');
    if (info.project.name.startsWith('mobile')) {
      const grip = dialog.locator('.snap-sheet-grip');
      await expect(grip).toBeVisible();
      await page.waitForFunction(
        () =>
          !document
            .querySelector('dialog')
            ?.getAnimations()
            .some((animation) => animation.playState === 'running'),
      );
      const box = await grip.boundingBox();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.down();
      await page.mouse.move(box!.x + box!.width / 2, 0, { steps: 12 });
      await page.mouse.up();
      await expect(dialog).toHaveAttribute('data-snap', 'full');
    }
    await page.screenshot({ path: info.outputPath(`native-agents-presence-${theme}.png`) });
    await dialog.getByRole('button', { name: 'Hide agent chat' }).click();
    await expect(parent).toHaveValue('Keep parent draft');
    await page.evaluate(() =>
      (window as unknown as { showFixturePermission(): void }).showFixturePermission(),
    );
    const approve = page.getByRole('button', { name: 'Allow Once', exact: true });
    await expect(approve).toBeVisible();
    const launchBox = await launcher.boundingBox();
    const approveBox = await approve.boundingBox();
    expect(launchBox!.y + launchBox!.height).toBeLessThanOrEqual(approveBox!.y);
    await approve.click();
    await expect(approve).not.toBeVisible();
    await launcher.click();
    await page.getByRole('button', { name: /Peirce.*Working/ }).click();
    await expect(child).toHaveValue('Keep child draft');
    await dialog.getByRole('button', { name: 'Send to Peirce' }).click();
    await expect(child).toHaveValue('');
    await expect(dialog.getByText('Message delivered.', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  });
