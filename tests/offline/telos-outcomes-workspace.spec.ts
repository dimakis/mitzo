import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { projectTelosWorkRecord } from '../../server/telos-work-record';
import { createTelosWorkFixtures } from '../../server/__tests__/fixtures/telos-work-fixtures';
import { TelosWorkItemSchema, TelosWorkViewSchema } from '@mitzo/protocol';
import { readFile } from 'node:fs/promises';
test.use({ baseURL: 'https://mitzo-ui.test' });
const bundle = build({
  entryPoints: [resolve('tests/fixtures/telos-outcomes-workspace.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/telos-workspace.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
  },
});
for (const theme of ['dark', 'light'])
  test(`S7 canonical DTO tree, navigation, provenance and reload (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const fixtures = createTelosWorkFixtures();
    const software = fixtures.nestedCoordinator.items.find((item) => item.kind === 'outcome')!;
    Object.assign(
      software,
      projectTelosWorkRecord(
        {
          id: software.itemId,
          parent_id: software.parentId,
          summary: software.summary,
          intent: software.intent,
          rationale: software.rationale,
          acceptance_criteria: JSON.stringify(software.acceptanceCriteria),
          profile: software.profile,
          status: software.status,
          starred: 0,
          categories: JSON.stringify(['Mitzo']),
          created_at: software.createdAt,
          updated_at: software.updatedAt,
          context_hints: JSON.stringify({
            repos: ['fixture/mitzo'],
            paths: ['frontend/src/pages/TodoView.tsx'],
            task_hint: 'Review the approved workspace contract.',
          }),
        },
        [],
        [],
        software.kind,
      ),
    );
    const scenarios = [fixtures.homeStudio, fixtures.nestedCoordinator];
    const records = scenarios
      .flatMap((s) => s.items)
      .map((r, i) =>
        TelosWorkItemSchema.parse({ ...r, categories: i === 0 ? ['Recording'] : r.categories }),
      );
    const todos = records.filter((r) => !r.parentId).map((r) => legacy(r));
    function legacy(record: (typeof records)[number]): unknown {
      return {
        id: record.itemId,
        summary: record.summary,
        profile: record.profile,
        urgency: 1,
        starred: record.starred,
        status: record.status,
        ageDays: 0,
        parentId: record.parentId,
        children: records.filter((r) => r.parentId === record.itemId).map(legacy),
        childCount: records.filter((r) => r.parentId === record.itemId).length,
        completedChildCount: 0,
        sources: [],
        links: [],
        contextHints: record.contextHints,
        goalId: null,
      };
    }
    const files = (await bundle).outputFiles;
    const unexpected: string[] = [];
    const errors: string[] = [];
    let failRecords = false;
    let collectionMode: 'ready' | 'empty' | 'error' = 'ready';
    page.on('pageerror', (e) => {
      errors.push(e.message);
      console.error('Fixture page error:', e.message);
    });
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme as 'dark' | 'light' });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'mitzo-ui.test') {
        unexpected.push(url.href);
        return route.abort();
      }
      const asset = files.find(
        (file) => url.pathname === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (asset)
        return route.fulfill({
          body: asset.text,
          contentType: asset.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (url.pathname.startsWith('/todos'))
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
        });
      if (url.pathname === '/api/todos')
        return collectionMode === 'error'
          ? route.fulfill({ status: 503, json: { error: 'Unavailable' } })
          : route.fulfill({
              json: { profiles: ['manual'], items: collectionMode === 'empty' ? [] : todos },
            });
      const match = url.pathname.match(/^\/api\/telos\/work\/items\/([^/]+)(\/record)?$/);
      if (match) {
        const record = records.find((r) => r.itemId === match[1])!;
        if (match[2])
          return failRecords
            ? route.fulfill({ status: 503, json: { error: 'Unavailable' } })
            : route.fulfill({ json: record });
        const scenario = scenarios.find((s) => s.items.some((r) => r.itemId === record.itemId))!;
        const work = TelosWorkViewSchema.parse({
          itemId: record.itemId,
          kind: record.kind,
          parentId: record.parentId,
          revision: 'f'.repeat(64),
          links: scenario.links.filter((l) => l.itemId === record.itemId),
          assignments: [],
          sources: scenario.snapshots.filter((s) => s.itemId === record.itemId),
          attempts: [],
        });
        return route.fulfill({ json: work });
      }
      if (/\/api\/telos\/items\/[^/]+\/artifacts/.test(url.pathname))
        return route.fulfill({
          json: {
            limit: 100,
            artifacts: [
              {
                id: 'a'.repeat(32),
                itemId: url.pathname.split('/')[4],
                filename: 'plan.md',
                title: 'Saved studio plan',
                revision: 3,
                size: 21,
                sha256: 'b'.repeat(64),
                createdAt: '2026-10-16T10:00:00Z',
                sessionId: 'fixture-source',
                sourcePath: 'plan.md',
                sourceKind: 'session_artifact',
                url: '/api/telos/artifacts/' + 'a'.repeat(32) + '?revision=3',
              },
            ],
          },
        });
      if (url.pathname === '/api/home/preferences')
        return route.fulfill({
          json: { revision: 0, names: { briefing: 'Minion', terminal: 'Minion' }, pins: [] },
        });
      if (url.pathname === '/api/service-health')
        return route.fulfill({ json: { services: [], checkedAt: 1 } });
      if (['/mitzo-icon.png', '/mitzo-wordmark.png'].includes(url.pathname))
        return route.fulfill({
          body: await readFile('frontend/public' + url.pathname),
          contentType: 'image/png',
        });
      if (url.pathname === '/api/events')
        return route.fulfill({ contentType: 'text/event-stream', body: '' });
      unexpected.push(url.pathname);
      return route.abort();
    });
    await page.goto('/todos');
    await expect(page.getByRole('button', { name: 'All outcomes', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Browse categories' }).click();
    await page.getByRole('button', { name: 'Pin Recording' }).click();
    await page.getByRole('button', { name: 'Browse categories' }).click();
    const search = page.getByRole('searchbox', { name: 'Search Telos tree' });
    expect((await search.boundingBox())!.width).toBeGreaterThan(180);
    await search.fill('recording');
    const target = page.getByRole('button', { name: 'Plan the recording setup', exact: true });
    expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath('tree-' + theme + '.png'), fullPage: true });
    const originalChild = records[1];
    records[1] = {
      ...originalChild,
      summary: 'Updated recording setup',
      status: 'completed',
      categories: ['Updated category'],
    };
    await page.evaluate(() =>
      window.fixtureTodoEvents.dispatchEvent(new MessageEvent('todo_update', { data: '{}' })),
    );
    await expect(
      page.getByRole('button', { name: 'Updated recording setup', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('completed', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Browse categories' }).click();
    await expect(page.getByRole('button', { name: 'Pin Updated category' })).toBeVisible();
    await page.getByRole('button', { name: 'Browse categories' }).click();
    await page.getByRole('button', { name: 'Updated recording setup', exact: true }).click();
    records[1] = {
      ...records[1],
      summary: 'Latest recording setup',
      rationale: 'Updated without leaving this item.',
    };
    await page.evaluate(() =>
      window.fixtureTodoEvents.dispatchEvent(new MessageEvent('todo_update', { data: '{}' })),
    );
    await expect(
      page.getByRole('heading', { name: 'Latest recording setup', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Updated without leaving this item.', { exact: true }),
    ).toBeVisible();
    records[1] = originalChild;
    await page.evaluate(() =>
      window.fixtureTodoEvents.dispatchEvent(new MessageEvent('todo_update', { data: '{}' })),
    );

    await expect(
      page.getByRole('heading', { name: 'Plan the recording setup', exact: true }),
    ).toBeVisible();
    if (!isMobile)
      expect((await page.locator('.telos-item-workspace').boundingBox())!.x).toBeGreaterThan(100);
    await expect(page.getByRole('button', { name: 'Work', exact: true })).toHaveCount(0);
    const sharedAction = page.getByRole('button', { name: 'Choose worker', exact: true });
    await expect(sharedAction).toBeVisible();
    const actionColors = await sharedAction.evaluate((element) => {
      const control = document.createElement('button');
      control.className = 'todo-detail-chat-btn';
      document.body.append(control);
      const actual = getComputedStyle(element),
        reference = getComputedStyle(control);
      const colors = {
        actual: actual.color,
        expected: reference.color,
        background: actual.backgroundColor,
        expectedBackground: reference.backgroundColor,
      };
      control.remove();
      return colors;
    });
    expect(actionColors.actual).toBe(actionColors.expected);
    expect(actionColors.background).toBe(actionColors.expectedBackground);
    await page.screenshot({
      path: info.outputPath('overview-action-' + theme + '.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Materials', exact: true }).click();
    await page.getByText('Provenance', { exact: true }).click();
    await expect(page.getByText('b'.repeat(64))).toBeVisible();
    expect((await page.locator('.output-row-copy').boundingBox())!.width).toBeGreaterThan(160);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Materials', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByText('Provenance', { exact: true }).click();
    await page.screenshot({ path: info.outputPath('materials-' + theme + '.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(search).toHaveValue('recording');
    await expect(page.getByRole('button', { name: 'Recording', exact: true })).toBeVisible();
    await search.fill('frontend/src/pages/TodoView.tsx');
    await page.getByRole('button', { name: 'Nested outcome', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Nested outcome', exact: true })).toBeVisible();
    await expect(page.getByText('fixture/mitzo', { exact: true })).toBeVisible();
    await expect(page.getByText('frontend/src/pages/TodoView.tsx', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('software-' + theme + '.png'), fullPage: true });
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(search).toHaveValue('frontend/src/pages/TodoView.tsx');
    failRecords = true;
    await page.reload();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Outcome workspace records unavailable' }),
    ).toBeVisible();
    failRecords = false;
    await page.getByRole('button', { name: 'Refresh Telos' }).click();
    await expect(page.getByRole('button', { name: 'All outcomes', exact: true })).toBeVisible();
    collectionMode = 'empty';
    await page.reload();
    await expect(page.getByText('No outcomes yet.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'All outcomes', exact: true })).toBeVisible();
    collectionMode = 'error';
    await page.reload();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Unable to load Telos items' }),
    ).toBeVisible();
    await expect(page.getByText('No outcomes yet.')).toHaveCount(0);
    await page.goto('/todos/fixture-studio');
    await expect(
      page.getByText('Child work unavailable. Refresh to check its current state.'),
    ).toBeVisible();
    await expect(page.getByText('No child work yet.')).toHaveCount(0);
    collectionMode = 'ready';
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Plan the recording setup', exact: true }),
    ).toBeVisible();
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
