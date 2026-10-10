import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const worktrees = Array.from({ length: 60 }, (_, index) => ({
  path: `/workspace/worktree-${index}`,
  name: `worktree-${index}`,
  branch:
    index === 59 ? `feature/${'long-branch-name-'.repeat(8)}final` : `feature/worktree-${index}`,
  age: 'today',
}));

// Intercept every asset and API request: no backend, provider, or model is used.
test.beforeEach(async ({ page }) => {
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/git/info') {
        const loaded = url.searchParams.get('worktrees') === '1';
        return route.fulfill({
          json: {
            branch: 'main',
            repoPath: '/workspace',
            worktreesLoaded: loaded,
            worktrees: loaded ? worktrees : [],
          },
        });
      }
      if (url.pathname === '/api/files/roots')
        return route.fulfill({ json: [{ path: '/workspace', label: 'Repository' }] });
      if (url.pathname === '/api/files') {
        const root = url.searchParams.get('root') || '/workspace';
        return route.fulfill({
          json: { entries: [{ name: 'report.md', isDir: false }], dir: root, root },
        });
      }
      if (url.pathname === '/api/files/read')
        return route.fulfill({
          json: { path: url.searchParams.get('path'), ext: '.md', content: '# Report' },
        });
      return route.fulfill({ json: {} });
    }
    const root = resolve('frontend/dist');
    const file =
      url.pathname.startsWith('/assets/') || extname(url.pathname)
        ? url.pathname.slice(1)
        : 'index.html';
    const path = resolve(root, file);
    if (!path.startsWith(root + '/')) return route.abort();
    const types: Record<string, string> = {
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.html': 'text/html',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
    };
    try {
      return route.fulfill({
        body: await readFile(path),
        contentType: types[extname(path)] || 'application/octet-stream',
      });
    } catch {
      return route.fulfill({ status: 404, body: 'Missing offline asset' });
    }
  });
});

for (const viewport of [
  { width: 320, height: 740 },
  { width: 1440, height: 900 },
]) {
  test(`many worktrees keep the file listing reachable at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/files');
    await page.getByRole('button', { name: 'Worktrees', exact: true }).click();
    const bar = page.getByRole('group', { name: 'Workspace roots and worktrees' });
    await expect(bar.getByRole('button')).toHaveCount(61);
    const bounds = await bar.boundingBox();
    expect(bounds!.height).toBeLessThanOrEqual(88);
    const file = page.getByRole('button', { name: 'report.md', exact: true });
    await expect(file).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const last = bar.getByRole('button', { name: worktrees[59].branch, exact: true });
    await last.scrollIntoViewIfNeeded();
    await last.click();
    await expect(last).toHaveAttribute('aria-pressed', 'true');
    expect((await last.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(file).toBeInViewport();
    await file.click();
    await expect(page.getByRole('heading', { name: 'Report', exact: true })).toBeVisible();
  });
}
