import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const bundled = build({
  entryPoints: [resolve('tests/fixtures/research-activity.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-research-activity.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});
for (const theme of ['dark', 'light'] as const)
  test(`research activity keeps reasoning quiet and restores focus (${theme})`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const compiled = await bundled;
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 844,
    });
    await page.emulateMedia({ reducedMotion: theme === 'dark' ? 'reduce' : 'no-preference' });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://mitzo-ui.test') return route.abort();
      if (url.pathname === '/fixture.js' || url.pathname === '/fixture.css') {
        const extension = url.pathname.endsWith('.js') ? '.js' : '.css';
        return route.fulfill({
          contentType: extension === '.js' ? 'application/javascript' : 'text/css',
          body: compiled.outputFiles!.find((f) => f.path.endsWith(extension))!.text,
        });
      }
      if (url.pathname !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
      });
    });
    await page.goto('/');
    const activity = page.getByRole('button', { name: /^Activity:/ });
    await expect(activity).toContainText('Website read');
    await expect(activity).not.toContainText('Further internal');
    await expect(activity).not.toContainText('**');
    await expect(page.getByText('Agents at work', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Thought/ }).first()).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(page.getByText(/Detailed speculative/)).toHaveCount(0);
    expect((await activity.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page
      .getByRole('button', { name: /^Thought/ })
      .first()
      .click();
    await expect(page.getByText(/Detailed speculative/)).toBeVisible();
    await page.getByRole('button', { name: /^Website read/ }).click();
    await expect(
      page.getByText('External source (untrusted): Selected GitHub records'),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath(`research-details-${theme}.png`) });
    await page.getByRole('button', { name: 'Complete research' }).click();
    await expect(activity).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText('The comparison is ready.')).toBeVisible();
    await activity.focus();
    await page.keyboard.press('Enter');
    await expect(activity).toHaveAttribute('aria-expanded', 'true');
    const read = page.getByRole('button', { name: /^Website read/ });
    await expect(read).toBeVisible();
    await read.focus();
    await page.keyboard.press('Shift+Tab');
    // Collapse through the disclosure itself; keyboard activation retains header focus.
    await activity.focus();
    await page.keyboard.press('Enter');
    await expect(activity).toBeFocused();
    await expect(page.locator('.agent-activity-details')).toBeHidden();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '125%';
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`research-activity-${theme}.png`) });
    expect(errors).toEqual([]);
  });
