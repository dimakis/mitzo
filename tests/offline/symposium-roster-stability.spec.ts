import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const bundle = build({
  entryPoints: [resolve('tests/fixtures/symposium-roster-surface.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-roster.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.svg', '/*.png'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});
for (const theme of ['dark', 'light'])
  test(`stable Agents roster and status strip (${theme})`, async ({ page, isMobile }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const files = (await bundle).outputFiles!;
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'mitzo-ui.test' || route.request().method() !== 'GET')
        return route.abort();
      const file = files.find(
        (file) => url.pathname === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (url.pathname !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>main{padding:var(--space-3);max-width:100%}textarea{width:100%}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const width of isMobile ? [320, 390] : [1280, 400]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/');
      const rail = page.getByRole('region', { name: 'Conversation status' });
      const opener = rail.getByRole('button', { name: /^Open Agents,/ });
      const initial = (await rail.boundingBox())!;
      await expect(opener).toBeVisible();
      const count = rail.locator('.composer-status-agent-count');
      if (width <= 480) await expect(count).toBeVisible();
      else await expect(count).toBeHidden();
      await page.getByRole('button', { name: 'Stream status', exact: true }).click();
      expect((await rail.boundingBox())!.height).toBe(initial.height);
      await opener.click();
      const details = page.getByRole('button', { name: 'Details for Reviewer' });
      await details.focus();
      const row = details.locator('xpath=ancestor::article');
      const before = (await row.boundingBox())!;
      // The simulation button is outside the native modal: dispatch its fixture
      // event without moving focus, like an incoming activity broadcast.
      await page
        .getByRole('button', { name: 'Stream status', exact: true })
        .evaluate((node) => (node as HTMLButtonElement).click());
      await expect(details).toBeFocused();
      expect((await row.boundingBox())!.y).toBe(before.y);
      expect((await row.boundingBox())!.height).toBe(before.height);
      await details.click();
      await expect(page.getByRole('dialog').getByText('Default Mitzo · revision 1')).toBeVisible();
      await expect(page.getByRole('dialog').getByText('agent', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Back to Agents' }).click();
      await expect(details).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(opener).toBeFocused();
      await rail.getByRole('button', { name: 'To Architect, Reviewer' }).click();
      await expect(page.getByRole('group', { name: 'Reply recipients' })).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('button', { name: 'Fail roster read' }).click();
      await opener.click();
      await expect(page.getByRole('alert')).toContainText('Roster refresh failed');
      await page.getByRole('button', { name: 'Refresh agent status' }).click();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Add agent' })).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`agents-${width}-${theme}.png`),
        fullPage: true,
      });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveValue('Preserve this draft');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      for (const control of [opener, rail.getByRole('button', { name: 'To Architect, Reviewer' })])
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({
        path: info.outputPath(`status-${width}-${theme}.png`),
        fullPage: true,
      });
    }
    expect(errors).toEqual([]);
  });
