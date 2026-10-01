import { expect, test } from '@playwright/test';

// Provider/workspace identities come from the file API; no live model calls.
for (const account of ['vertex', 'openai-api', 'chatgpt-subscription']) {
  for (const runtime of ['host', 'openshell']) {
    test(`Mermaid files retain conversation scope: ${account}/${runtime}`, async ({
      page,
      isMobile,
    }) => {
      const sessionId = `${account}-${runtime}`;
      const path = runtime === 'host' ? '/workspace/report.md' : '/sandbox/workspace/report.md';
      const source =
        '# Report\n\n```mermaid\ngraph TD; A[Start]-->B[Finish];\n```\n\n```python\nprint("hi")\n```\n\n```mermaid\ninvalid{{{\n```';
      const reads: URL[] = [];
      await page.addInitScript(() => localStorage.setItem('mitzo-theme', 'dark'));
      await page.routeWebSocket('**/*', (socket) => socket.close());
      await page.route('**/api/**', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/files/read') {
          reads.push(url);
          return route.fulfill({ json: { path, ext: '.md', content: source } });
        }
        if (url.pathname === '/api/service-health')
          return route.fulfill({ json: { services: [] } });
        if (url.pathname === '/api/files/roots') return route.fulfill({ json: [] });
        if (url.pathname === '/api/git/info')
          return route.fulfill({ json: { branch: 'main', repoPath: '/workspace', worktrees: [] } });
        return route.fulfill({ json: {} });
      });
      await page.goto(`/files?path=${encodeURIComponent(path)}&sessionId=${sessionId}`);
      const diagram = page.locator('.mermaid-block-svg svg');
      await expect(diagram).toHaveCount(1);
      await expect(page.getByText('Start', { exact: true })).toBeVisible();
      await expect(
        page.locator('.code-block-wrapper').filter({ hasText: 'invalid{{{' }),
      ).toBeVisible();
      await expect(
        page.locator('.code-block-wrapper').filter({ hasText: 'print("hi")' }),
      ).toBeVisible();
      const copy = page.getByRole('button', { name: 'Copy source' });
      await copy.scrollIntoViewIfNeeded();
      if (!isMobile) await page.locator('.mermaid-block').hover();
      await expect(copy).toBeVisible();
      await expect(copy).toHaveCSS('opacity', isMobile ? '0.5' : '1');
      for (const read of reads) {
        expect(read.searchParams.get('sessionId')).toBe(sessionId);
        expect(read.searchParams.get('path')).toBe(path);
      }
      expect(reads.length).toBeGreaterThan(0);
      const darkSvg = await diagram.evaluate((element) => element.outerHTML);
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      await expect(diagram).toHaveCount(1);
      await expect.poll(() => diagram.evaluate((element) => element.outerHTML)).not.toBe(darkSvg);
      expect(await page.locator('body > div[aria-hidden="true"]').count()).toBe(0);
    });
  }
}
