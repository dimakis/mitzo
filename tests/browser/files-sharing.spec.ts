import { readFile } from 'node:fs/promises';
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

test('Download saves the original document when the browser share sheet is blocked', async ({
  page,
}) => {
  const document = '# Document\n\n**Formatting** stays in Markdown.\n';
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async () => {
        throw new DOMException('Sharing blocked', 'NotAllowedError');
      },
    });
  });
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/files/read')
      return route.fulfill({
        json: { path: '/workspace/document.md', ext: '.md', content: document },
      });
    if (url.pathname === '/api/files/download') {
      expect(url.searchParams.get('sessionId')).toBe('saved-session');
      expect(url.searchParams.get('path')).toBe('/workspace/document.md');
      return route.fulfill({ contentType: 'text/plain', body: document });
    }
    if (url.pathname === '/api/files/roots') return route.fulfill({ json: [] });
    if (url.pathname === '/api/git/info')
      return route.fulfill({ json: { branch: 'main', repoPath: '/workspace', worktrees: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto('/files?path=%2Fworkspace%2Fdocument.md&sessionId=saved-session');
  await expect(page.getByRole('heading', { name: 'Document' })).toBeVisible();
  // Reproduce the reported share error, then recover with the independent Download action.
  await page.getByRole('button', { name: 'Share file', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Tap Share again');
  const downloadButton = page.getByRole('button', { name: 'Download file', exact: true });
  await expect(downloadButton).toBeInViewport();
  const downloaded = page.waitForEvent('download');
  await downloadButton.click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe('document.md');
  expect(await file.failure()).toBeNull();
  expect(await readFile((await file.path())!, 'utf8')).toBe(document);
  await expect(page.getByRole('button', { name: 'Downloaded', exact: true })).toBeVisible();
});
