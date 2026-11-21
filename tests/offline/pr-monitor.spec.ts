import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { monitorFixture } from '../../frontend/src/test-utils/pr-monitor-fixture';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/pr-monitor.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/pr-monitor-fixture.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});

for (const theme of ['dark', 'light']) {
  test(`PR monitor: responsive evidence, consent and reconnect (${theme})`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    const writes: { path: string; body: Record<string, unknown> }[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 850,
    });
    const files = (await bundle).outputFiles!;
    const p = monitorFixture();
    p.snapshot!.title =
      'A long pull request title that remains readable when the conversation is opened on a narrow phone';
    p.subscription.watch = { id: p.subscription.id, revision: 1, expiresAt: Date.now() + 3600000 };
    p.subscription.lifecycle = 'watching';
    let failed = false;
    let executionAvailable = true;
    await page.route('**/*', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/api/')) {
        if (route.request().method() === 'POST') {
          writes.push({ path, body: route.request().postDataJSON() });
          if (path.endsWith('/reauthorize'))
            return route.fulfill({
              json: { csrf: 'offline-proof', expiresAt: Date.now() + 60000 },
            });
          if (path.endsWith('/revoke')) {
            p.subscription.watch = null;
            p.subscription.lifecycle = 'paused';
          }
          return route.fulfill({ json: {} });
        }
        return route.fulfill({
          status: failed ? 503 : 200,
          json: { executionAvailable, executionDigest: 'd'.repeat(64), subscriptions: [p] },
        });
      }
      if (path === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
        });
      const file = files.find((f) => path.endsWith(f.path.endsWith('.css') ? '.css' : '.js'));
      return file
        ? route.fulfill({
            contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
            body: file.text,
          })
        : route.abort();
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Session details' }).click();
    const dialog = page.getByRole('dialog', { name: 'Session details' });
    await expect(dialog.getByRole('link', { name: 'owner/repo #7' })).toBeVisible();
    await expect(dialog.getByText('CI: failed', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Auto-fix', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Merge when ready' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Review Watch renewal' }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('button', { name: 'Allow read-only Watch' })).toBeDisabled();
    await dialog.getByLabel('Watch duration').selectOption('30');
    await dialog.getByLabel('App passphrase').fill('offline');
    await dialog.getByRole('button', { name: 'Allow read-only Watch' }).click();
    await expect(dialog.getByText(/Watch consent saved/)).toBeVisible();
    expect(writes.filter((w) => w.path.includes('/pr-watch/'))).toHaveLength(1);
    expect(writes.at(-1)?.body).toMatchObject({
      expectedRevision: 1,
      expectedAuthorityRevision: 1,
      durationMinutes: 30,
      reviewedScope: { githubPrincipalId: '42', connectionRevision: '1' },
    });
    failed = true;
    await dialog.getByRole('button', { name: 'Refresh PR status' }).click();
    await expect(dialog.getByRole('alert')).toContainText('could not be checked');
    await expect(dialog.getByText('CI: failed', { exact: true })).toBeVisible();
    await dialog.screenshot({ path: info.outputPath(`pr-monitor-error-${theme}.png`) });
    failed = false;
    executionAvailable = false;
    p.refreshState = 'blocked';
    p.diagnostic = { code: 'connection_unavailable', stage: 'read', nextRefreshAt: null };
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(dialog.getByText(/Connection access is unavailable/)).toBeVisible();
    await expect(dialog.getByText(/Execution is unavailable/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Review Watch renewal' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Stop Watch', exact: true }).click();
    await expect(dialog.getByText('Watch stopped.', { exact: true })).toBeVisible();
    await dialog.locator('summary').filter({ hasText: 'Activity and runtime details' }).click();
    await expect(dialog.getByText(/Delivery unavailable/)).toBeVisible();
    await dialog.screenshot({ path: info.outputPath(`pr-monitor-retained-${theme}.png`) });
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const control of await dialog
      .locator('button:visible, input:visible, select:visible, summary:visible')
      .all()) {
      const box = await control.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Session details', exact: true })).toBeFocused();
    await expect(page.getByLabel('Message draft')).toHaveValue('Keep my draft');
    expect(writes.some((w) => /auto-fix|merge/.test(w.path))).toBe(false);
    expect(errors).toEqual([]);
  });
}
