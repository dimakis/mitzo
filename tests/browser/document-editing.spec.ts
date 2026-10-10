import { expect, test, type Locator, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

async function sourceText(source: Locator) {
  return source.evaluate((element) =>
    element instanceof HTMLTextAreaElement
      ? element.value
      : Array.from(element.querySelectorAll('.cm-line'), (line) => line.textContent).join('\n'),
  );
}

async function expectSource(source: Locator, value: string) {
  await expect.poll(() => sourceText(source)).toBe(value);
}

async function selectKnowledgeDocument(page: Page, path: string) {
  const ancestors = path.split('/').slice(0, -1);
  for (let index = 0; index < ancestors.length; index++) {
    const folder = page.getByRole('button', {
      name: `Folder ${ancestors.slice(0, index + 1).join('/')}`,
      exact: true,
    });
    await expect(folder).toBeVisible();
    if ((await folder.getAttribute('aria-expanded')) === 'false') await folder.click();
  }
  const row = page.locator('.knowledge-tree-row').filter({
    has: page.getByRole('button', { name: `Options for ${path}`, exact: true }),
  });
  await row.locator('.knowledge-tree-entry').click();
}

async function editKnowledgeDocument(page: Page, path: string, title: string) {
  await selectKnowledgeDocument(page, path);
  await expect(page.getByRole('article', { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Document source' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Document source' })).toBeVisible();
}

async function mockDocument(page: Page, content: string) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'mitzo:service-health',
      JSON.stringify({
        services: [{ name: 'yapper', ok: true, detail: { tts: true } }],
        checkedAt: 0,
      }),
    );
  });
  const writes: Record<string, unknown>[] = [];
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/files/read')
      return route.fulfill({ json: { path: 'report.md', ext: '.md', content } });
    if (url.pathname === '/api/files/write') {
      writes.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === '/api/files/roots') return route.fulfill({ json: [] });
    if (url.pathname === '/api/git/info')
      return route.fulfill({ json: { branch: 'main', repoPath: '/workspace', worktrees: [] } });
    if (new URL(route.request().url()).pathname === '/api/service-health')
      return route.fulfill({
        json: { services: [{ name: 'yapper', ok: true, detail: { tts: true } }], checkedAt: 0 },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto('/files?path=report.md&sessionId=openai-api');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  return writes;
}

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
      if (new URL(route.request().url()).pathname === '/api/service-health')
        return route.fulfill({
          json: { services: [{ name: 'yapper', ok: true, detail: { tts: true } }], checkedAt: 0 },
        });
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
    await expectSource(source, '# Original\n');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    const save = page.getByRole('button', { name: 'Save', exact: true });
    await expect(save).toBeInViewport();
    await save.click();
    await expect(page.locator('.document-editor-status')).toContainText('All changes saved');
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
    if (new URL(route.request().url()).pathname === '/api/service-health')
      return route.fulfill({
        json: { services: [{ name: 'yapper', ok: true, detail: { tts: true } }], checkedAt: 0 },
      });
    return route.fulfill({ json: {} });
  });
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/files?path=report.md&sessionId=openai-api');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'Document source' }).fill('# My draft');
  content = '# Agent update';
  await page.reload();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expectSource(page.getByRole('textbox', { name: 'Document source' }), '# My draft');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('textbox')).toBeVisible();
  await page.getByRole('button', { name: 'Review latest version' }).click();
  await expect(page.getByRole('region', { name: 'Latest saved version' })).toContainText(
    '# Agent update',
  );
  await page.getByRole('button', { name: 'Keep my draft for next save' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.document-editor-status')).toContainText('All changes saved');
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
    if (new URL(route.request().url()).pathname === '/api/service-health')
      return route.fulfill({
        json: { services: [{ name: 'yapper', ok: true, detail: { tts: true } }], checkedAt: 0 },
      });
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
    if (new URL(route.request().url()).pathname === '/api/service-health')
      return route.fulfill({
        json: { services: [{ name: 'yapper', ok: true, detail: { tts: true } }], checkedAt: 0 },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto('/files?path=report.md&sessionId=vertex');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox').fill('# Draft');
  await expect(page.getByRole('alert')).toContainText('Latest changes are not backed up');
  await expect(page.locator('.document-editor-status')).not.toContainText('draft kept');
  await expectSource(page.getByRole('textbox', { name: 'Document source' }), '# Draft');
});

test('keeps a resolved worktree target when a same-content repository file appears', async ({
  page,
}) => {
  const posted = '/workspace/outputs/report.md';
  const actual = '/workspace/.claude/worktrees/vertex/outputs/report.md';
  let mainExists = false;
  const writes: Record<string, unknown>[] = [];
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/files/read')
      return route.fulfill({ json: { path: actual, ext: '.md', content: '# Original' } });
    if (url.pathname === '/api/files/write') {
      const body = route.request().postDataJSON();
      writes.push(body);
      return route.fulfill({
        json: { ok: true, path: mainExists && body.path === posted ? posted : actual },
      });
    }
    if (url.pathname === '/api/files/roots') return route.fulfill({ json: [] });
    if (url.pathname === '/api/git/info')
      return route.fulfill({ json: { branch: 'main', repoPath: '/workspace', worktrees: [] } });
    if (new URL(route.request().url()).pathname === '/api/service-health')
      return route.fulfill({
        json: { services: [{ name: 'yapper', ok: true, detail: { tts: true } }], checkedAt: 0 },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto('/files?path=' + encodeURIComponent(posted) + '&sessionId=vertex');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  mainExists = true;
  await page.getByRole('textbox', { name: 'Document source' }).fill('# Edited worktree');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.document-editor-status')).toContainText('All changes saved');
  expect(writes[0]).toMatchObject({
    path: actual,
    sessionId: 'vertex',
    expectedContent: '# Original',
  });
});

test('desktop Vim motions, text objects, history and :w edit and save the same draft', async ({
  page,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, 'Vim keyboard editing is desktop-only');
  const original = 'alpha beta gamma\nsecond line\nthird line';
  const writes = await mockDocument(page, original);
  const source = page.getByRole('textbox', { name: 'Document source' });
  await expect(source).toHaveAttribute('contenteditable', 'true');
  await expect(page.getByRole('button', { name: 'Standard', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Vim', exact: true }).click();
  const mode = page.getByRole('status', { name: 'Vim mode' });
  await expect(mode).toHaveText('NORMAL');
  await expect(source).toBeFocused();
  for (const key of ['g', 'g', '0', 'w', 'd', 'w']) await source.press(key);
  await expectSource(source, 'alpha gamma\nsecond line\nthird line');
  await source.press('u');
  await expectSource(source, original);
  await source.press('Control+r');
  await expectSource(source, 'alpha gamma\nsecond line\nthird line');
  await source.press('u');
  for (const key of ['g', 'g', '0', 'w', 'c', 'i', 'w']) await source.press(key);
  await expect(mode).toHaveText('INSERT');
  await page.keyboard.type('BETA');
  await source.press('Escape');
  await expect(mode).toHaveText('NORMAL');
  const edited = 'alpha BETA gamma\nsecond line\nthird line';
  await expectSource(source, edited);
  await source.press('v');
  await expect(mode).toHaveText('VISUAL');
  await source.press('Escape');
  await page.getByRole('button', { name: 'Standard', exact: true }).click();
  await expectSource(source, edited);
  await page.getByRole('button', { name: 'Vim', exact: true }).click();
  await expect(source).toBeFocused();
  await source.press(':');
  await page.keyboard.type('w');
  await page.keyboard.press('Enter');
  await expect(page.locator('.document-editor-status')).toContainText('All changes saved');
  expect(writes).toEqual([
    {
      path: 'report.md',
      sessionId: 'openai-api',
      content: edited,
      expectedContent: original,
    },
  ]);
  await expect(source).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('desktop-vim.png') });
});

test('Vim keeps Markdown formatting controls and shared undo available', async ({ page }) => {
  const original = 'alpha beta';
  await mockDocument(page, original);
  await page.getByRole('button', { name: 'Vim', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Document source' });
  const mode = page.getByRole('status', { name: 'Vim mode' });
  await expect(mode).toHaveText('NORMAL');
  const formatting = ['Bold', 'Italic', 'Inline code', 'Heading', 'List', 'Link'];
  for (const name of formatting)
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  for (const key of ['g', 'g', '0', 'v', 'e']) await source.press(key);
  await expect(mode).toHaveText('VISUAL');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expectSource(source, '**alpha** beta');
  await expect(source).toBeFocused();
  await source.press('Escape');
  await expect(mode).toHaveText('NORMAL');
  await source.press('u');
  await expectSource(source, original);
  await source.press('Control+r');
  await expectSource(source, '**alpha** beta');
  await source.press('i');
  await expect(mode).toHaveText('INSERT');
  for (const name of formatting)
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  await source.press('Escape');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Vim', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('fullscreen and preview preserve an unsaved draft and keep save reachable', async ({
  page,
  isMobile,
}, testInfo) => {
  await mockDocument(page, '# Original');
  const source = page.getByRole('textbox', { name: 'Document source' });
  await source.fill('# Fullscreen draft\n\nStill unsaved.');
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  const fullscreen = page.locator('.document-editor--fullscreen');
  await expect(fullscreen).toBeVisible();
  if (!isMobile) await expect(source).toBeFocused();
  expect(
    await page
      .locator('.viewer-header')
      .getByRole('button', { name: 'Save', exact: true, includeHidden: true })
      .evaluate((element) => {
        (element as HTMLButtonElement).focus();
        return document.activeElement === element;
      }),
  ).toBe(false);
  const fullscreenSave = fullscreen.getByRole('button', { name: 'Save', exact: true });
  await page.screenshot({ path: testInfo.outputPath('fullscreen-toolbar.png') });
  await expect(fullscreenSave).toBeInViewport();
  await fullscreenSave.click({ trial: true });
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fullscreen draft', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(source).toBeVisible();
  if (!isMobile) await expect(source).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Fullscreen draft', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expectSource(source, '# Fullscreen draft\n\nStill unsaved.');
  await page.screenshot({
    path: testInfo.outputPath(isMobile ? 'mobile-fullscreen.png' : 'desktop-fullscreen.png'),
  });
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await expect(page.locator('.document-editor--fullscreen')).toHaveCount(0);
  await expectSource(source, '# Fullscreen draft\n\nStill unsaved.');
});

test('touch editing defaults to standard selection and replacement with a visible save action', async ({
  page,
  isMobile,
}, testInfo) => {
  test.skip(!isMobile, 'Native touch editor');
  const writes = await mockDocument(page, 'alpha beta gamma');
  const source = page.getByRole('textbox', { name: 'Document source' });
  await expect(source).toHaveJSProperty('tagName', 'TEXTAREA');
  await expect(page.getByRole('status', { name: 'Vim mode' })).toHaveCount(0);
  await source.evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(6, 10);
  });
  await page.keyboard.type('BETA');
  await expectSource(source, 'alpha BETA gamma');
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeInViewport();
  await save.click();
  await expect(page.locator('.document-editor-status')).toContainText('All changes saved');
  expect(writes[0]?.content).toBe('alpha BETA gamma');
  await page.screenshot({ path: testInfo.outputPath('mobile-standard.png') });
});

test('the desktop source remains read-only while the current draft is saving', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'CodeMirror save barrier');
  await mockDocument(page, 'original');
  let finishSave!: () => void;
  const pending = new Promise<void>((resolve) => {
    finishSave = resolve;
  });
  const writes: Record<string, unknown>[] = [];
  await page.route('**/api/files/write', async (route) => {
    writes.push(route.request().postDataJSON());
    await pending;
    await route.fulfill({ json: { ok: true } });
  });
  const source = page.getByRole('textbox', { name: 'Document source' });
  await source.fill('draft');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.document-editor-status')).toContainText('Saving');
  await source.focus();
  await page.keyboard.type('unwanted');
  await expectSource(source, 'draft');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeDisabled();
  finishSave();
  await expect(page.locator('.document-editor-status')).toContainText('All changes saved');
  expect(writes).toHaveLength(1);
  expect(writes[0]?.content).toBe('draft');
});

test('relative line numbers follow the Vim cursor without changing the draft', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'Desktop line-number gutter');
  const original = 'first line\nsecond line\nthird line';
  await mockDocument(page, original);
  const source = page.getByRole('textbox', { name: 'Document source' });
  await page.getByRole('button', { name: 'Vim', exact: true }).click();
  await source.focus();
  for (const key of ['g', 'g', 'j']) await source.press(key);
  const gutter = page.locator('.cm-lineNumbers .cm-gutterElement');
  const labels = () =>
    gutter.evaluateAll((lines) =>
      lines
        .filter((line) => (line as HTMLElement).style.visibility !== 'hidden')
        .map((line) => line.textContent),
    );
  await expect.poll(labels).toEqual(['1', '2', '3']);
  await page.getByRole('button', { name: 'Relative line numbers', exact: true }).click();
  await expect.poll(labels).toEqual(['1', '2', '1']);
  await source.focus();
  await source.press('j');
  await expect.poll(labels).toEqual(['2', '1', '3']);
  await expectSource(source, original);
});

