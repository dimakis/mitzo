import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/shared-tool-operations.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/shared-tool-operations.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});

for (const theme of ['dark', 'light'])
  test(`all tool families share the operation header (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const files = (await bundle).outputFiles!;
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      const asset = files.find(
        (file) => url.pathname === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (asset)
        return route.fulfill({
          body: asset.text,
          contentType: asset.path.endsWith('.css') ? 'text/css' : 'application/javascript',
        });
      if (url.pathname !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}" style="font-size:${theme === 'dark' ? 16 : 20}px"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>.fixture{max-width:42rem;margin:auto;padding:var(--space-3)}label{display:block;margin-block:var(--space-2)}select,textarea{max-width:100%;min-height:var(--control-height);font:inherit}textarea{box-sizing:border-box;width:100%}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    for (const name of [
      'Bash',
      'Read',
      'Write',
      'Edit',
      'Agent',
      'GitHubRead',
      'TaskExecution',
      'mcp__atlassian__search',
      'AnUnknownFutureTool',
      'AgentProposeTask',
    ]) {
      await page.getByLabel('Tool example').selectOption({ label: name });
      const header = page.locator('.operation-header');
      await expect(header.getByRole('heading', { name, exact: true })).toBeVisible();
      await expect(header.getByText('Done', { exact: true })).toBeVisible();
      const details = page.getByRole('button', { name: /^Details for/ });
      await expect(details).toHaveAttribute('aria-expanded', 'false');
      await details.click();
      await expect(page.locator('.operation-details')).toBeVisible();
      if (name !== 'AgentProposeTask')
        await expect(page.locator('.operation-details')).toContainText('Original output');
      await page.locator('.operation-details').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      if (name === 'AgentProposeTask') {
        const review = header.getByRole('link', { name: 'Review task in Library' });
        await expect(review).toBeInViewport({ ratio: 1 });
        expect((await review.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await expect(review).toHaveAttribute(
          'href',
          '/agent-library?proposal=proposal&session=lead&task=task&revision=3',
        );
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await details.click();
    }
    await page.getByLabel('Group tool activity').check();
    await expect(page.getByRole('button', { name: '2 tool calls' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(page.getByRole('link', { name: 'Review task in Library' })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`shared-tools-${theme}.png`) });
    await page.getByLabel('Group tool activity').uncheck();
    await page.getByLabel('Tool example').selectOption({ label: 'AnUnknownFutureTool' });
    await page.getByLabel('Show failure').check();
    await expect(
      page.locator('.operation-header').getByText('Failed', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveValue('Keep this draft');
    expect(errors).toEqual([]);
  });
