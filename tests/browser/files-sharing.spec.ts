import { expect, test } from '@playwright/test';

test('a file reopened from an existing conversation can follow links and share its original bytes', async ({
  page,
}) => {
  const sessionId = 'existing-conversation';
  const report = '# Existing report\n\n[Notes](/workspace/notes.md)';
  const notes = '# Notes\n\nSaved before the app update.\n';
  const downloads: URL[] = [];
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async ({ files }: { files: File[] }) => {
        const file = files[0];
        (window as unknown as { sharedFile: unknown }).sharedFile = {
          name: file.name,
          type: file.type,
          content: await file.text(),
        };
      },
    });
  });
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/files/read') {
      expect(url.searchParams.get('sessionId')).toBe(sessionId);
      const path = url.searchParams.get('path');
      return route.fulfill({
        json: { path, ext: '.md', content: path?.endsWith('notes.md') ? notes : report },
      });
    }
    if (url.pathname === '/api/files/download') {
      downloads.push(url);
      return route.fulfill({ contentType: 'application/octet-stream', body: notes });
    }
    if (url.pathname === '/api/files/roots') return route.fulfill({ json: [] });
    if (url.pathname === '/api/git/info') {
      return route.fulfill({ json: { branch: 'main', repoPath: '/workspace', worktrees: [] } });
    }
    // No credentials, real backend, or model calls are used by this regression.
    return route.fulfill({ json: {} });
  });
  await page.goto(
    `/files?path=%2Fworkspace%2Freport.md&sessionId=${sessionId}&from=%2Fchat%2F${sessionId}`,
  );
  await expect(page.getByRole('heading', { name: 'Existing report' })).toBeVisible();
  await page.getByRole('link', { name: 'Notes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('sessionId')).toBe(sessionId);
  const share = page.getByRole('button', { name: 'Share file', exact: true });
  await expect(share).toBeInViewport();
  await share.click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { sharedFile: unknown }).sharedFile))
    .toEqual({
      name: 'notes.md',
      type: 'text/markdown',
      content: notes,
    });
  expect(downloads).toHaveLength(1);
  expect(downloads[0].searchParams.get('sessionId')).toBe(sessionId);
  expect(downloads[0].searchParams.get('path')).toBe('/workspace/notes.md');
});
