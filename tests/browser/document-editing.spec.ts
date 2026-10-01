import { expect, test } from '@playwright/test';

for (const sessionId of ['vertex', 'openai-api', 'openai-subscription']) {
  test(`edits, previews and saves documents in ${sessionId}`, async ({ page }) => {
    const writes: Record<string, unknown>[] = [];
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/api/**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/files/read')
        return route.fulfill({ json: { path: 'report.md', ext: '.md', content: '# Original\n' } });
      if (url.pathname === '/api/files/write') {
        writes.push(route.request().postDataJSON());
        return route.fulfill({ json: { ok: true } });
      }
      if (url.pathname === '/api/files/roots') return route.fulfill({ json: [] });
      if (new URL(route.request().url()).pathname === '/api/git/info')
        return route.fulfill({ json: { branch: 'main', repoPath: '/workspace', worktrees: [] } });
      return route.fulfill({ json: {} });
    });
    await page.goto(`/files?path=report.md&sessionId=${sessionId}`);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const source = page.getByRole('textbox', { name: 'Document source' });
    await source.fill('# Updated\n\nA better document.');
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Updated', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(source).toHaveValue('# Original\n');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    const save = page.getByRole('button', { name: 'Save', exact: true });
    await expect(save).toBeInViewport();
    await save.click();
    await expect(page.getByRole('status')).toContainText('All changes saved');
    expect(writes).toEqual([
      {
        path: 'report.md',
        sessionId,
        content: '# Updated\n\nA better document.',
        expectedContent: '# Original\n',
      },
    ]);
    await expect(source).toBeVisible();
  });
}

test('recovers a draft after reload and resolves a concurrent save conflict', async ({ page }) => {
  let content = '# Original';
  const writes: Record<string, unknown>[] = [];
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/files/read')
      return route.fulfill({ json: { content, ext: '.md', path: 'report.md' } });
    if (url.pathname === '/api/files/write') {
      const body = route.request().postDataJSON();
      writes.push(body);
      if (body.expectedContent !== content)
        return route.fulfill({ status: 409, json: { error: 'File changed elsewhere.' } });
      content = body.content;
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === '/api/files/roots') return route.fulfill({ json: [] });
    if (new URL(route.request().url()).pathname === '/api/git/info')
      return route.fulfill({ json: { branch: 'main', repoPath: '/workspace', worktrees: [] } });
    return route.fulfill({ json: {} });
  });
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/files?path=report.md&sessionId=openai-api');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'Document source' }).fill('# My draft');
  content = '# Agent update';
  await page.reload();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('textbox')).toHaveValue('# My draft');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('textbox')).toBeVisible();
  await page.getByRole('button', { name: 'Review latest version' }).click();
  await expect(page.getByRole('region', { name: 'Latest saved version' })).toContainText(
    '# Agent update',
  );
  await page.getByRole('button', { name: 'Keep my draft for next save' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('All changes saved');
  expect(writes.at(-1)?.expectedContent).toBe('# Agent update');
});

test('edits HTML while preserving a sandboxed live preview', async ({ page }) => {
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/api/**', (route) => {
    if (new URL(route.request().url()).pathname === '/api/files/read')
      return route.fulfill({
        json: { path: 'page.html', ext: '.html', content: '<h1>Original</h1>' },
      });
    if (new URL(route.request().url()).pathname === '/api/git/info')
      return route.fulfill({ json: { branch: 'main', repoPath: '/workspace', worktrees: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto('/files?path=page.html&sessionId=openai-subscription');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox').fill('<h1>Edited</h1>');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(
    page.frameLocator('iframe[title="Document preview"]').getByRole('heading', { name: 'Edited' }),
  ).toBeVisible();
  await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
});

test('warns when unsaved changes cannot be backed up', async ({ page }) => {
  await page.addInitScript(() => {
    const store = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('mitzo-file-draft:'))
        throw new DOMException('Storage full', 'QuotaExceededError');
      return store.call(this, key, value);
    };
  });
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/files/read')
      return route.fulfill({ json: { path: 'report.md', content: '# Original', ext: '.md' } });
    if (url.pathname === '/api/files/roots') return route.fulfill({ json: [] });
    if (url.pathname === '/api/git/info')
      return route.fulfill({ json: { branch: 'main', repoPath: '/workspace', worktrees: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto('/files?path=report.md&sessionId=vertex');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox').fill('# Draft');
  await expect(page.getByRole('alert')).toContainText('Latest changes are not backed up');
  await expect(page.getByRole('status')).not.toContainText('draft kept');
  await expect(page.getByRole('textbox')).toHaveValue('# Draft');
});
