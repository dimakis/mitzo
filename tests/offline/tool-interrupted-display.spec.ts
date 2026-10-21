import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/tool-interrupted-display.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/tool-interrupted-display.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
  },
});
for (const theme of ['dark', 'light'] as const)
  test(`interrupted tools remain neutral and disclose input before real late output (${theme})`, async ({
    page,
    isMobile,
    browserName,
  }, info) => {
    const files = (await bundle).outputFiles!;
    const errors: string[] = [],
      unexpected: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
    await page.emulateMedia({
      colorScheme: theme,
      reducedMotion: theme === 'dark' ? 'reduce' : 'no-preference',
    });
    await page.routeWebSocket('**/*', (socket) => {
      unexpected.push('WebSocket');
      socket.close();
    });
    await page.route('**/*', async (route) => {
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
      if (['/mitzo-wordmark.png', '/openshell-mark.svg', '/github-mark.svg'].includes(url.pathname))
        return route.fulfill({
          body: await readFile(resolve('frontend/public', url.pathname.slice(1))),
          contentType: url.pathname.endsWith('.png') ? 'image/png' : 'image/svg+xml',
        });
      if (url.pathname !== '/') {
        unexpected.push(url.href);
        return route.abort();
      }
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}" style="font-size:${theme === 'dark' ? 16 : 20}px"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      });
    });
    await page.goto('/');
    const command = page.getByRole('region', { name: 'Owned command', exact: true });
    const web = page.getByRole('region', { name: 'Owned web request', exact: true });
    const group = page.getByRole('region', { name: 'Mixed tool group', exact: true });
    const activity = page.getByRole('button', { name: /^Activity:/ });
    await expect(command.getByText('Running...', { exact: true })).toBeVisible();
    const key = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
    await page.keyboard.press(key);
    await expect(
      page.getByRole('button', { name: 'Show retained interruption', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(command.getByText('Interrupted', { exact: true })).toBeVisible();
    await expect(web.getByText('Interrupted', { exact: true })).toBeVisible();
    await expect(web.getByText(/Request in progress|Read complete|Failed/)).toHaveCount(0);
    await expect(
      group.getByRole('button', { name: /0\/2 complete · 1 running · 1 interrupted/ }),
    ).toBeVisible();
    await expect(activity).toContainText('Command interrupted · 1 interrupted');
    expect(await activity.getAttribute('aria-label')).not.toMatch(/Running|completed|failed/);
    const neutral = await command.locator('.tool-pill-dot--interrupted').evaluate((dot) => ({
      animation: getComputedStyle(dot).animationName,
      color: getComputedStyle(dot).backgroundColor,
      muted: getComputedStyle(dot.closest('.tool-pill-header')!).color,
    }));
    expect(neutral.animation).toBe('none');
    expect(neutral.color).toBe(neutral.muted);
    await page.screenshot({ path: info.outputPath('interrupted-consumers.png'), fullPage: true });
    await page.keyboard.press(key);
    await page.keyboard.press(key);
    const commandToggle = command.getByRole('button', { name: /Bash.*Interrupted/ });
    await expect(commandToggle).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(commandToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(command.locator('pre')).toHaveText('review the retained command');
    await expect(command.locator('pre')).toBeVisible();
    await expect(command.getByText('Result', { exact: true })).toHaveCount(0);
    await activity.focus();
    await page.keyboard.press('Enter');
    await expect(activity).toBeFocused();
    await expect(activity).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: 'Show late real reply', exact: true }).click();
    await expect(command.getByText('Interrupted', { exact: true })).toHaveCount(0);
    await expect(command.locator('.tool-pill--done')).toBeVisible();
    await expect(commandToggle).toHaveCount(0);
    await expect(command.getByRole('button', { name: /Bash/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(command.getByText('Late real output', { exact: true })).toBeVisible();
    await expect(web.getByText('Read complete', { exact: true })).toBeVisible();
    await expect(group.getByRole('button', { name: /1\/2 complete · 1 running/ })).toBeVisible();
    await expect(activity).toContainText('Command completed');
    expect(await activity.getAttribute('aria-label')).not.toContain('Running');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      isMobile ? 320 : 1280,
    );
    await page.screenshot({ path: info.outputPath('late-real-output.png'), fullPage: true });
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
  });
