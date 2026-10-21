import { expect, test, type Locator } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const report =
  '{"kind":"worker-working-file","path":"/private/var/folders/y6/3pqs6vkj5wv1qkm5v1cq2n0r0000gn/T/mitzo-ordinary-native-5Ei8um/tasks/ordinary-b59f0cb9-245b-45bd-b766-c2010a341476/recording-review-report.md","sha256":"c441b505b586215cea00efb1ba5904d02229283d3c954ad65874a8077c7df287","sessionId":"05d53de8-4f5f-887f-9af4-46fceec8816d","taskId":"26c80140-7947-4a9b-beef-0bea07c755d1"}';
const title = 'Record one acoustic sample';
const summary =
  'Synthetic recording report submitted with attributed working-file evidence; task review remains explicit and the outcome is unverified.';
const taskId = '26c80140-7947-4a9b-beef-0bea07c755d1';
const sessionId = '05d53de8-4f5f-887f-9af4-46fceec8816d';
const bundle = build({
  entryPoints: [resolve('tests/fixtures/task-node-readability.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-task-node-readability.js',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
});
interface Profile {
  width: number;
  coarse: boolean;
  theme: string;
  enlarged: boolean;
  viewport?: number;
}
const profiles: Profile[] = [320, 390].flatMap((width) =>
  [false, true].flatMap((coarse) =>
    ['dark', 'light'].map((theme) => ({ width, coarse, theme, enlarged: false })),
  ),
);
profiles.push(
  { width: 390, coarse: false, theme: 'light', enlarged: false, viewport: 1280 },
  { width: 320, coarse: false, theme: 'dark', enlarged: true },
  { width: 390, coarse: true, theme: 'light', enlarged: true },
);

for (const profile of profiles)
  test.describe(`${profile.width} ${profile.coarse ? 'coarse' : 'fine'} ${profile.theme} ${profile.enlarged ? 'large' : 'normal'}${profile.viewport ? ' contained-pane' : ''}`, () => {
    test.use({
      viewport: { width: profile.viewport ?? profile.width, height: 844 },
      hasTouch: profile.coarse,
      isMobile: false,
      deviceScaleFactor: 1,
    });
    test('keeps exact review evidence readable and task controls usable', async ({
      page,
      browserName,
    }, info) => {
      const files = (await bundle).outputFiles!;
      const errors: string[] = [],
        unexpected: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        const asset = files.find(
          (file) => url.pathname === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
        );
        if (asset)
          return route.fulfill({
            body: asset.text,
            contentType: asset.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          });
        if (url.pathname !== '/') {
          unexpected.push(url.href);
          return route.abort();
        }
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html data-theme="${profile.theme}" data-accent="${profile.theme === 'dark' ? 'mint' : 'teal'}" data-font="${profile.theme === 'dark' ? 'system' : 'georgia'}" style="font-size:${profile.enlarged ? 20 : 16}px"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:100%;margin:0}#root{position:relative;max-width:${profile.width}px;margin-inline:auto}#root>.task-board-page{position:absolute}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
        });
      });
      await page.goto('/');
      const root = page.locator(`#task-${taskId}`);
      const row = root.locator(':scope > .task-node-row');
      const value = root.locator(':scope > .task-node-artifacts .task-node-artifact-value');
      await expect(root.getByText(title, { exact: true })).toBeVisible();
      expect(
        (await root.boundingBox())!.width,
        'actual available row width matches the intended pane',
      ).toBeLessThanOrEqual(profile.width);
      await expect(value).toHaveText(report);
      expect(
        await value.evaluate((node) => new TextEncoder().encode(node.textContent!).length),
      ).toBe(379);
      const digest = createHash('sha256')
        .update((await value.textContent())!)
        .digest('hex');
      expect(digest).toBe('66a8c36e0db2f7901adc14f830c4add731999b51d9b0d54c012727fbe0cc61f7');
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(
        profile.coarse,
      );

      async function readable(stage: string) {
        await expect(root.getByText(summary, { exact: true })).toBeVisible();
        const geometry = await root.evaluate((node) => {
          const text = Array.from(
            node.querySelectorAll('.task-node-title,.task-node-summary,.task-node-artifact-value'),
          ).map((element) => {
            const parent = element.closest('.task-node-artifact') ?? element;
            const bounds = parent.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(element);
            const outside = Array.from(range.getClientRects()).filter(
              (r) => r.left < bounds.left - 1 || r.right > bounds.right + 1,
            );
            return {
              className: element.className,
              text: element.textContent,
              outside: outside.map((r) => ({ left: r.left, right: r.right })),
              bounds: { left: bounds.left, right: bounds.right },
            };
          });
          const widths = [
            node,
            ...Array.from(node.querySelectorAll('.task-node-artifacts,.task-node-artifact')),
          ].map((element) => ({
            className: element.className,
            client: element.clientWidth,
            scroll: element.scrollWidth,
            overflowX: getComputedStyle(element).overflowX,
          }));
          const buttons = Array.from(node.querySelectorAll('button')).map((button) => {
            const r = button.getBoundingClientRect(),
              bounds = button.closest('.task-node-row')!.getBoundingClientRect();
            const actions = button.closest('.task-node-actions');
            return {
              name: button.getAttribute('aria-label') ?? button.title,
              width: r.width,
              height: r.height,
              inRow: r.left >= bounds.left - 1 && r.right <= bounds.right + 1,
              opacity: actions ? Number(getComputedStyle(actions).opacity) : 1,
            };
          });
          const scroller = node.closest('.task-board-scroll')!;
          return {
            text,
            widths,
            buttons,
            pageWidth: document.documentElement.scrollWidth,
            viewport: innerWidth,
            scrollWidth: scroller.scrollWidth,
            clientWidth: scroller.clientWidth,
          };
        });
        await info.attach(`${stage}-geometry`, {
          body: JSON.stringify(geometry, null, 2),
          contentType: 'application/json',
        });
        expect
          .soft(
            geometry.text.filter((value) => value.outside.length),
            `${stage}: full rendered text remains inside its reading column`,
          )
          .toEqual([]);
        expect
          .soft(
            geometry.widths.filter(
              (value) =>
                value.scroll > value.client + 1 || ['hidden', 'clip'].includes(value.overflowX),
            ),
            `${stage}: wrap evidence without hiding overflow`,
          )
          .toEqual([]);
        expect
          .soft(
            geometry.buttons.filter(
              (value) =>
                !value.inRow || value.width < 44 || value.height < 44 || value.opacity < 0.99,
            ),
            `${stage}: visible in-bounds 44px controls`,
          )
          .toEqual([]);
        expect.soft(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport + 1);
        expect.soft(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
      }
      await readable('pending');
      await root.screenshot({ path: info.outputPath('task-node-pending.png') });
      await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
      await expect(row.getByRole('button', { name: 'Collapse', exact: true })).toBeFocused();
      await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
      await expect(
        row.getByRole('button', { name: 'Status: pending_review', exact: true }),
      ).toBeFocused();
      await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
      await expect(row.getByRole('link', { name: 'worker-chat', exact: true })).toBeFocused();
      await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
      await expect(row.getByRole('button', { name: 'Approve', exact: true })).toBeFocused();
      const collapse = row.getByRole('button', { name: 'Collapse', exact: true });
      await collapse.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('#task-review-child')).toHaveCount(0);
      await expect(row.getByRole('button', { name: 'Expand', exact: true })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.locator('#task-review-child')).toBeVisible();
      await row.getByRole('button', { name: 'Add sub-task', exact: true }).click();
      const added = page.locator('#task-added-child');
      await expect(added).toBeVisible();
      await added.getByRole('button', { name: 'Delete task', exact: true }).click();
      await expect(added).toHaveCount(0);
      const child = page.locator('#task-review-child');
      await child.getByRole('button', { name: 'Status: pending', exact: true }).click();
      await expect(
        child.getByRole('button', { name: 'Status: active', exact: true }),
      ).toBeVisible();
      const link = row.getByRole('link', { name: 'worker-chat', exact: true });
      const linkRect = await link.boundingBox();
      expect(linkRect!.width).toBeGreaterThanOrEqual(44);
      expect(linkRect!.height).toBeGreaterThanOrEqual(44);
      const rowRect = await row.boundingBox();
      expect(linkRect!.x).toBeGreaterThanOrEqual(rowRect!.x - 1);
      expect(linkRect!.x + linkRect!.width).toBeLessThanOrEqual(rowRect!.x + rowRect!.width + 1);
      await link.focus();
      await expect(link).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('location')).toHaveText(`/chat/${sessionId}`);
      const reject = row.getByRole('button', { name: 'Reject', exact: true });
      await reject.focus();
      await expect(reject).toBeFocused();
      await page.keyboard.press('Space');
      expect(await events(page.getByTestId('actions'))).toContainEqual({
        action: 'reject',
        id: taskId,
        value: '',
      });
      const approve = row.getByRole('button', { name: 'Approve', exact: true });
      await approve.focus();
      await expect(approve).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(row.getByRole('button', { name: 'Status: done', exact: true })).toBeVisible();
      await expect(value).toHaveText(report);
      await readable('done');
      await root.screenshot({ path: info.outputPath('task-node-done.png') });
      await row.getByRole('button', { name: 'Delete task', exact: true }).click();
      await expect(root).toHaveCount(0);
      const recorded = await events(page.getByTestId('actions'));
      expect(recorded).toContainEqual({ action: 'add', id: taskId });
      expect(recorded).toContainEqual({ action: 'delete', id: 'added-child' });
      expect(recorded).toContainEqual({ action: 'approve', id: taskId });
      expect(recorded.at(-1)).toEqual({ action: 'delete', id: taskId });
      expect(errors).toEqual([]);
      expect(unexpected).toEqual([]);
    });
  });
async function events(output: Locator): Promise<unknown[]> {
  return JSON.parse((await output.textContent())!);
}
