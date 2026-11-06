import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const bundle = build({
  entryPoints: [resolve('tests/fixtures/sandboxes.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/sandbox-removal.js',
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
  test(`sandbox removal reviews release, failure and archive (${theme})`, async ({
    page,
  }, info) => {
    const mobile = info.project.name.startsWith('mobile');
    await page.setViewportSize({ width: mobile ? 320 : 1280, height: mobile ? 740 : 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.addInitScript(
      ({ theme }) => {
        localStorage.setItem('mitzo-theme', theme);
        localStorage.setItem('mitzo-accent', theme === 'light' ? 'teal' : 'mint');
        localStorage.setItem('mitzo-font', theme === 'light' ? 'georgia' : 'system');
      },
      { theme },
    );
    const compiled = await bundle;
    const writes: Array<{ url: string; body: unknown }> = [];
    let prepared = false;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://mitzo-ui.test') return route.abort();
      if (url.pathname.endsWith('/deletion-preview'))
        return route.fulfill({
          json: {
            sandbox: {
              action: prepared ? 'stop_and_delete' : 'none',
              token: 'reviewed-token',
              blockers: prepared ? [] : ['active_session'],
            },
            needsPreparation: !prepared,
            removal: prepared
              ? { operationId: 'original-removal', phase: 'closing', canKeep: true }
              : null,
          },
        });
      if (url.pathname.endsWith('/prepare-deletion')) {
        writes.push({ url: url.pathname, body: route.request().postDataJSON() });
        prepared = true;
        return route.fulfill({
          json: {
            sandbox: { action: 'stop_and_delete', token: 'reviewed-token', blockers: [] },
            needsPreparation: false,
            removal: { operationId: 'original-removal', phase: 'closing', canKeep: true },
          },
        });
      }
      if (route.request().method() === 'DELETE') {
        writes.push({ url: url.pathname + url.search, body: route.request().postDataJSON() });
        return route.fulfill({
          status: url.search ? 200 : 409,
          json: url.search ? { ok: true } : { error: 'Checkpoint unavailable' },
        });
      }
      if (url.pathname === '/fixture.js' || url.pathname === '/fixture.css')
        return route.fulfill({
          contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css',
          body: compiled.outputFiles!.find((f) =>
            f.path.endsWith(url.pathname.endsWith('.js') ? '.js' : '.css'),
          )!.text,
        });
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
      if (/\.(png|svg)$/.test(url.pathname)) return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'light' ? 'teal' : 'mint'}" data-font="${theme === 'light' ? 'georgia' : 'system'}"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><link rel="stylesheet" href="/fixture.css"><script type="module" src="/fixture.js"></script></html>`,
      });
    });
    await page.goto('/remove');
    await expect(page.locator('html')).toHaveAttribute(
      'data-accent',
      theme === 'light' ? 'teal' : 'mint',
    );
    await expect(page.locator('html')).toHaveAttribute(
      'data-font',
      theme === 'light' ? 'georgia' : 'system',
    );
    await page.getByRole('button', { name: 'Review chat removal' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete chat?' });
    const prepare = dialog.getByRole('button', { name: 'Stop and review deletion' });
    await expect(prepare).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Delete chat and sandbox' })).toBeDisabled();
    expect(writes).toHaveLength(0);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const archive = dialog.getByRole('button', { name: 'Archive chat', exact: true });
    await archive.focus();
    await expect(archive).toBeFocused();
    await page.screenshot({ path: info.outputPath(`sandbox-removal-${theme}.png`) });
    await prepare.click();
    await expect(dialog.getByRole('button', { name: 'Delete chat and sandbox' })).toBeEnabled();
    expect(writes).toHaveLength(1);
    expect(writes[0].url).toContain('/prepare-deletion');
    await expect(dialog.getByRole('button', { name: 'Keep chat' })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`sandbox-removal-prepared-${theme}.png`) });
    await dialog.getByRole('button', { name: 'Delete chat and sandbox' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    expect(writes[1].body).toEqual({
      cleanupToken: 'reviewed-token',
      removalOperationId: 'original-removal',
    });
    await archive.click();
    await expect(dialog).not.toBeVisible();
    expect(writes[2].url).toContain('?archive=1');
    await expect(page.getByRole('button', { name: 'Review chat removal' })).toBeFocused();
    expect(errors).toEqual([]);
  });
