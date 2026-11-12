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
  outfile: '/tmp/mitzo-subagent-visibility.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});
const child: NativeSubagentSnapshot = {
  commandId: 'command',
  threadId: 'child',
  parentThreadId: 'parent',
  name: 'Subagent',
  task: 'Review edge cases',
  model: '',
  available: false,
  state: 'unknown',
  revision: 2,
  blocks: [],
  inspectionFailure: {
    code: 'native_subagent_inspection_failed',
    stage: 'subscribe',
    reference: 'f12edc36-639e-4a9c-8711-04ab177a0ada',
  },
};
for (const theme of ['dark', 'light'])
  test(`subagent inspection failure stays visible (${theme})`, async ({ page }, info) => {
    const output = (await bundle).outputFiles!;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((agent) => {
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        if (!String(input).endsWith('/codex-subagents/events')) return original(input, init);
        const encode = (value: unknown) =>
          new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encode({ type: 'reset', available: true }));
              controller.enqueue(encode({ type: 'agent', agent }));
              init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
            },
          }),
        );
      };
    }, child);
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/codex-subagents/inspect'))
        return route.fulfill({
          json: {
            agent: {
              ...child,
              available: true,
              state: 'completed',
              model: 'fixture',
              revision: 3,
              inspectionFailure: undefined,
            },
          },
        });
      if (path.startsWith('/api/')) return route.fulfill({ json: [] });
      const file = output.find((entry) =>
        path.endsWith(entry.path.endsWith('.css') ? '.css' : '.js'),
      );
      if (file)
        return route.fulfill({
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          body: file.text,
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 844,
    });
    // Chromium exposes cutout/home-indicator geometry even on an offline page.
    // WebKit still checks native modal bounds; physical iOS remains a separate check.
    const safeTop = info.project.name === 'mobile-chromium' ? 47 : 0;
    const safeBottom = info.project.name === 'mobile-chromium' ? 34 : 0;
    if (safeTop) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setSafeAreaInsetsOverride', {
        insets: { top: safeTop, bottom: safeBottom, left: 0, right: 0 },
      });
    }
    await page.goto('https://mitzo-ui.test/');
    const draft = page.getByRole('textbox', { name: 'Message Mitzo' });
    await draft.fill('Keep my parent draft');
    await page.getByRole('button', { name: /1 subagent.*1 unavailable/ }).click();
    const row = page.getByRole('button', { name: /Subagent.*Inspection unavailable/ });
    await row.click();
    const dialog = page.getByRole('dialog', { name: 'Subagent' });
    await expect(dialog.getByText('Activity unavailable')).toBeVisible();
    await expect(dialog.getByText('No output is available yet.')).toBeVisible();
    const details = dialog.locator('details');
    await expect(details).not.toHaveAttribute('open');
    await details.locator('summary').click();
    await expect(dialog.getByText(/inspection failed during activity subscription/)).toBeVisible();
    await expect(
      dialog.getByText(child.inspectionFailure!.reference, { exact: false }),
    ).toBeVisible();
    await details.locator('summary').click();
    const back = await dialog.getByRole('button', { name: 'Back to conversation' }).boundingBox();
    expect(back!.y).toBeGreaterThanOrEqual(safeTop);
    const send = await dialog.getByRole('button', { name: 'Send to Subagent' }).boundingBox();
    expect(send!.y + send!.height).toBeLessThanOrEqual(844 - safeBottom);
    if (!info.project.name.startsWith('mobile')) {
      const bounds = await dialog.boundingBox();
      expect(bounds!.y + bounds!.height - send!.y - send!.height).toBeLessThan(64);
    }
    const retry = await dialog.getByRole('button', { name: 'Retry inspection' }).boundingBox();
    const input = dialog.getByRole('textbox', { name: 'Message Subagent' });
    await expect(input).toHaveAttribute('rows', '1');
    const inputBounds = await input.boundingBox();
    // No full-screen empty transcript between the recovery action and composer.
    expect(inputBounds!.y - retry!.y - retry!.height).toBeLessThan(220);
    await expect(dialog.getByRole('button', { name: 'Send to Subagent' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Stop Subagent' })).toBeDisabled();
    await page.evaluate(() =>
      (window as unknown as { completeFixtureParent(): void }).completeFixtureParent(),
    );
    await expect(dialog).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`native-subagents-inspection-failure-${theme}.png`),
    });
    await dialog.getByRole('button', { name: 'Retry inspection' }).click();
    await expect(dialog.getByText('Result returned')).toBeVisible();
    await expect(dialog.getByText(/Subagent inspection failed/)).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath(`native-subagents-inspection-recovered-${theme}.png`),
    });
    for (const button of await dialog.getByRole('button').all()) {
      const bounds = await button.boundingBox();
      if (bounds) expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await dialog.getByRole('button', { name: 'Back to conversation' }).click();
    await expect(draft).toHaveValue('Keep my parent draft');
    await expect(page.getByRole('button', { name: /Subagent.*Result returned/ })).toBeFocused();
    expect(errors).toEqual([]);
  });
