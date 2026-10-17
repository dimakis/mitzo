import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { AgentToolCatalogEntry } from '@mitzo/protocol';
const catalogFixture: AgentToolCatalogEntry[] = JSON.parse(
  readFileSync(new URL('../fixtures/agent-tool-catalog.json', import.meta.url), 'utf8'),
);
import { deployedSecurityHeaders } from '../support/response-security';
import type { AgentLibraryCatalog, AgentLibraryDraft, AgentLibraryVersion } from '@mitzo/protocol';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/agent-tool-selection.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/agent-tool-selection.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});
test.use({ baseURL: 'https://mitzo-ui.test' });
for (const theme of ['dark', 'light'])
  test(`configured tools: discovery retry, source distinction, selection and export (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const compiled = await bundle;
    const catalog: AgentLibraryCatalog = {
      drafts: [],
      versions: [
        {
          profileId: 'limited',
          revision: 1,
          contentHash: 'a'.repeat(64),
          definition: {
            name: 'Library reader',
            descriptor: 'Checks evidence',
            role: 'agent',
            instructions: 'Read and cite.',
            expectedOutput: 'Brief',
            acceptanceCriteria: ['Evidence'],
            modelPolicyRole: 'agent',
          },
        },
      ],
    };
    const toolFailure = false;
    let discovered = false;
    let refreshes = 0;
    let toolReads = 0;
    let releaseCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    let releaseFirstRead!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let releaseDiscovery!: () => void;
    const waiting = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const configured = ['Docs one', 'Docs two'].map((source, i) => ({
      ...catalogFixture[0],
      id: `mcp:${i === 0 ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222'}:${'a'.repeat(64)}`,
      version: 1,
      revision: '33333333-3333-4333-8333-333333333333',
      name: 'search',
      required: false,
      behavior: 'mixed' as const,
      description: 'Search configured documents',
      source,
      routes: ['local-api'],
      requirement: 'New session required after changing selections; existing approvals apply.',
    }));
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    await page.emulateMedia({ colorScheme: theme as 'dark' | 'light', reducedMotion: 'reduce' });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://mitzo-ui.test') return route.abort();
      if (url.pathname === '/fixture.js' || url.pathname === '/fixture.css')
        return route.fulfill({
          body: compiled.outputFiles!.find((file) =>
            file.path.endsWith(url.pathname.endsWith('.js') ? '.js' : '.css'),
          )!.text,
          contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css',
        });
      if (url.pathname === '/api/agent-library') return route.fulfill({ json: catalog });
      if (url.pathname === '/api/agent-library/tools/refresh') {
        expect(route.request().method()).toBe('POST');
        expect(route.request().postDataJSON()).toEqual({});
        const attempt = ++refreshes;
        if (attempt === 1)
          return route.fulfill({ status: 503, json: { error: 'Discovery fixture unavailable' } });
        await waiting;
        if (attempt === 4) await cancellation;
        discovered = true;
        const refreshed = configured.map((tool, i) =>
          attempt >= 3 && i === 0
            ? {
                ...tool,
                routes: [],
                requirement: 'Configured source disabled; new session required.',
              }
            : tool,
        );
        return route
          .fulfill({ json: { tools: [...catalogFixture, ...refreshed] } })
          .catch(() => {});
      }
      if (url.pathname === '/api/agent-library/tools') {
        if (++toolReads === 1) await firstRead;
        return route.fulfill(
          toolFailure
            ? { status: 503, json: { error: 'Tool catalog unavailable' } }
            : {
                json: {
                  tools: [...catalogFixture, ...(discovered ? configured : [])].map((tool) => ({
                    ...tool,
                    requirement: [
                      'ConnectionRequest',
                      'ConnectionWebSocket',
                      'HomeAssistantDashboard',
                      'RequestConnectionAccess',
                    ].includes(tool.name)
                      ? 'No active service connection is configured. Set one up in Connections.'
                      : tool.requirement,
                  })),
                },
              },
        );
      }
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
          revision: 2,
          contentHash: 'b'.repeat(64),
          definition: draft.definition,
        };
        catalog.drafts = [];
        catalog.versions.unshift(version);
        return route.fulfill({ json: version });
      }
      if (url.pathname.endsWith('/export')) return route.fulfill({ json: catalog.versions[0] });
      if (url.pathname === '/api/agent-tasks') return route.fulfill({ json: [] });
      if (url.pathname.startsWith('/api/'))
        return route.fulfill({
          json: { accounts: [], models: [], sessions: [], drafts: [], versions: [] },
        });
      return route.fulfill({
        contentType: 'text/html',
        headers: deployedSecurityHeaders(),
        body: `<html data-theme="${theme}" data-accent="${theme === 'dark' ? 'lavender' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Tool library', exact: true }).click();
    const refresh = page.getByRole('button', { name: 'Refresh configured servers', exact: true });
    await refresh.click();
    await expect(page.getByRole('alert')).toContainText('Discovery fixture unavailable');
    releaseFirstRead();
    await expect(page.getByRole('heading', { name: 'Read', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Retry discovery', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Refreshing configured servers' }),
    ).toBeVisible();
    releaseDiscovery();
    await expect(page.getByRole('heading', { name: 'search', exact: true })).toHaveCount(2);
    await page.getByLabel('Category', { exact: true }).selectOption('Docs one');
    const card = page
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { name: 'search', exact: true }) });
    await card.locator('.tool-library-details > summary').click();
    await expect(card).toContainText('New session required');
    await page.screenshot({
      path: info.outputPath(`configured-library-${theme}.png`),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Agent library', exact: true }).click();
    await page.getByRole('tab', { name: 'Tools', exact: true }).click();
    await page.getByRole('button', { name: 'Choose specific tools', exact: true }).click();
    await page.getByRole('button', { name: 'Add tools', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search tools', exact: true }).fill('search');
    await page.getByRole('button', { name: 'Add search from Docs one', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search tools', exact: true }).press('Escape');
    await expect(page.getByRole('button', { name: 'Add tools', exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await page.getByRole('button', { name: 'Publish revision', exact: true }).click();
    expect(catalog.versions[0].definition.tools).toEqual([
      { id: configured[0].id, version: 1, revision: configured[0].revision },
    ]);
    await page.getByRole('button', { name: 'Export profile', exact: true }).click();
    await expect(page.getByLabel('Portable profile export')).toContainText(configured[0].revision);
    await page.getByRole('button', { name: 'Tool library', exact: true }).click();
    await refresh.click();
    await expect(card).toContainText('Selection unavailable');
    await card.locator('.tool-library-details > summary').click();
    await expect(card).toContainText('Configured source disabled; new session required.');
    await refresh.click();
    await page.getByRole('button', { name: 'Cancel discovery', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Discovery cancelled' })).toBeVisible();
    await expect(refresh).toBeFocused();
    releaseCancellation();
    expect(catalog.versions[0].definition.tools).toEqual([
      { id: configured[0].id, version: 1, revision: configured[0].revision },
    ]);
    expect(errors).toEqual([]);
  });
