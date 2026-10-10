import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { AgentLibraryCatalog, AgentLibraryDraft, AgentLibraryVersion } from '@mitzo/protocol';

test.use({ baseURL: 'https://mitzo-ui.test' });
test('edits and publishes named agents while preserving Agents navigation', async ({
  page,
  isMobile,
}, testInfo) => {
  const definition = {
    name: 'Bob',
    descriptor: 'The architect',
    description: 'Challenge designs and make tradeoffs explicit.',
    role: 'reviewer',
    instructions: 'Challenge assumptions. Compare viable options.',
    expectedOutput: 'Decision brief',
    acceptanceCriteria: ['Cite evidence'],
    modelPolicyRole: 'reviewer',
  };
  const catalog: AgentLibraryCatalog = {
    drafts: [],
    versions: [{ profileId: 'bob', revision: 3, definition, contentHash: 'a'.repeat(64) }],
  };
  const errors: string[] = [];
  let catalogMode: 'content' | 'empty' | 'error' | 'loading' = 'content';
  let releaseCatalog: (() => void) | undefined;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/agent-library') {
        if (catalogMode === 'loading')
          await new Promise<void>((resolve) => {
            releaseCatalog = resolve;
          });
        if (catalogMode === 'error')
          return route.fulfill({ status: 503, json: { error: 'Offline Library unavailable' } });
        return route.fulfill({
          json: catalogMode === 'empty' ? { drafts: [], versions: [] } : catalog,
        });
      }
      if (url.pathname.endsWith('/events'))
        return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
      if (url.pathname === '/api/agent-library/drafts') {
        const body = route.request().postDataJSON();
        const draft: AgentLibraryDraft = {
          profileId: body.profileId,
          version: 1,
          baseRevision: body.expectedRevision,
          definition: body.definition,
        };
        catalog.drafts = [draft];
        return route.fulfill({ json: draft });
      }
      if (url.pathname === '/api/agent-library/publish') {
        const draft = catalog.drafts[0];
        const version: AgentLibraryVersion = {
          profileId: draft.profileId,
          revision: draft.baseRevision + 1,
          definition: draft.definition,
          contentHash: 'b'.repeat(64),
        };
        catalog.drafts = [];
        catalog.versions.unshift(version);
        return route.fulfill({ json: version });
      }
      if (/^\/api\/agent-library\/.+\/\d+\/export$/.test(url.pathname))
        return route.fulfill({ json: catalog.versions[0] });
      if (route.request().method() !== 'GET')
        return route.fulfill({
          status: 405,
          json: { error: 'Offline fixture: no model or runtime execution' },
        });
      const fixtures: Record<string, unknown> = {
        '/api/auth/check': { authenticated: true },
        '/api/agent-library': catalog,
        '/api/config': { quickActions: [], models: [], mcpServers: [] },
        '/api/notifications': { items: [], needsYou: 0, unread: 0, total: 0, hasMore: false },
        '/api/sessions': { sessions: [], hasMore: false },
        '/api/accounts': [],
        '/api/service-health': { services: [], checkedAt: Date.now() },
      };
      return route.fulfill({ json: fixtures[url.pathname] ?? {} });
    }
    const root = resolve('frontend/dist');
    const file =
      url.pathname.startsWith('/assets/') || extname(url.pathname)
        ? url.pathname.slice(1)
        : 'index.html';
    const path = resolve(root, file);
    if (!path.startsWith(root + '/')) return route.abort();
    const mime: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.woff2': 'font/woff2',
    };
    try {
      return route.fulfill({
        body: await readFile(path),
        contentType: mime[extname(path)] ?? 'application/octet-stream',
      });
    } catch {
      return route.fulfill({ status: 404, body: 'Missing offline asset' });
    }
  });
  await page.goto('/agent-library');
  await expect(page.getByRole('heading', { name: 'Agent Library', exact: true })).toBeVisible();
  await expect(page.getByLabel('Agent name')).toHaveValue('Bob');
  await expect(page.getByLabel('Descriptor')).toHaveValue('The architect');
  await page.screenshot({ path: testInfo.outputPath('agent-library.png'), fullPage: true });
  await page.getByLabel('Agent name').fill('Robert');
  await page.getByLabel('Descriptor').fill('The systems architect');
  await expect(page.getByRole('link', { name: 'Use in chat', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: isMobile ? 'More' : 'Today', exact: true }).click();
  await page.goBack();
  await expect(page.getByLabel('Agent name')).toHaveValue('Robert');
  await expect(page.getByLabel('Descriptor')).toHaveValue('The systems architect');
  page.once('dialog', (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByLabel('Agent name')).toHaveValue('Robert');
  await expect(page.getByLabel('Descriptor')).toHaveValue('The systems architect');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.getByRole('button', { name: 'Publish revision', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Use in chat', exact: true })).toHaveAttribute(
    'href',
    '/chat?agentProfile=bob&profileRevision=4',
  );
  await page.getByLabel('Agent name').fill('Working Robert');
  catalog.versions.unshift({
    ...catalog.versions[0],
    revision: 5,
    definition: { ...catalog.versions[0].definition, name: 'Remote Robert' },
  });
  page.once('dialog', (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByLabel('Agent name')).toHaveValue('Working Robert');
  await expect(page.getByLabel('Agent name')).toBeEnabled();
  await page.getByRole('button', { name: 'Discard unsaved edits', exact: true }).click();
  await expect(page.getByLabel('Agent name')).toHaveValue('Remote Robert');
  catalog.versions.shift();
  await page.reload();
  await page.getByRole('button', { name: 'Export profile', exact: true }).click();
  await expect(page.getByLabel('Portable profile export')).toContainText('The systems architect');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  if (isMobile) {
    await expect(page.getByRole('link', { name: 'More', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.getByRole('link', { name: 'More', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Agent taskboard', exact: true })).toHaveAttribute(
      'href',
      '/tasks',
    );
    await expect(page.getByRole('link', { name: 'Agent Library', exact: true })).toHaveAttribute(
      'href',
      '/agent-library',
    );
  } else {
    await expect(page.getByRole('link', { name: 'Agents', exact: true })).toHaveAttribute(
      'href',
      '/tasks',
    );
  }
  if (isMobile) await page.setViewportSize({ width: 320, height: 844 });
  for (const theme of ['light', 'dark']) {
    for (const [accent, font] of [
      ['lavender', 'system'],
      ['teal', 'georgia'],
    ]) {
      await page.evaluate(
        ({ theme, accent, font }) => {
          localStorage.setItem('mitzo-theme', theme);
          localStorage.setItem('mitzo-accent', accent);
          localStorage.setItem('mitzo-font', font);
        },
        { theme, accent, font },
      );
      await page.goto('/agent-library');
      await expect(page.getByLabel('Agent name')).toHaveValue('Robert');
      if (isMobile) {
        await expect(page.locator('.mobile-workspace-masthead')).toBeVisible();
        expect(
          await page
            .getByLabel('Search agents')
            .evaluate((element) => element.getBoundingClientRect().width),
        ).toBeGreaterThanOrEqual(224);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        await page
          .getByLabel('Agent name')
          .evaluate((element) => element.getBoundingClientRect().height),
      ).toBeGreaterThanOrEqual(44);
      if (font === 'georgia')
        expect(
          await page
            .getByLabel('Agent name')
            .evaluate((element) => getComputedStyle(element).fontFamily),
        ).toContain('Georgia');
      await page
        .getByRole('button', { name: 'Use as reviewer', exact: true })
        .scrollIntoViewIfNeeded();
      await expect(
        page.getByRole('button', { name: 'Use as reviewer', exact: true }),
      ).toBeInViewport();
      await page.screenshot({
        path: testInfo.outputPath(`agent-library-${theme}-${accent}-${font}.png`),
        fullPage: true,
      });
    }
  }
  const savedIdentity = {
    name: catalog.versions[0].definition.name,
    description: catalog.versions[0].definition.description,
  };
  catalog.versions[0].definition.name = 'B'.repeat(80);
  catalog.versions[0].definition.description = 'Compare designs and document evidence. '.repeat(10);
  await page.reload();
  await expect(page.getByLabel('Agent name')).toHaveValue('B'.repeat(80));
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '20px';
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Use as reviewer', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Use as reviewer', exact: true })).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath('agent-library-large-text.png'),
    fullPage: true,
  });
  Object.assign(catalog.versions[0].definition, savedIdentity);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
  catalogMode = 'empty';
  await page.reload();
  await expect(page.getByText('Create your first agent, or start with the advisor.')).toBeVisible();
  catalogMode = 'error';
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Offline Library unavailable');
  catalogMode = 'loading';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('status')).toContainText('Loading Agent Library');
  await expect.poll(() => typeof releaseCatalog).toBe('function');
  catalogMode = 'content';
  releaseCatalog!();
  await expect(page.getByLabel('Agent name')).toHaveValue('Robert');
  await page.goto('/chat');
  await page.getByRole('button', { name: /^Workspace controls/ }).click();
  const profilePicker = page.getByRole('combobox', { name: 'Agent profile', exact: true });
  await expect(profilePicker).toBeVisible();
  await expect(profilePicker).toBeEnabled();
  expect(
    await profilePicker.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44);
  await profilePicker.focus();
  await expect(profilePicker).toBeFocused();
  expect(errors).toEqual([]);
});
