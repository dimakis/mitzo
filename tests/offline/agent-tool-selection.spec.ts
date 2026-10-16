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
  test(`tool selection: actual editor, recovery, publish and usage (${theme})`, async ({
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
    let toolFailure = false;
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
      if (url.pathname === '/api/agent-library/tools')
        return route.fulfill(
          toolFailure
            ? { status: 503, json: { error: 'Tool catalog unavailable' } }
            : {
                json: {
                  tools: catalogFixture.map((tool) => ({
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
    await page.getByRole('tab', { name: 'Tools', exact: true }).click();
    await expect(page.getByText(/Legacy behavior: this profile/)).toBeVisible();
    await page.getByRole('button', { name: 'Choose specific tools', exact: true }).click();
    await expect(page.getByText(/No optional tools selected/)).toBeVisible();
    await page.getByRole('button', { name: 'Add tools', exact: true }).click();
    const search = page.getByRole('searchbox', { name: 'Search tools', exact: true });
    await search.fill('nomatchingtool');
    await expect(page.getByText('No matching tools.', { exact: true })).toBeVisible();
    await search.fill('Read');
    await page.getByRole('button', { name: 'Add Read', exact: true }).click();
    await search.fill('GetConnectionGuide');
    await page.getByRole('button', { name: 'Add GetConnectionGuide', exact: true }).click();
    await search.fill('ConnectionRequest');
    await expect(page.getByText(/No active service connection/)).toBeVisible();
    await search.press('Escape');
    await expect(page.getByRole('button', { name: 'Add tools', exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const remove = page.getByRole('button', { name: 'Remove Read', exact: true });
    if (isMobile) expect((await remove.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await remove.click();
    await page.getByRole('button', { name: 'Add tools', exact: true }).click();
    await search.fill('Read');
    await page.getByRole('button', { name: 'Add Read', exact: true }).click();
    await page.getByRole('button', { name: 'Done adding tools', exact: true }).click();
    page.once('dialog', (dialog) => dialog.accept());
    await page.reload();
    await page.getByRole('tab', { name: 'Tools', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Remove Read', exact: true })).toBeVisible();
    await page
      .locator('.agent-library-detail')
      .evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({
      path: info.outputPath(`agent-tools-${theme}.png`),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await page.getByRole('button', { name: 'Publish revision', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Use as reviewer', exact: true })).toBeDisabled();
    await expect(
      page.getByText('Reviewer sessions do not yet support explicit tool selections.'),
    ).toBeVisible();
    expect(catalog.versions[0].definition.tools).toEqual([
      { id: 'mitzo:GetConnectionGuide', version: 1 },
      { id: 'mitzo:Read', version: 1 },
    ]);
    await page.getByRole('button', { name: 'Tool library', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New agent', exact: true })).toHaveCount(0);
    await page
      .getByRole('searchbox', { name: 'Search tool library', exact: true })
      .fill('GetConnectionGuide');
    await page
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { name: 'GetConnectionGuide', exact: true }) })
      .locator('.tool-library-details > summary')
      .click();
    await page
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { name: 'GetConnectionGuide', exact: true }) })
      .getByText('Profiles using this tool', { exact: true })
      .click();
    await expect(page.getByRole('region', { name: 'Tool library', exact: true })).toContainText(
      'Library reader',
    );
    await page
      .getByRole('heading', { name: 'Tool library', exact: true })
      .evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({
      path: info.outputPath(`tool-library-${theme}.png`),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Agent library', exact: true }).click();
    await page.getByRole('button', { name: 'Export profile', exact: true }).click();
    await expect(page.getByLabel('Portable profile export')).toContainText(
      'mitzo:GetConnectionGuide',
    );
    toolFailure = true;
    await page.reload();
    await page.getByRole('tab', { name: 'Tools', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Tool catalog unavailable');
    toolFailure = false;
    await page.getByRole('button', { name: 'Retry tools', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Add tools', exact: true })).toBeEnabled();
    expect(errors).toEqual([]);
  });
