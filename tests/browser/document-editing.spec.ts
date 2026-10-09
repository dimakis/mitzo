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

async function mockDocument(page: Page, content: string) {
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
    await page.locator('.viewer-header-action--save').evaluate((element) => {
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
}) => {
  const writes = await mockDocument(page, '# Original');
  await page.route('**/api/files/write', (route) =>
    route.fulfill({ status: 409, json: { error: 'File changed elsewhere.' } }),
  );
  await page.route('**/api/files/read?**', (route) =>
    route.fulfill({ json: { path: 'report.md', ext: '.md', content: '# Agent update' } }),
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
  await modal.getByRole('button', { name: 'Keep my draft for next save' }).click();
  await expectSource(source, '# My fullscreen draft');
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
    expectedContent: '# Agent update',
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
    return route.fulfill({ json: {} });
  });
  await page.goto('/knowledge');
  await page.getByRole('button', { name: /Working principles/ }).click();
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
  await expect(modal.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
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
    const pageBackground = await page
      .locator('.viewer-page')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await expect
      .poll(() =>
        page
          .getByRole('button', { name: 'Source', exact: true })
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .toBe(pageBackground);
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