test('a fullscreen save conflict keeps its draft and latest-version review usable inside the modal', async ({
  page,
  isMobile,
}, testInfo) => {
  const latest =
    '# Agent update\n\n' +
    Array.from({ length: 300 }, (_, index) => `Latest line ${index + 1}`).join('\n');
  const writes = await mockDocument(page, '# Original');
  await page.route('**/api/files/write', (route) =>
    route.fulfill({ status: 409, json: { error: 'File changed elsewhere.' } }),
  );
  await page.route('**/api/files/read?**', (route) =>
    route.fulfill({ json: { path: 'report.md', ext: '.md', content: latest } }),
  );
  const source = page.getByRole('textbox', { name: 'Document source' });
  await source.fill('# My fullscreen draft');
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Fullscreen document editor' });
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(modal).toContainText('File changed elsewhere.');
  await expectSource(source, '# My fullscreen draft');
  await modal.getByRole('button', { name: 'Review latest version' }).click();
  await expect(modal.getByRole('region', { name: 'Latest saved version' })).toContainText(
    '# Agent update',
  );
  expect((await source.boundingBox())!.height).toBeGreaterThan(44);
  const comparison = modal.getByRole('region', { name: 'Latest saved version' });
  await comparison.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const keep = modal.getByRole('button', { name: 'Keep my draft for next save' });
  await expect(keep).toBeInViewport();
  await keep.click({ trial: true });
  await page.screenshot({ path: testInfo.outputPath('fullscreen-large-conflict.png') });
  await keep.click();
  await expectSource(source, '# My fullscreen draft');
  await expect(modal.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(modal.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  if (!isMobile) {
    await modal.getByRole('button', { name: 'Vim', exact: true }).click();
    await expect(source).toBeFocused();
    await source.press('u');
    await expectSource(source, '# My fullscreen draft');
  }
  await page.unroute('**/api/files/write');
  // Restore only the synthetic save endpoint, keeping the app entirely offline.
  await page.route('**/api/files/write', (route) => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(modal).toContainText('All changes saved');
  expect(writes.at(-1)).toMatchObject({
    content: '# My fullscreen draft',
    expectedContent: latest,
  });
});

test('mobile fullscreen follows a synthetic shrunken and panned visual viewport', async ({
  page,
  isMobile,
}, testInfo) => {
  test.skip(!isMobile, 'Touch visual viewport contract');
  await mockDocument(page, '# Original');
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Fullscreen document editor' });
  for (const offsetTop of [0, 100]) {
    await page.evaluate((offset) => {
      const viewport = window.visualViewport!;
      Object.defineProperty(viewport, 'height', { configurable: true, get: () => 450 });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, get: () => offset });
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    }, offsetTop);
    await expect
      .poll(async () => {
        const bounds = (await modal.boundingBox())!;
        return bounds.y >= offsetTop && bounds.y + bounds.height <= offsetTop + 450;
      })
      .toBe(true);
    const footer = (await modal.locator('.document-editor-footer').boundingBox())!;
    expect(footer.y + footer.height).toBeLessThanOrEqual(offsetTop + 450);
    await expect(modal.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
    expect(
      (await modal.getByRole('textbox', { name: 'Document source' }).boundingBox())!.height,
    ).toBeGreaterThan(44);
  }
  await page.screenshot({ path: testInfo.outputPath('mobile-fullscreen-resized-viewport.png') });
});

test('Knowledge edits and saves its working copy with usable source, preview and fullscreen', async ({
  page,
  isMobile,
}, testInfo) => {
  const original = '# Working principles\n\nAccepted knowledge.';
  const writes: Record<string, unknown>[] = [];
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/knowledge')
      return route.fulfill({
        json: {
          revision: 'r1',
          documents: [{ path: 'hub/principles.md', title: 'Working principles', area: 'Hub' }],
          directories: ['hub'],
          documentPaths: ['hub'],
          drafts: [],
          reviewEnabled: false,
          acceptanceEnabled: false,
          syncedAt: null,
        },
      });
    if (url.pathname === '/api/knowledge/document')
      return route.fulfill({
        json: { path: 'hub/principles.md', revision: 'r1', content: original },
      });
    if (url.pathname === '/api/knowledge/drafts') {
      const body = route.request().postDataJSON();
      writes.push(body);
      return route.fulfill({
        json: {
          draft: {
            id: 'fixture-draft',
            title: body.title,
            baseRevision: 'r1',
            version: 1,
            state: 'draft',
            updatedAt: '2026-10-09T12:00:00Z',
            documents: body.documents.map((document: { path: string; content: string }) => ({
              ...document,
              base: original,
            })),
          },
        },
      });
    }
    if (new URL(route.request().url()).pathname === '/api/service-health')
      return route.fulfill({
        json: { services: [{ name: 'yapper', ok: true, detail: { tts: true } }], checkedAt: 0 },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto('/knowledge');
  await editKnowledgeDocument(page, 'hub/principles.md', 'Working principles');
  const source = page.getByRole('textbox', { name: 'Document source' });
  if (isMobile) await expect(source).toHaveJSProperty('tagName', 'TEXTAREA');
  else await expect(source).toHaveAttribute('contenteditable', 'true');
  expect((await source.boundingBox())!.height).toBeGreaterThan(isMobile ? 44 : 200);
  const draft = '# Revised principles\n\nMy working copy.';
  await source.fill(draft);
  await page.screenshot({
    path: testInfo.outputPath(isMobile ? 'knowledge-mobile.png' : 'knowledge-desktop.png'),
  });
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Revised principles', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Fullscreen document editor' });
  expect((await source.boundingBox())!.height).toBeGreaterThan(isMobile ? 44 : 200);
  await expect(modal.getByRole('button', { name: 'Save draft', exact: true })).toBeInViewport();
  await modal.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(modal).toContainText('Draft saved');
  await expectSource(source, draft);
  expect(writes[0]).toMatchObject({
    baseRevision: 'r1',
    documents: [{ path: 'hub/principles.md', content: draft }],
  });
  await page.screenshot({ path: testInfo.outputPath('knowledge-fullscreen.png') });
  await modal.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await expectSource(source, draft);
});

test('adopting a same-content saved Knowledge draft clears obsolete Vim undo history', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'CodeMirror conflict history');
  const path = 'hub/principles.md';
  const original = '# Original principles';
  const content = '# My principles';
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/knowledge')
      return route.fulfill({
        json: {
          revision: 'r1',
          documents: [{ path, title: 'Working principles', area: 'Hub' }],
          directories: ['hub'],
          documentPaths: ['hub'],
          drafts: [],
          reviewEnabled: false,
          acceptanceEnabled: false,
          syncedAt: null,
        },
      });
    if (url.pathname === '/api/knowledge/document')
      return route.fulfill({ json: { path, revision: 'r1', content: original } });
    if (url.pathname === '/api/knowledge/drafts')
      return route.fulfill({
        json: {
          draft: {
            id: 'fixture-newer-draft',
            title: 'Working principles',
            baseRevision: 'r1',
            version: 2,
            state: 'draft',
            updatedAt: '2026-10-09T12:00:00Z',
            documents: [{ path, content, base: original }],
          },
        },
      });
    if (new URL(route.request().url()).pathname === '/api/service-health')
      return route.fulfill({
        json: { services: [{ name: 'yapper', ok: true, detail: { tts: true } }], checkedAt: 0 },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto('/knowledge');
  await editKnowledgeDocument(page, 'hub/principles.md', 'Working principles');
  const source = page.getByRole('textbox', { name: 'Document source' });
  await source.fill(content);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Compare saved draft' })).toBeVisible();
  await page.getByRole('button', { name: 'Use saved draft', exact: true }).click();
  await expectSource(source, content);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Vim', exact: true }).click();
  await expect(source).toBeFocused();
  await source.press('u');
  await expectSource(source, content);
});

test('folder-only saved Knowledge conflicts show both organizations before replacement', async ({
  page,
}) => {
  const remote = {
    id: 'fixture-folder-draft',
    title: 'Folder change',
    baseRevision: 'r1',
    version: 2,
    state: 'draft',
    updatedAt: '2026-10-10T00:00:00Z',
    documents: [],
    directories: ['hub/saved-folder'],
  };
  await page.addInitScript((draft) => {
    localStorage.setItem(
      'mitzo-knowledge-working-copy:',
      JSON.stringify({
        title: draft.title,
        baseRevision: 'r1',
        documents: [],
        directories: ['hub/local-folder'],
        selected: '',
        saved: '[]',
        savedDirectories: [],
        initialSaveConflict: draft,
      }),
    );
  }, remote);
  const writes: Record<string, unknown>[] = [];
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/knowledge')
      return route.fulfill({
        json: {
          revision: 'r1',
          documents: [],
          directories: ['hub'],
          documentPaths: ['hub'],
          drafts: [],
          reviewEnabled: false,
          acceptanceEnabled: false,
          syncedAt: null,
        },
      });
    if (url.pathname === '/api/knowledge/drafts/fixture-folder-draft') {
      const body = route.request().postDataJSON();
      writes.push(body);
      return route.fulfill({
        json: { draft: { ...remote, version: 3, directories: body.directories } },
      });
    }
    if (new URL(route.request().url()).pathname === '/api/service-health')
      return route.fulfill({
        json: { services: [{ name: 'yapper', ok: true, detail: { tts: true } }], checkedAt: 0 },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto('/knowledge');
  const comparison = page.getByRole('region', { name: 'Compare saved draft and working copy' });
  await expect(comparison).toHaveCount(0);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(comparison).toBeVisible();
  await expect(comparison.getByRole('region', { name: 'Saved draft organization' })).toContainText(
    'hub/saved-folder',
  );
  await expect(
    comparison.getByRole('region', { name: 'Your working copy organization' }),
  ).toContainText('hub/local-folder');
  await comparison.getByRole('button', { name: 'Keep my edits and update saved draft' }).click();
  await expect(comparison).toHaveCount(0);
  expect(writes).toEqual([
    { version: 2, baseRevision: 'r1', documents: [], directories: ['hub/local-folder'] },
  ]);
});

test('desktop Markdown syntax remains readable in light and dark source themes', async ({
  page,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, 'CodeMirror syntax colors');
  await mockDocument(
    page,
    '# Source heading\n\n[Related note](https://example.test)\n\n**Strong text** and `inline code`.',
  );
  const source = page.getByRole('textbox', { name: 'Document source' });
  await expect(source).toHaveAttribute('contenteditable', 'true');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const colors = await source.evaluate((element) => {
      const background = getComputedStyle(element.closest('.cm-editor')!).backgroundColor;
      const luminance = (color: string) => {
        const parts = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
        return parts[0] * 0.2126 + parts[1] * 0.7152 + parts[2] * 0.0722;
      };
      const bg = luminance(background);
      return Array.from(element.querySelectorAll('.cm-line span')).map((span) => {
        const foreground = getComputedStyle(span).color;
        const fg = luminance(foreground);
        return {
          text: span.textContent,
          foreground,
          background,
          ratio: (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05),
        };
      });
    });
    await page.screenshot({ path: testInfo.outputPath(`desktop-source-${theme}.png`) });
    await testInfo.attach(`source-colors-${theme}`, {
      body: JSON.stringify(colors, null, 2),
      contentType: 'application/json',
    });
    expect(colors.length).toBeGreaterThan(0);
    const layout = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const variables = Object.fromEntries(
        ['--bg', '--text', '--color-bg', '--bg-primary', '--text-primary', '--surface'].map(
          (name) => [name, root.getPropertyValue(name).trim()],
        ),
      );
      const styles = Object.fromEntries(
        [
          '.viewer-page',
          '.viewer-content--editing',
          '.document-editor-dialog',
          '.document-editor',
          '.document-editor-panes',
          '.document-editor-source',
          '.document-editor-toolbar button',
        ].map((selector) => {
          const element = document.querySelector(selector)!;
          const style = getComputedStyle(element);
          const { x, y, width, height } = element.getBoundingClientRect();
          return [
            selector,
            {
              x,
              y,
              width,
              height,
              display: style.display,
              flex: style.flex,
              flexDirection: style.flexDirection,
              alignItems: style.alignItems,
              color: style.color,
              background: style.backgroundColor,
            },
          ];
        }),
      );
      return { variables, styles };
    });
    await writeFile(
      testInfo.outputPath(`source-diagnostics-${theme}.json`),
      JSON.stringify({ colors, layout }, null, 2),
    );
    for (const color of colors)
      expect(color.ratio, `${theme} syntax ${color.text}`).toBeGreaterThanOrEqual(4.5);
  }
});

test('the desktop Files source pane fills the available editor workspace', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'Desktop editor workspace layout');
  await mockDocument(page, '# Report\n\nA short document.');
  const source = page.getByRole('textbox', { name: 'Document source' });
  await expect(source).toHaveAttribute('contenteditable', 'true');
  const sourceBounds = (await source.boundingBox())!;
  const workspaceBounds = (await page.locator('.viewer-content--editing').boundingBox())!;
  expect(sourceBounds.height).toBeGreaterThan(workspaceBounds.height * 0.65);
});

