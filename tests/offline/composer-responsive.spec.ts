import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/composer-responsive.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  write: false,
  outfile: '/tmp/composer-responsive.js',
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

async function reachable(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  await expect(button).toBeVisible();
  const box = (await button.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(
    await button.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }),
  ).toBe(true);
}

async function serve(page: Page, theme: string) {
  const files = (await bundle).outputFiles!;
  await page.route('**/*', (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = files.find(
      (f) => path === (f.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
    );
    if (file)
      return route.fulfill({
        body: file.text,
        contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
      });
    if (path.startsWith('/api/')) return route.fulfill({ json: [] });
    if (path !== '/') return route.abort();
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html data-theme="${theme}" data-accent="teal" data-font="georgia"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{margin:0;height:100%;overflow:hidden}.chat-page{height:100%;min-height:0}.chat-messages{flex:1;min-height:0;overflow:auto}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
    });
  });
}

test('responsive composer overflow spans the toolbar and stays on screen', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await serve(page, 'dark');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const panel = page.locator('.composer-tools[data-expanded="true"]');
  const more = page.getByRole('button', { name: 'More composer actions' });
  // Ordinary chats have no recipient row; the overflow must not shrink to the More strip.
  for (const query of ['/?ordinary=1', '/']) {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(query);
    await more.click();
    await expect(panel).toBeVisible();
    const toolbar = (await page.locator('.composer-toolbar').boundingBox())!;
    const box = (await panel.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(Math.min(toolbar.width, 24 * 16) - 1);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await reachable(page, 'Attach images or PDF');
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  }
  // With recipients on their own row, available height starts at the toolbar,
  // not at the More button, so the first overflow control stays reachable.
  await page.setViewportSize({ width: 320, height: 360 });
  await page.addStyleTag({ content: 'html{font-size:150%}' });
  await expect(page.getByLabel('Selected recipients')).toBeAttached();
  await more.click();
  await expect(panel).toBeVisible();
  expect((await panel.boundingBox())!.y).toBeGreaterThanOrEqual(0);
  await panel.evaluate((el) => (el.scrollTop = 0));
  await reachable(page, 'Commands');
  expect(errors).toEqual([]);
});

for (const sourceStop of [false, true])
  for (const theme of ['dark', 'light'])
    test(`responsive composer: narrow, large text and short viewport (${theme}, source Stop ${sourceStop})`, async ({
      page,
    }, info) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await serve(page, theme);
      await page.setViewportSize({ width: 320, height: 640 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(sourceStop ? '/?sourceStop=1' : '/');
      const input = page.getByRole('textbox', { name: 'Message Mitzo' });
      await expect(input).toHaveValue('Keep this unsent draft');
      await input.evaluate((el) => el.setAttribute('data-original', 'yes'));
      for (const width of [280, 320, 359, 390, 1280]) {
        await page.setViewportSize({ width, height: 640 });
        await reachable(page, 'Send message');
        if (sourceStop) await reachable(page, 'Stop original agent');
      }
      await page.getByRole('button', { name: 'Toggle running' }).click();
      for (const width of [280, 320, 359, 390, 800, 1280]) {
        await page.setViewportSize({ width, height: 640 });
        for (const name of ['Steer selected agents', 'Queue message', 'Stop selected agents'])
          await reachable(page, name);
        if (sourceStop) await reachable(page, 'Stop original agent');
        const primary = await page
          .locator('.composer-actions > button')
          .evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().y));
        expect(new Set(primary).size).toBe(1);
        expect(
          await page
            .locator('.composer-toolbar')
            .evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
      }
      await page.setViewportSize({ width: 320, height: 360 });
      await page.addStyleTag({
        content: 'html{font-size:200%}.chat-input-field{font-size:2rem!important}',
      });
      await input.fill('A long draft\n'.repeat(20));
      await reachable(page, 'Stop selected agents');
      await reachable(page, 'Queue message');
      await page.getByRole('button', { name: 'More composer actions' }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Expand input' }).focus();
      await page.keyboard.press('Enter');
      await reachable(page, 'Stop selected agents');
      const more = page.getByRole('button', { name: 'More composer actions' });
      await more.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Commands', exact: true }).focus();
      await page.keyboard.press('Escape');
      await expect(more).toBeFocused();
      await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeHidden();
      await page.getByRole('button', { name: 'Choose who replies' }).click();
      const recipient = page.getByRole('button', {
        name: 'Agent 7 with a very long recipient name that must remain readable',
        exact: true,
      });
      await recipient.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByLabel('Selected recipients')).toHaveText('agent-0,agent-1,agent-7');
      await reachable(page, 'Stop selected agents');
      await page.getByRole('button', { name: 'Choose who replies' }).click();
      await expect(input).toHaveAttribute('data-original', 'yes');
      await expect(input).toHaveValue('A long draft\n'.repeat(20));
      await page.getByRole('button', { name: 'Stop selected agents' }).click();
      await expect(page.getByLabel('Stop count')).toHaveText('1');
      await page.screenshot({ path: info.outputPath('composer-short-large-text.png') });
      expect(errors).toEqual([]);
    });
