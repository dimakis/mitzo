import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/telos-category-exit.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/telos-category-exit.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
  },
});

for (const theme of ['dark', 'light']) {
  test(`category exit has no final layout jump and preserves an in-flight title click (${theme})`, async ({
    page,
  }, info) => {
    const files = (await bundle).outputFiles!;
    const errors: string[] = [],
      unexpected: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({
      reducedMotion: 'no-preference',
      colorScheme: theme as 'dark' | 'light',
    });
    await page.routeWebSocket('**/*', (socket) => {
      unexpected.push('WebSocket');
      socket.close();
    });
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://mitzo-ui.test') {
        unexpected.push(url.href);
        return route.abort();
      }
      const asset = files.find(
        (file) => url.pathname === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (asset)
        return route.fulfill({
          body: asset.text,
          contentType: asset.path.endsWith('.css') ? 'text/css' : 'application/javascript',
        });
      if (url.pathname === '/api/telos/work/items/category-exit-item')
        return route.fulfill({
          status: 503,
          json: { error: 'Offline conversation inventory unavailable' },
        });
      if (url.pathname !== '/todos') {
        unexpected.push(url.href);
        return route.abort();
      }
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      });
    });
    // Hold the real exit at its last subpixel frame. Finishing it between native
    // pointer down/up reproduces the recorded CI interaction deterministically.
    await page.addInitScript(() => {
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (frames, options) {
        const animation = animate.call(this, frames, options);
        if (
          this.getAttribute('aria-label') === 'Discover categories' &&
          Array.isArray(frames) &&
          frames.at(-1)?.height === '0px'
        ) {
          animation.pause();
          animation.currentTime = Number(animation.effect!.getTiming().duration) - 0.001;
        }
        return animation;
      };
    });
    await page.goto('/todos');
    await expect(page.getByText('Conversations unavailable', { exact: true })).toBeVisible();
    const trigger = page.getByRole('button', { name: 'Browse categories', exact: true });
    const title = page.getByRole('button', { name: 'Open the reviewed outcome', exact: true });
    await trigger.click();
    const discovery = page.getByLabel('Discover categories');
    await expect(discovery.getByRole('button', { name: 'Job', exact: true })).toBeVisible();
    await discovery.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => {
          animation.finish();
          return animation.finished;
        }),
      );
    });
    await page.screenshot({ path: info.outputPath('category-open.png'), fullPage: true });
    await discovery.getByRole('button', { name: 'Job', exact: true }).click();
    await expect(trigger).toBeFocused();
    await expect(discovery).toHaveAttribute('inert', '');
    await expect(discovery).toHaveAttribute('aria-hidden', 'true');
    const before = (await title.boundingBox())!;
    await title.hover();
    await page.mouse.down();
    await discovery.evaluate((element) => {
      const animations = element.getAnimations();
      if (animations.length !== 1) throw Error('Expected one retained category exit');
      animations[0].finish();
    });
    await expect(discovery).toHaveCount(0);
    const after = (await title.boundingBox())!;
    await page.mouse.up();
    await info.attach('final-exit-geometry', {
      body: JSON.stringify({ before, after, jump: after.y - before.y }),
      contentType: 'application/json',
    });
    expect
      .soft(
        Math.abs(after.y - before.y),
        'Unmount must not shift the real title after the exit reaches zero',
      )
      .toBeLessThanOrEqual(1);
    await expect(page).toHaveURL(/\/todos\/category-exit-item$/);
    await expect(
      page.getByRole('heading', { name: 'Reviewed outcome opened', exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
  });
}
