import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
test.use({ baseURL: 'https://mitzo-ui.test' });
test('curates context packs with accepted pins, explicit publication and responsive source previews', async ({
  page,
  isMobile,
}, testInfo) => {
  const revision = 'a'.repeat(40);
  const definition = {
    version: 1,
    id: 'mitzo-reviewer',
    name: 'Mitzo reviewer',
    description: 'Review the accepted architecture and conventions.',
    tokenBudget: 4000,
    documents: [{ path: 'hub/review.md', revision, mode: 'required', headings: [], priority: 50 }],
    retrievalGuidance: 'Retrieve additional accepted evidence when needed.',
    rationale: 'Keep review decisions grounded in accepted source.',
  };
  let drafts: any[] = [];
  let packs: any[] = [
    {
      id: definition.id,
      revision: 1,
      hash: 'b'.repeat(64),
      publishedAt: '2026-10-10T10:00:00Z',
      definition,
    },
  ];
  let mode = 'content';
  let release: (() => void) | undefined;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/context-packs') {
        if (mode === 'loading')
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        if (mode === 'error')
          return route.fulfill({
            status: 503,
            json: { error: 'Accepted Knowledge source is not configured' },
          });
        return route.fulfill({
          json: mode === 'empty' ? { packs: [], drafts: [] } : { packs, drafts },
        });
      }
      if (url.pathname === '/api/context-packs/mitzo-reviewer/impact')
        return route.fulfill({
          json: {
            profiles: [
              { name: 'Mitzo code reviewer', profileId: 'reviewer', revision: 2, packRevision: 1 },
            ],
          },
        });
      if (url.pathname === '/api/context-packs/drafts') {
        const body = route.request().postDataJSON();
        const draft = {
          id: '11111111-1111-4111-8111-111111111111',
          version: 1,
          baseRevision: 1,
          state: 'draft',
          updatedAt: '2026-10-10T10:00:00Z',
          definition: body.definition,
        };
        drafts = [draft];
        return route.fulfill({ json: { draft } });
      }
      if (url.pathname.endsWith('/validate')) return route.fulfill({ json: { issues: [] } });
      if (url.pathname.endsWith('/preview'))
        return route.fulfill({
          json: {
            compiledContext: {
              source: 'packs',
              compilerRevision: 'offline-compiler',
              recipeHash: 'c'.repeat(64),
              payloadHash: 'd'.repeat(64),
              provenance: {
                packs: [{ id: definition.id, revision: 1, hash: 'b'.repeat(64) }],
                documents: [
                  {
                    storeId: 'knowledge',
                    path: 'hub/review.md',
                    revision,
                    contentHash: 'e'.repeat(64),
                  },
                ],
                omissions: [{ path: 'hub/review.md', heading: 'Background', reason: 'excluded' }],
              },
              context: {
                type: 'boot_context',
                source: 'contexgin',
                sourceCount: 1,
                tokenCount: 140,
                tokenBudget: 4000,
                sources: [{ path: 'hub/review.md', kind: 'reference' }],
                included: [],
                trimmed: [],
                fullMarkdown: '# Review guidance\nUse accepted evidence.',
              },
            },
          },
        });
      if (url.pathname.endsWith('/publish')) {
        const pack = { ...packs[0], revision: 2, definition: drafts[0].definition };
        packs = [pack];
        drafts = [];
        return route.fulfill({ json: { pack } });
      }
      if (url.pathname.endsWith('/events'))
        return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
      if (route.request().method() !== 'GET')
        return route.fulfill({
          status: 405,
          json: { error: 'Offline fixture: no provider execution' },
        });
      const fixtures: Record<string, unknown> = {
        '/api/auth/check': { authenticated: true },
        '/api/knowledge': {
          revision,
          documents: [{ path: 'hub/review.md', title: 'Review guidance', area: 'Hub' }],
          drafts: [],
          reviewEnabled: true,
          acceptanceEnabled: true,
          syncedAt: null,
        },
        '/api/config': { quickActions: [], models: [], mcpServers: [] },
        '/api/accounts': [],
        '/api/sessions': { sessions: [], hasMore: false },
        '/api/notifications': { items: [], needsYou: 0, unread: 0, total: 0, hasMore: false },
        '/api/service-health': { services: [], checkedAt: Date.now() },
      };
      return route.fulfill({ json: fixtures[url.pathname] ?? {} });
    }
    const root = resolve('frontend/dist');
    const path = resolve(
      root,
      url.pathname.startsWith('/assets/') || extname(url.pathname)
        ? url.pathname.slice(1)
        : 'index.html',
    );
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
  if (isMobile) await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/knowledge?view=context');
  await expect(page.getByRole('region', { name: 'Context packs' })).toBeVisible();
  await page.getByRole('button', { name: 'Mitzo reviewer Revision 1', exact: true }).click();
  await page.getByLabel('Pack name').fill('Mitzo reviewer with release context');
  await expect(
    page.getByRole('button', { name: 'Publish pack revision', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Save pack draft', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Draft saved');
  await page.getByRole('button', { name: 'Compile pack preview', exact: true }).click();
  await expect(page.locator('.agent-library-prompt').last()).toContainText('Use accepted evidence');
  await page.getByText('Sources and trimming', { exact: true }).click();
  await expect(page.locator('.agent-library-context-preview')).toContainText(
    'Background · excluded',
  );
  await page
    .getByRole('button', { name: 'Revision comparison and affected profiles', exact: true })
    .click();
  await expect(page.getByText(/Mitzo code reviewer · profile revision 2/)).toBeVisible();
  await page.getByRole('button', { name: 'Publish pack revision', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Published revision 2');
  for (const [theme, accent, font] of [
    ['dark', 'lavender', 'system'],
    ['light', 'teal', 'georgia'],
  ]) {
    await page.evaluate(
      ({ theme, accent, font }) => {
        localStorage.setItem('mitzo-theme', theme);
        localStorage.setItem('mitzo-accent', accent);
        localStorage.setItem('mitzo-font', font);
      },
      { theme, accent, font },
    );
    await page.reload();
    await page
      .getByRole('button', { name: 'Mitzo reviewer with release context Revision 2', exact: true })
      .click();
    await page.getByLabel('Pack name').focus();
    await expect(page.getByLabel('Pack name')).toBeFocused();
    expect(
      await page
        .getByLabel('Pack name')
        .evaluate((element) => element.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page
      .getByRole('button', { name: 'Revision comparison and affected profiles', exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      page.getByRole('button', { name: 'Revision comparison and affected profiles', exact: true }),
    ).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath(`context-packs-${theme}-${accent}-${font}.png`),
      fullPage: true,
    });
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '20px';
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('context-packs-large-text.png'),
    fullPage: true,
  });
  mode = 'empty';
  await page.reload();
  await expect(
    page.getByText('Create your first context pack, or start with the advisor.'),
  ).toBeVisible();
  mode = 'error';
  await page.reload();
  await expect(page.getByRole('alert').last()).toContainText(
    'Accepted Knowledge source is not configured',
  );
  mode = 'loading';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('status')).toContainText('Loading context packs');
  await expect.poll(() => typeof release).toBe('function');
  mode = 'content';
  release!();
  expect(errors).toEqual([]);
});