test('fullscreen Knowledge comparisons scroll independently and preserve space for editing', async ({
  page,
}, testInfo) => {
  const documents = [
    { path: 'hub/principles.md', title: 'Working principles', area: 'Hub' },
    { path: 'teams/release.md', title: 'Release process', area: 'Teams' },
  ];
  let comparing = false;
  let saves = 0;
  let savedDraft: Record<string, unknown> | undefined;
  const writes: Record<string, unknown>[] = [];
  const catalog = () => ({
    revision: comparing ? 'r2' : 'r1',
    documents,
    directories: ['hub', 'teams'],
    documentPaths: ['hub', 'teams'],
    drafts: [],
    reviewEnabled: false,
    acceptanceEnabled: false,
    syncedAt: null,
  });
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/knowledge') return route.fulfill({ json: catalog() });
    if (url.pathname === '/api/knowledge/refresh') {
      comparing = true;
      return route.fulfill({ json: catalog() });
    }
    if (url.pathname === '/api/knowledge/document') {
      const path = url.searchParams.get('path')!;
      const content = comparing
        ? '# Updated accepted knowledge\n' +
          Array.from({ length: 250 }, (_, index) => `${path} accepted line ${index + 1}`).join('\n')
        : '# Original';
      return route.fulfill({ json: { path, revision: comparing ? 'r2' : 'r1', content } });
    }
    if (url.pathname === '/api/knowledge/drafts') {
      const body = route.request().postDataJSON();
      writes.push(body);
      if (++saves === 1)
        return route.fulfill({ status: 409, json: { error: 'Accepted knowledge changed.' } });
      savedDraft = {
        id: 'fixture-comparison-draft',
        title: body.title,
        baseRevision: body.baseRevision,
        version: 1,
        state: 'draft',
        updatedAt: '2026-10-09T12:00:00Z',
        documents: body.documents.map((document: { path: string; content: string }) => ({
          ...document,
          base: '# Updated accepted knowledge',
        })),
      };
      return route.fulfill({ json: { draft: savedDraft } });
    }
    if (url.pathname.endsWith('/review')) return route.fulfill({ json: { draft: savedDraft } });
    if (new URL(route.request().url()).pathname === '/api/service-health')
      return route.fulfill({
        json: { services: [{ name: 'yapper', ok: true, detail: { tts: true } }], checkedAt: 0 },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto('/knowledge');
  await editKnowledgeDocument(page, 'hub/principles.md', 'Working principles');
  const source = page.getByRole('textbox', { name: 'Document source' });
  await source.fill('# My principles draft');
  await page.getByRole('button', { name: '+ Add document', exact: true }).click();
  await selectKnowledgeDocument(page, 'teams/release.md');
  await source.fill('# My release draft');
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Fullscreen document editor' });
  await modal.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(modal).toContainText('Accepted knowledge changed.');
  await modal.getByRole('button', { name: 'Compare accepted version', exact: true }).click();
  const comparison = modal.getByRole('region', { name: 'Compare accepted and draft' });
  await expect(comparison).toContainText('hub/principles.md');
  await expect(comparison).toContainText('teams/release.md');
  const feedback = modal.locator('.document-editor-fullscreen-status');
  expect((await feedback.boundingBox())!.height).toBeLessThanOrEqual(
    (await modal.boundingBox())!.height * 0.35 + 1,
  );
  expect((await source.boundingBox())!.height).toBeGreaterThan(44);
  expect(await feedback.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  await feedback.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const keep = modal.getByRole('button', { name: 'Keep my draft and save', exact: true });
  await expect(keep).toBeInViewport();
  await keep.click({ trial: true });
  await page.screenshot({ path: testInfo.outputPath('knowledge-large-comparison.png') });
  await keep.click();
  await expect(modal).toContainText('Draft saved');
  await expectSource(source, '# My release draft');
  expect(writes.at(-1)).toMatchObject({
    documents: [
      { path: 'hub/principles.md', content: '# My principles draft' },
      { path: 'teams/release.md', content: '# My release draft' },
    ],
  });
  // An uncertain initial creation keeps its request identity on retry.
  expect(writes.at(-1)?.requestId).toBe(writes[0].requestId);
  await expect(modal.getByRole('alert')).toHaveCount(0);
});

test('Knowledge reload lands on the Library and resumes the recovered copy only explicitly', async ({
  page,
}) => {
  const path = 'hub/voice-guide.md';
  const content = '# Voice guide\n\nKeep the recovered working copy.';
  const savedDocuments = [{ path, base: '# Accepted voice guide', content: '# Saved voice guide' }];
  const recovered = {
    title: 'Voice guide',
    baseRevision: 'r1',
    documents: [{ path, base: '# Accepted voice guide', content }],
    directories: ['hub/pending-guides'],
    selected: path,
    saved: JSON.stringify(savedDocuments),
    savedDirectories: [],
    draft: {
      id: 'fixture-recovered-copy',
      title: 'Voice guide',
      baseRevision: 'r1',
      version: 2,
      state: 'draft',
      documents: savedDocuments,
      updatedAt: '2026-10-09T12:00:00Z',
    },
    pendingCreate: {
      requestId: 'f95608ac-c6d4-4f2b-845b-313c70a19f8c',
      title: 'Voice guide',
      baseRevision: 'r1',
      documents: [{ path, content }],
      directories: ['hub/pending-guides'],
    },
  };
  const serialized = JSON.stringify(recovered);
  const authoringRequests: string[] = [];
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET') authoringRequests.push(url.pathname);
    if (url.pathname === '/api/knowledge')
      return route.fulfill({
        json: {
          revision: 'r1',
          documents: [{ path, title: 'Voice guide', area: 'Hub' }],
          directories: ['hub'],
          documentPaths: ['hub'],
          drafts: [],
          reviewEnabled: false,
          acceptanceEnabled: false,
          syncedAt: null,
        },
      });
    if (url.pathname === '/api/knowledge/document')
      return route.fulfill({ json: { path, revision: 'r1', content: '# Accepted voice guide' } });
    if (new URL(route.request().url()).pathname === '/api/service-health')
      return route.fulfill({
        json: { services: [{ name: 'yapper', ok: true, detail: { tts: true } }], checkedAt: 0 },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto('/knowledge');
  await page.evaluate(
    (copy) => localStorage.setItem('mitzo-knowledge-working-copy:', copy),
    serialized,
  );
  await page.reload();
  const source = page.getByRole('textbox', { name: 'Document source' });
  await expect(page.getByRole('button', { name: 'Folder hub', exact: true })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search knowledge' })).toBeVisible();
  await expect(source).toHaveCount(0);
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('mitzo-knowledge-working-copy:'))).toBe(
    serialized,
  );
  await selectKnowledgeDocument(page, path);
  await expect(page.getByRole('article', { name: 'Voice guide' })).toContainText(
    'Keep the recovered working copy.',
  );
  await expect(source).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('mitzo-knowledge-working-copy:'))).toBe(
    serialized,
  );
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByRole('button', { name: 'Resume editing', exact: true }).click();
  await expectSource(source, content);
  expect(await page.evaluate(() => localStorage.getItem('mitzo-knowledge-working-copy:'))).toBe(
    serialized,
  );
  expect(authoringRequests).toEqual([]);
});

// These controls are shared by Files and Knowledge. Assert user-visible geometry
// and accessibility so a route-wide button rule cannot turn them back into boxes.
async function editorControlStyles(button: Locator) {
  return button.evaluate((element) => {
    const style = getComputedStyle(element);
    const { width, height } = element.getBoundingClientRect();
    return {
      width,
      height,
      borderWidth: style.borderTopWidth,
      borderStyle: style.borderTopStyle,
      fontFamily: style.fontFamily,
      color: style.color,
      background: style.backgroundColor,
    };
  });
}

async function mockKnowledgeEditor(page: Page) {
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/knowledge')
      return route.fulfill({
        json: {
          revision: 'r1',
          documents: [{ path: 'hub/principles.md', title: 'Working principles', area: 'Hub' }],
          directories: ['hub'],
          documentPaths: ['hub'],
          drafts: [],
          reviewEnabled: false,
          acceptanceEnabled: false,
          syncedAt: null,
        },
      });
    if (url.pathname === '/api/knowledge/document')
      return route.fulfill({
        json: {
          path: 'hub/principles.md',
          revision: 'r1',
          content:
            '# Working principles\n\nKeep the document at the centre of the workspace.\n\n- Group related actions.\n- Keep editing and preview within reach.',
        },
      });
    if (new URL(route.request().url()).pathname === '/api/service-health')
      return route.fulfill({
        json: { services: [{ name: 'yapper', ok: true, detail: { tts: true } }], checkedAt: 0 },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto('/knowledge');
  await editKnowledgeDocument(page, 'hub/principles.md', 'Working principles');
}

test('grouped editor keeps every action reachable with compact desktop and touch mobile controls', async ({
  page,
  isMobile,
  browserName,
}, testInfo) => {
  if (isMobile) await page.setViewportSize({ width: 320, height: 740 });
  await mockDocument(page, 'alpha');
  if (!isMobile) {
    const home = page.getByRole('button', { name: 'Home', exact: true });
    const iconBounds = (await home.getByRole('img', { name: 'Mitzo', exact: true }).boundingBox())!;
    const buttonBounds = (await home.boundingBox())!;
    expect(iconBounds.width).toBeLessThanOrEqual(buttonBounds.width);
    expect(iconBounds.height).toBeLessThanOrEqual(buttonBounds.height);
  }
  const editor = page.getByRole('region', { name: 'Document editor', exact: true });
  for (const name of [
    'Editor view',
    'Editing keys',
    'Edit history',
    'Markdown formatting',
    'Document actions',
  ])
    await expect(editor.getByRole('group', { name, exact: true })).toBeVisible();
  const controls = [
    'Source',
    'Preview',
    'Split',
    'Standard',
    'Vim',
    'Undo',
    'Redo',
    'Bold',
    'Italic',
    'Inline code',
    'Heading',
    'List',
    'Link',
    'Fullscreen',
    ...(isMobile ? [] : ['Relative line numbers']),
  ];
  for (const name of controls) {
    const button = editor.getByRole('button', { name, exact: true });
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport();
    const style = await editorControlStyles(button);
    expect(style.borderStyle === 'none' || parseFloat(style.borderWidth) === 0, name).toBe(true);
    if (isMobile) {
      expect(style.height, name).toBeGreaterThanOrEqual(44);
      expect(style.width, name).toBeGreaterThanOrEqual(44);
    } else {
      expect(style.height, name).toBeGreaterThanOrEqual(28);
      expect(style.height, name).toBeLessThanOrEqual(36);
    }
  }
  // Narrow layouts may wrap groups or scroll the tools, but must not widen the page.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const source = page.getByRole('textbox', { name: 'Document source' });
  expect((await source.boundingBox())!.height).toBeGreaterThan(44);
  await source.fill('changed');
  for (const name of ['Save', 'Discard']) {
    const button = page.getByRole('button', { name, exact: true });
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport();
    await button.click({ trial: true });
    if (isMobile) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  // Disabled history controls stay discoverable; enabled controls remain keyboard actions.
  await editor.getByRole('button', { name: 'Bold', exact: true }).focus();
  // Safari's default preference includes buttons in sequential focus with Option-Tab.
  await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
  const italic = editor.getByRole('button', { name: 'Italic', exact: true });
  await expect(italic).toBeFocused();
  expect(
    await italic.evaluate((element) => parseFloat(getComputedStyle(element).outlineWidth)),
  ).toBeGreaterThan(0);
  expect(
    await italic.evaluate((element) => getComputedStyle(element, '::after').content),
  ).toContain('Italic');
  expect(await italic.evaluate((element) => getComputedStyle(element, '::after').display)).toBe(
    'block',
  );
  await page.screenshot({
    path: testInfo.outputPath(isMobile ? 'grouped-editor-320.png' : 'grouped-editor-focus.png'),
  });
  page.on('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(source).toHaveCount(0);
  for (const name of ['Edit', 'Read', 'Share file', 'Download file']) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeInViewport();
    await button.click({ trial: true });
    if (isMobile) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expectSource(source, 'alpha');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(source).toHaveCount(0);
});

test('all grouped Markdown formatting actions preserve selection and undo behavior', async ({
  page,
}) => {
  await mockDocument(page, 'alpha');
  const source = page.getByRole('textbox', { name: 'Document source' });
  const expected = [
    ['Bold', '**alpha**'],
    ['Italic', '_alpha_'],
    ['Inline code', '`alpha`'],
    ['Heading', '## alpha'],
    ['List', '- alpha'],
    ['Link', '[alpha](https://)'],
  ];
  for (const [name, formatted] of expected) {
    await source.focus();
    await source.press('ControlOrMeta+a');
    await page.getByRole('button', { name, exact: true }).click();
    await expectSource(source, formatted);
    await expect(source).toBeFocused();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expectSource(source, 'alpha');
  }
});

test('Files and Knowledge share quiet controls across themes and appearance preferences', async ({
  page,
  isMobile,
}, testInfo) => {
  if (isMobile) await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const appearances = [
    { theme: 'dark', accent: 'lavender', font: 'system' },
    { theme: 'light', accent: 'teal', font: 'georgia' },
  ];
  const styles: Record<string, Awaited<ReturnType<typeof editorControlStyles>>> = {};
  for (const route of ['files', 'knowledge']) {
    if (route === 'files')
      await mockDocument(
        page,
        '# Working principles\n\nKeep the document at the centre of the workspace.\n\n- Group related actions.\n- Keep editing and preview within reach.',
      );
    else await mockKnowledgeEditor(page);
    for (const appearance of appearances) {
      await page.evaluate(({ theme, accent, font }) => {
        Object.assign(document.documentElement.dataset, { theme, accent, font });
      }, appearance);
      const key = `${appearance.theme}-${appearance.accent}-${appearance.font}`;
      const sourceButton = page.getByRole('button', { name: 'Source', exact: true });
      await expect(sourceButton).toHaveAttribute('aria-pressed', 'true');
      const bold = page.getByRole('button', { name: 'Bold', exact: true });
      const actual = await editorControlStyles(bold);
      const fonts = await page
        .getByRole('textbox', { name: 'Document source' })
        .evaluate((element) => {
          const root = getComputedStyle(document.documentElement);
          return {
            source: getComputedStyle(element).fontFamily,
            mono: root.getPropertyValue('--font-mono').trim(),
            ui: root.getPropertyValue('--font-ui').trim(),
          };
        });
      // Font stacks may normalize quote marks when read as computed font-family.
      const normalized = (value: string) =>
        value
          .replace(/BlinkMacSystemFont/g, 'system-ui')
          .replace(/["']/g, '')
          .replace(/\s+/g, '');
      expect(normalized(actual.fontFamily)).toBe(normalized(fonts.ui));
      expect(normalized(fonts.source)).toBe(normalized(fonts.mono));
      if (route === 'files') styles[key] = actual;
      else expect(actual).toEqual(styles[key]);
      await page.getByRole('button', { name: 'Split', exact: true }).click();
      await page.screenshot({ path: testInfo.outputPath(`grouped-${route}-${key}.png`) });
      await page.getByRole('button', { name: 'Source', exact: true }).click();
    }
  }
});
