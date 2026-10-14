import { disabledLocalCapabilities } from '../support/disabled-local-capabilities';
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
    if (await disabledLocalCapabilities(route, url)) return;
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

for (const width of [320, 393, 1280]) {
  for (const theme of ['dark', 'light']) {
    test(`file header counts the safe area once at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      // Desktop browser emulation reports a zero inset even for iPhone devices.
      // Simulate the notched phone's inset in every app stylesheet, so duplicate
      // ownership between the real shell and viewer is observable offline.
      await page.route('**/*.css', async (route) => {
        const path = new URL(route.request().url()).pathname;
        const css = await readFile(resolve('frontend/dist', path.slice(1)), 'utf8');
        await route.fulfill({
          contentType: 'text/css',
          body: css.replaceAll('env(safe-area-inset-top)', '59px'),
        });
      });
      await page.addInitScript((theme) => {
        localStorage.setItem('mitzo-theme', theme);
        localStorage.setItem('mitzo-accent', 'mint');
        localStorage.setItem('mitzo-font', 'georgia');
      }, theme);
      await page.route('**/api/service-health', (route) =>
        route.fulfill({
          json: {
            services: [{ name: 'yapper', ok: true, detail: { tts: true } }],
            checkedAt: Date.now(),
          },
        }),
      );
      const filename = 'openshell-praxis-composition.md';
      await page.route('**/api/files/read?*', (route) =>
        route.fulfill({
          json: {
            path: filename,
            ext: '.md',
            content:
              '# Report\n\n' + 'Readable document content.\n\n'.repeat(80) + 'Last paragraph.',
          },
        }),
      );
      await page.goto(`/files?path=${filename}`);
      const header = page.locator('.viewer-header');
      await expect(page.getByRole('heading', { name: 'Report', exact: true })).toBeVisible();
      const padding = await header.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          top: parseFloat(style.paddingTop),
          bottom: parseFloat(style.paddingBottom),
        };
      });
      expect(padding.top - padding.bottom).toBeCloseTo(width < 768 ? 0 : 59);
      await expect(header).toContainText(filename);
      await expect(header.getByRole('button', { name: 'Read', exact: true })).toBeVisible();
      for (const button of await header.getByRole('button').all()) {
        const bounds = await button.boundingBox();
        if (!bounds) continue;
        expect(bounds.height).toBeGreaterThanOrEqual(44);
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        await expect(button).toBeInViewport();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const edit = page.getByRole('button', { name: 'Edit', exact: true });
      await edit.focus();
      await expect(edit).toBeFocused();
      await page.locator('.viewer-content').evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(page.getByText('Last paragraph.', { exact: true })).toBeInViewport();
      await page.locator('.viewer-content').evaluate((element) => {
        element.scrollTop = 0;
      });
      await testInfo.attach('file-header', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
      // Larger text must still leave the controls reachable without page overflow.
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '20px';
      });
      await expect(edit).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
  }
}
