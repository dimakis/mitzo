import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';

// Approved Symposium composer (Dimitri, 2026-11-25): on narrow widths every
// control stays a direct icon (nothing moves into More) and the controls wrap
// onto two icon rows. Ledger: symposium-shared-composer / two-row-narrow-composer-2026-11-25.

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

type Box = { name: string; x: number; y: number; width: number; height: number };

/** Every expected control is a direct, unobstructed, touch-sized icon on screen. */
async function directControls(page: Page, names: string[]): Promise<Box[]> {
  const viewport = page.viewportSize()!;
  const boxes: Box[] = [];
  for (const name of names) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button, name).toBeVisible();
    expect(await button.evaluate((el) => !el.closest('.composer-tools')), name).toBe(true);
    const box = (await button.boundingBox())!;
    expect(box.width, name).toBeGreaterThanOrEqual(44);
    expect(box.height, name).toBeGreaterThanOrEqual(44);
    expect(box.x, name).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, name).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height, name).toBeLessThanOrEqual(viewport.height);
    expect(
      await button.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }),
      name,
    ).toBe(true);
    boxes.push({ name, ...box });
  }
  for (const [index, a] of boxes.entries())
    for (const b of boxes.slice(index + 1))
      expect(
        a.x + a.width <= b.x + 0.5 ||
          b.x + b.width <= a.x + 0.5 ||
          a.y + a.height <= b.y + 0.5 ||
          b.y + b.height <= a.y + 0.5,
        `${a.name} overlaps ${b.name}`,
      ).toBe(true);
  return boxes;
}

const rows = (boxes: Box[]) =>
  boxes
    .map((box) => box.y + box.height / 2)
    .sort((a, b) => a - b)
    .filter((y, index, ys) => index === 0 || y - ys[index - 1] > 8).length;

const same = (before: Box[], after: Box[]) => {
  for (const box of before) {
    const next = after.find((candidate) => candidate.name === box.name)!;
    expect(Math.abs(next.x - box.x), box.name).toBeLessThanOrEqual(1);
    expect(Math.abs(next.y - box.y), box.name).toBeLessThanOrEqual(1);
  }
};

for (const sourceStop of [false, true])
  for (const theme of ['dark', 'light'])
    test(`Symposium composer keeps every control direct on two rows (${theme}, source Stop ${sourceStop})`, async ({
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
      const secondary = [
        'Choose who replies',
        'More composer actions',
        'Open session tray',
        'Agents',
        'Token usage',
        'Record voice message',
        ...(sourceStop ? ['Stop original agent'] : []),
      ];
      const idle = [...secondary, 'Send message'];
      const running = [
        ...secondary,
        'Steer selected agents',
        'Queue message',
        'Stop selected agents',
      ];
      for (const width of [280, 320, 390, 768]) {
        await page.setViewportSize({ width, height: 640 });
        const idleBoxes = await directControls(page, idle);
        if (width <= 390) expect(rows(idleBoxes)).toBe(2);
        // Typing does not move any control.
        await input.fill(`Draft at ${width}px`);
        same(idleBoxes, await directControls(page, idle));
        // Sending (refused by the fixture, so the draft stays) does not move controls.
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        same(idleBoxes, await directControls(page, idle));
        await page.getByRole('button', { name: 'Toggle running' }).click();
        const runningBoxes = await directControls(page, running);
        if (width <= 390) expect(rows(runningBoxes)).toBe(2);
        const primary = runningBoxes.filter((box) =>
          ['Steer selected agents', 'Queue message', 'Stop selected agents'].includes(box.name),
        );
        expect(new Set(primary.map((box) => Math.round(box.y))).size).toBe(1);
        // Queueing keeps the running layout stable.
        await page.getByRole('button', { name: 'Queue message', exact: true }).click();
        same(runningBoxes, await directControls(page, running));
        expect(
          await page
            .locator('.composer-toolbar')
            .evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await page.getByRole('button', { name: 'Toggle running' }).click();
      }
      // Short viewport with large text: recipients expand on their own bounded row.
      await page.setViewportSize({ width: 320, height: 360 });
      await page.addStyleTag({ content: 'html{font-size:150%}' });
      await input.fill('A long draft\n'.repeat(20));
      await directControls(page, idle);
      await page.getByRole('button', { name: 'Choose who replies' }).click();
      const recipient = page.getByRole('button', {
        name: 'Agent 7 with a very long recipient name that must remain readable',
        exact: true,
      });
      await recipient.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByLabel('Selected recipients')).toHaveText('agent-0,agent-1,agent-7');
      await directControls(page, idle);
      await expect(input).toHaveValue('A long draft\n'.repeat(20));
      await page.screenshot({ path: info.outputPath('symposium-composer-two-rows.png') });
      expect(errors).toEqual([]);
    });

test('ordinary composer keeps its approved single row with direct usage and voice', async ({
  page,
}) => {
  await serve(page, 'dark');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 640 });
    await page.goto('/?ordinary=1');
    const boxes = await directControls(page, [
      'More composer actions',
      'Open session tray',
      'Agents',
      'Token usage',
      'Record voice message',
      'Send message',
    ]);
    expect(rows(boxes)).toBe(1);
  }
});
