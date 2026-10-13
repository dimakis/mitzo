import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

// Reuse the full inventory regression against the compiled app, with no server.
// Its own later API route supplies the injected, synthetic inventory.
test.beforeEach(async ({ page }) => {
  const types: Record<string, string> = {
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test' || url.pathname.startsWith('/api/')) return route.abort();
    const file =
      url.pathname.startsWith('/assets/') || extname(url.pathname)
        ? url.pathname.slice(1)
        : 'index.html';
    try {
      await route.fulfill({
        body: await readFile(resolve('frontend/dist', file)),
        contentType: types[extname(file)] ?? 'application/octet-stream',
      });
    } catch {
      await route.fulfill({ status: 404, body: 'Missing offline asset' });
    }
  });
});
await import('../browser/connections-evidence.spec');

for (const [theme, accent, font, documentsEditing] of [
  ['dark', 'mint', 'georgia', true],
  ['light', 'teal', 'system', true],
  ['dark', 'lavender', 'system', false],
] as const) {
  test(`Google Docs policy: ${theme} ${accent} editing=${documentsEditing}`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(
      ({ theme, accent, font }) => {
        localStorage.setItem('mitzo-theme', theme);
        localStorage.setItem('mitzo-accent', accent);
        localStorage.setItem('mitzo-font', font);
      },
      { theme, accent, font },
    );
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({
        json:
          path === '/api/connections/google-workspace'
            ? {
                health: 'ready',
                expiresAt: Date.now() + 3600000,
                slidesEditing: true,
                documentsEditing,
              }
            : path === '/api/connections'
              ? {
                  connections: [],
                  eligibleAccounts: [],
                  operatorManaged: [],
                  googleWorkspaceManaged: true,
                }
              : path === '/api/connections/templates'
                ? { templates: [] }
                : {},
      });
    });
    await page.goto('/connections?manage=google');
    await expect(
      page.getByRole('heading', { name: 'Google Workspace', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        documentsEditing ? 'Docs creation and editing are enabled.' : 'Docs access is read-only.',
        { exact: false },
      ),
    ).toBeVisible();
    await expect(
      page.getByText('Drive, Sheets and Calendar access is read-only.', { exact: false }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Check Google status' }).focus();
    await expect(page.getByRole('button', { name: 'Check Google status' })).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('google-docs-policy.png'), fullPage: true });
  });
}
