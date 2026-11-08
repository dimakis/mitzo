import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const bundled = build({
  entryPoints: [resolve('tests/fixtures/chat-ui-usability.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/chat-ui-usability.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.svg', '/*.png'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});
for (const theme of ['light', 'dark'])
  test(`chat controls: budget, permissions and meaningful choices (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const files = (await bundled).outputFiles!;
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'mitzo-ui.test' || route.request().method() !== 'GET')
        return route.abort();
      const path = url.pathname;
      if (path.startsWith('/api/'))
        return route.fulfill({
          json:
            path === '/api/config'
              ? {
                  contextBlocks: {
                    'Jira Workflow': { path: 'jira.md', sizeBytes: 20000 },
                    'Org Structure': { path: 'org.md', sizeBytes: 7000 },
                  },
                }
              : path === '/api/sessions/fixture/access'
                ? {
                    sessionId: 'fixture',
                    state: 'current',
                    observedAt: Date.now(),
                    mode: 'agent',
                    account: { accountLabel: 'Personal' },
                    model: 'Fixture model',
                    grants: [],
                    pending: [],
                    skillCeiling: null,
                  }
                : {},
        });
      const file = files.find((file) => path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'));
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    if (theme === 'light') await page.addStyleTag({ content: 'html { font-size: 125%; }' });
    await expect(page.getByRole('combobox', { name: 'Execution host' })).toHaveCount(0);
    await expect(page.getByText('This Mac', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open session tray' }).click();
    await page.getByRole('tab', { name: 'Context' }).click();
    const resources = page.getByRole('dialog', { name: 'Resources' });
    await expect(resources.getByRole('meter')).toHaveAttribute('aria-valuenow', '40');
    await expect(resources.getByText('120k tokens remaining')).toBeVisible();
    const block = resources.getByRole('button', { name: /Jira Workflow/ });
    await expect(block).toBeVisible();
    expect((await block.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await block.click();
    await expect(block).toHaveAttribute('aria-pressed', 'true');
    expect(await resources.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath(`context-${theme}.png`),
      animations: 'disabled',
    });
    await page.getByRole('tab', { name: 'References' }).click();
    await expect(page.getByTestId('reference-domain')).toHaveCount(1);
    await page.getByRole('checkbox', { name: 'Include links from tool output' }).check();
    await expect(page.getByTestId('reference-domain')).toHaveCount(3);
    await page.screenshot({
      path: info.outputPath(`references-${theme}.png`),
      animations: 'disabled',
    });
    await resources.press('Escape');
    await expect(page.getByRole('button', { name: 'Open session tray' })).toBeFocused();
    await page.getByRole('button', { name: 'Access', exact: true }).click();
    const access = page.getByRole('dialog', { name: 'Access' });
    await expect(access.getByText('No pending requests observed.')).toBeVisible();
    await expect(access.getByText('Available tools')).toBeHidden();
    await access.getByText('Runtime details', { exact: true }).click();
    await expect(access.getByText('Available tools')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`access-${theme}.png`), animations: 'disabled' });
    await access.press('Escape');
    await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveValue('Keep my message');
    expect(errors).toEqual([]);
  });
