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
  page.on('pageerror', (error) => errors.push(error.message));
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (url.pathname.startsWith('/api/')) {
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
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.getByRole('button', { name: 'Publish revision', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Use in chat', exact: true })).toHaveAttribute(
    'href',
    '/chat?agentProfile=bob&profileRevision=4',
  );
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
  expect(errors).toEqual([]);
});
