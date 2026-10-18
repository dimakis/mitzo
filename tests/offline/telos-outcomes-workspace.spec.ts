import { localInventoryFixture } from '../../frontend/src/test-utils/local-inventory-fixture';
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
  external: ['/*.png', '/*.svg'],
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
    test.setTimeout(60_000);
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
        TelosWorkItemSchema.parse({
          ...r,
          priority: 5,
          profile: fixtures.homeStudio.items.some((item) => item.itemId === r.itemId)
            ? 'manual'
            : 'work',
          categories: i === 0 ? ['Recording'] : r.categories,
        }),
      );
    function legacy(record: (typeof records)[number]): unknown {
      return {
        id: record.itemId,
        summary: record.summary,
        profile: record.profile,
        urgency: 1,
        starred: record.starred,
        priority: record.priority,
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
    async function reload() {
      await page.reload();
    }
    async function navigate(path: string) {
      await page.goto(path);
    }
    const documentReads: number[] = [];
    let denyArtifact = false;
    const artifactVersion = (revision: number) => ({
      id: 'a'.repeat(32),
      itemId: 'fixture-studio-slice',
      filename: 'plan.md',
      title: 'Saved studio plan',
      revision,
      size: 21,
      sha256: (revision === 3 ? 'b' : 'c').repeat(64),
      createdAt: '2026-10-16T10:00:00Z',
      sessionId: 'fixture-source',
      sourcePath: 'plan.md',
      sourceKind: 'session_artifact',
      url: '/api/telos/artifacts/' + 'a'.repeat(32) + '?revision=' + revision,
    });

    const outcomeArtifact = (revision: number) => ({
      ...artifactVersion(revision),
      id: 'e'.repeat(32),
      itemId: 'fixture-studio',
      title: 'Saved outcome plan',
      url: '/api/telos/artifacts/' + 'e'.repeat(32) + '?revision=' + revision,
    });

    let recordReadGate: Promise<void> | undefined;
    let failRecords = false;
    let failConversations = true;
    let failChildConversations = false;
    let assignedLead = false;
    const assignedFixture = createTelosWorkFixtures().leadWithUnstartedSlice;
    let rejectPriority = false;
    let releasePriority: (() => void) | undefined;
    let priorityGate: Promise<void> | undefined;
    const priorityWrites: number[] = [];
    let collectionMode: 'ready' | 'empty' | 'error' = 'ready';
    page.on('pageerror', (e) => {
      errors.push(e.message);
      console.error('Fixture page error:', e.name, e.message, e.stack, page.url());
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
      if (
        url.pathname.startsWith('/todos') ||
        url.pathname === '/files' ||
        url.pathname === '/chat'
      )
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html{font-size:${theme === 'light' ? '125%' : '100%'}}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
        });
      if (url.pathname === '/api/todos')
        return collectionMode === 'error'
          ? route.fulfill({ status: 503, json: { error: 'Unavailable' } })
          : route.fulfill({
              json: {
                profiles: ['manual', 'work'],
                items:
                  collectionMode === 'empty'
                    ? []
                    : records
                        .filter(
                          (record) =>
                            !record.parentId &&
                            (!url.searchParams.get('profile') ||
                              record.profile === url.searchParams.get('profile')),
                        )
                        .map(legacy),
              },
            });
      const action = url.pathname.match(/^\/api\/todos\/([^/]+)\/action$/);
      if (action && route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        if (body.action !== 'priority') throw Error('Unexpected mutation');
        priorityWrites.push(body.priority);
        if (priorityGate) await priorityGate;
        if (rejectPriority) return route.fulfill({ status: 503, json: { ok: false } });
        const record = records.find((r) => r.itemId === action[1])!;
        record.priority = body.priority;
        return route.fulfill({ json: { ok: true } });
      }
      const match = url.pathname.match(/^\/api\/telos\/work\/items\/([^/]+)(\/record)?$/);
      if (match) {
        const record = records.find((r) => r.itemId === match[1])!;
        if (match[2] && recordReadGate) await recordReadGate;
        if (match[2])
          return failRecords
            ? route.fulfill({ status: 503, json: { error: 'Unavailable' } })
            : route.fulfill({ json: record });
        if (
          (record.itemId === records[0].itemId && failConversations) ||
          (record.itemId === 'fixture-studio-slice' && failChildConversations)
        )
          return route.fulfill({ status: 503, json: { error: 'Conversations unavailable' } });
        const scenario = scenarios.find((s) => s.items.some((r) => r.itemId === record.itemId))!;
        const assigned = record.itemId === records[0].itemId && assignedLead;
        const work = TelosWorkViewSchema.parse({
          itemId: record.itemId,
          kind: record.kind,
          parentId: record.parentId,
          revision: 'f'.repeat(64),
          links: [
            ...scenario.links.filter((l) => l.itemId === record.itemId),
            ...(assigned
              ? assignedFixture.links.filter((l) => l.itemId === record.itemId && l.role === 'lead')
              : []),
          ],
          assignments: assigned
            ? assignedFixture.assignments.filter((a) => a.itemId === record.itemId)
            : [],
          sources: scenario.snapshots.filter((s) => s.itemId === record.itemId),
          attempts: [],
        });
        return route.fulfill({ json: work });
      }

      if (/\/api\/telos\/items\/[^/]+\/artifacts/.test(url.pathname))
        return route.fulfill({
          json: {
            limit: 100,
            artifacts: url.pathname.includes('/fixture-studio-slice/')
              ? [artifactVersion(3)]
              : url.pathname.includes('/fixture-studio/')
                ? [outcomeArtifact(3)]
                : [],
          },
        });
      if (url.pathname === '/api/telos/artifacts/' + 'e'.repeat(32) + '/versions') {
        if (denyArtifact) return route.fulfill({ status: 403, json: { error: 'Access revoked' } });
        const before = Number(url.searchParams.get('beforeRevision') || Number.MAX_SAFE_INTEGER);
        return route.fulfill({
          json: {
            artifacts: [outcomeArtifact(4), outcomeArtifact(3)].filter(
              (row) => row.revision < before,
            ),
            cursor: null,
            hasMore: false,
          },
        });
      }
      if (url.pathname === '/api/telos/artifacts/' + 'e'.repeat(32) + '/document') {
        const revision = Number(url.searchParams.get('revision'));
        return route.fulfill({
          json: {
            path: outcomeArtifact(revision).url,
            name: 'plan.md',
            ext: '.md',
            content: `# Retained outcome plan r${revision}`,
            revision,
            editable: true,
            previewUnavailable: false,
          },
        });
      }
      if (url.pathname === '/api/telos/artifacts/' + 'a'.repeat(32) + '/versions') {
        if (denyArtifact) return route.fulfill({ status: 403, json: { error: 'Access revoked' } });
        const before = Number(url.searchParams.get('beforeRevision') || Number.MAX_SAFE_INTEGER);
        return route.fulfill({
          json: {
            artifacts: [artifactVersion(4), artifactVersion(3)].filter(
              (row) => row.revision < before,
            ),
            cursor: null,
            hasMore: false,
          },
        });
      }
      if (url.pathname === '/api/telos/artifacts/' + 'a'.repeat(32) + '/document') {
        if (denyArtifact) return route.fulfill({ status: 403, json: { error: 'Access revoked' } });
        const revision = Number(url.searchParams.get('revision') || 4);
        documentReads.push(revision);
        return route.fulfill({
          json: {
            path: '/api/telos/artifacts/' + 'a'.repeat(32) + '?revision=' + revision,
            name: 'plan.md',
            ext: '.md',
            content:
              revision === 3
                ? '# Retained studio plan r3\n\nSelected original document.'
                : '# Latest studio plan r4',
            revision,
            editable: true,
            previewUnavailable: false,
          },
        });
      }
      if (url.pathname === '/api/chat/runtime/capabilities')
        return route.fulfill({ json: localInventoryFixture() });
      if (url.pathname === '/api/accounts')
        return route.fulfill({
          json: [
            {
              id: 'personal',
              label: 'Offline personal account',
              models: [{ id: 'luna-fixture', label: 'Luna fixture', reasoningEfforts: ['high'] }],
            },
          ],
        });
      if (url.pathname === '/api/agent-library')
        return route.fulfill({
          json: { drafts: [], versions: localInventoryFixture().agentProfiles },
        });
      if (
        ['/api/home/briefing-chats', '/api/skills', '/api/symposium/profile-proposals'].includes(
          url.pathname,
        )
      )
        return route.fulfill({ json: [] });
      if (['/api/config', '/api/version'].includes(url.pathname))
        return route.fulfill({ json: {} });
      if (url.pathname === '/api/sessions')
        return route.fulfill({ json: { sessions: [], hasMore: false } });
      if (url.pathname === '/api/repository-workspaces/catalog')
        return route.fulfill({ json: { available: true, repositories: [] } });
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
    await navigate('/todos');
    await expect(page.getByRole('button', { name: 'All outcomes', exact: true })).toBeVisible();
    const studioRow = page.locator('.telos-tree-row').filter({
      has: page.getByRole('button', { name: records[0].summary, exact: true }),
    });
    await expect(studioRow.getByText('Conversations unavailable', { exact: true })).toBeVisible();
    await studioRow.evaluate((element) => element.setAttribute('data-refresh-witness', 'mounted'));
    failConversations = false;
    assignedLead = true;
    await page.getByRole('button', { name: 'Refresh Telos' }).click();
    await expect(studioRow.getByRole('button', { name: 'Lead chat', exact: true })).toBeVisible();
    await expect(studioRow).toHaveAttribute('data-refresh-witness', 'mounted');
    assignedLead = false;
    await page.evaluate(() =>
      window.fixtureTodoEvents.dispatchEvent(new MessageEvent('todo_update', { data: '{}' })),
    );
    await expect(studioRow.getByRole('button', { name: 'Choose lead', exact: true })).toBeVisible();
    assignedLead = true;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(studioRow.getByRole('button', { name: 'Lead chat', exact: true })).toBeVisible();
    assignedLead = false;
    await page.evaluate(() =>
      window.fixtureTodoEvents.dispatchEvent(new MessageEvent('todo_update', { data: '{}' })),
    );
    await expect(studioRow.getByRole('button', { name: 'Choose lead', exact: true })).toBeVisible();
    await expect(studioRow).toHaveAttribute('data-refresh-witness', 'mounted');
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
    await expect(page.locator('.telos-item-workspace')).toBeVisible();
    const priority = page.getByRole('combobox', { name: 'Priority', exact: true });
    const priorityBounds = (await priority.boundingBox())!;
    expect(priorityBounds.height).toBeGreaterThanOrEqual(44);
    expect(priorityBounds.width).toBeGreaterThanOrEqual(44);
    const intrinsicWidth = await priority.evaluate((element) => {
      const probe = element.cloneNode(true) as HTMLSelectElement;
      Object.assign(probe.style, {
        position: 'fixed',
        width: 'max-content',
        minWidth: '0',
        maxWidth: 'none',
        flex: 'none',
        visibility: 'hidden',
      });
      element.parentElement!.appendChild(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width;
    });
    expect(priorityBounds.width).toBeGreaterThanOrEqual(intrinsicWidth - 1);

    expect(priorityBounds.x + priorityBounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);

    for (let value = 1; value <= 10; value++) {
      await priority.selectOption(String(value));
      await expect(priority).toHaveValue(String(value));
      await expect(priority).toBeEnabled();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      const row = page.locator('.telos-tree-row').filter({
        has: page.getByRole('button', { name: 'Plan the recording setup', exact: true }),
      });
      await expect(row.getByLabel(`Priority ${value} out of 10`)).toHaveText(`P${value}`);
      await row.getByRole('button', { name: 'Plan the recording setup', exact: true }).click();
      await expect(priority).toHaveValue(String(value));
    }
    await reload();
    await expect(priority).toHaveValue('10');
    rejectPriority = true;
    await priority.selectOption('2');
    await expect(
      page.getByRole('alert').filter({ hasText: 'Couldn’t confirm this priority' }),
    ).toBeVisible();
    await expect(priority).toHaveValue('10');
    rejectPriority = false;
    priorityGate = new Promise((resolve) => {
      releasePriority = resolve;
    });
    await priority.selectOption('3');
    await expect(priority).toBeDisabled();
    await expect(priority).toHaveValue('10');
    const writesBeforeOverlap = priorityWrites.length;
    await priority.evaluate((select) => {
      (select as HTMLSelectElement).value = '4';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(priorityWrites.length).toBe(writesBeforeOverlap);
    failRecords = true;
    releasePriority!();
    priorityGate = undefined;
    await expect(priority).toHaveValue('3');
    await expect(priority).toBeEnabled();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Some related outcome records are unavailable' }),
    ).toBeVisible();
    // A second client saves 2 while this client's acknowledged 3 could not refresh.
    records[1] = { ...records[1], priority: 2, updatedAt: '2026-10-17T23:59:00Z' };
    failRecords = false;
    await page.evaluate(() =>
      window.fixtureTodoEvents.dispatchEvent(new MessageEvent('todo_update', { data: '{}' })),
    );
    await expect(priority).toHaveValue('2');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    const recoveredRow = page
      .locator('.telos-tree-row')
      .filter({ has: page.getByRole('button', { name: 'Plan the recording setup', exact: true }) });
    await expect(recoveredRow.getByLabel('Priority 2 out of 10')).toHaveText('P2');
    await recoveredRow
      .getByRole('button', { name: 'Plan the recording setup', exact: true })
      .click();
    await expect(priority).toHaveValue('2');

    expect(priorityWrites).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 2, 3]);
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
    expect((await page.locator('.output-row-copy').boundingBox())!.width).toBeGreaterThanOrEqual(
      160,
    );
    expect(
      await page
        .locator('.output-row-copy')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await expect(page.getByRole('link', { name: 'Saved studio plan', exact: true })).toHaveCount(1);
    await page.getByRole('link', { name: 'Saved studio plan', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Retained studio plan r3' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Latest studio plan r4' })).toHaveCount(0);
    await reload();
    await expect(page.getByRole('heading', { name: 'Retained studio plan r3' })).toBeVisible();
    expect(documentReads.every((revision) => revision === 3)).toBe(true);
    await page.getByRole('combobox', { name: 'Version', exact: true }).selectOption('4');
    await expect(page.getByRole('heading', { name: 'Latest studio plan r4' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Version', exact: true }).selectOption('3');
    await expect(page.getByRole('heading', { name: 'Retained studio plan r3' })).toBeVisible();
    const selectedWorkRoute = new URL(page.url()).pathname + new URL(page.url()).search;
    expect(new URL(page.url()).searchParams.get('savedRevision')).toBe('3');
    expect(new URL(page.url()).searchParams.get('savedHash')).toBe('b'.repeat(64));
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'File options', exact: true }).click();
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page).toHaveURL(/\/files\?/);
    expect(new URL(page.url()).searchParams.get('from')).toBe(selectedWorkRoute);
    await expect(page.getByRole('heading', { name: 'Retained studio plan r3' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Save new revision', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await reload();
    await expect(page.getByRole('heading', { name: 'Retained studio plan r3' })).toBeVisible();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Saved studio plan' })).toBeVisible();
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(selectedWorkRoute);
    denyArtifact = true;
    await reload();
    await expect(
      page.getByRole('alert').filter({ hasText: 'no longer available to you' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Retained studio plan r3' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'File options', exact: true })).toHaveCount(0);
    denyArtifact = false;
    await page.getByRole('button', { name: 'Retry saved version', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Retained studio plan r3' })).toBeVisible();
    const badPin = new URL(page.url());
    badPin.searchParams.set('savedHash', 'd'.repeat(64));
    await navigate(badPin.pathname + badPin.search);
    await expect(
      page.getByRole('alert').filter({ hasText: 'unavailable or changed' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Latest studio plan r4' })).toHaveCount(0);
    await navigate(selectedWorkRoute);
    await expect(page.getByRole('heading', { name: 'Retained studio plan r3' })).toBeVisible();

    await page.screenshot({
      path: info.outputPath('retained-document-' + theme + '.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await reload();
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
    const context = page.locator('summary').filter({ hasText: /^Context$/ });
    await expect(context.locator('..')).not.toHaveAttribute('open');
    await context.focus();
    await page.keyboard.press('Enter');
    await expect(context.locator('..')).toHaveAttribute('open');
    await expect(page.getByText('Repositories', { exact: true })).toBeVisible();
    await expect(page.getByText('fixture/mitzo', { exact: true })).toBeVisible();
    await expect(page.getByText('frontend/src/pages/TodoView.tsx', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('software-' + theme + '.png'), fullPage: true });
    if (!isMobile && theme === 'light') {
      await page.setViewportSize({ width: 900, height: 900 });
      const geometry = await page.locator('.telos-dashboard').evaluate((dashboard) => {
        const main = dashboard.firstElementChild!,
          brief = dashboard.lastElementChild!;
        const body = main.getBoundingClientRect(),
          side = brief.getBoundingClientRect();
        const controls = [...main.querySelectorAll('button')]
          .map((button) => button.getBoundingClientRect())
          .filter((rect) => rect.width > 0);
        return {
          contained: controls.every(
            (rect) => rect.left >= body.left && rect.right <= body.right + 1,
          ),
          separated: body.right <= side.left || body.bottom <= side.top,
        };
      });
      expect(geometry.contained).toBe(true);
      expect(geometry.separated).toBe(true);
      await page.screenshot({
        path: info.outputPath('workspace-narrow-enlarged-light.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 900 });
    }

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(search).toHaveValue('frontend/src/pages/TodoView.tsx');
    failRecords = true;
    await reload();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Outcome workspace records unavailable' }),
    ).toBeVisible();
    // A legacy filter is still usable during failure, but cannot restrict the
    // canonical tree after recovery or hide another profile's known outcomes.
    await page.locator('.todo-filters').getByRole('button', { name: 'work', exact: true }).click();
    await expect(page.getByText(records[0].summary, { exact: true })).toHaveCount(0);
    failRecords = false;
    await page.getByRole('button', { name: 'Refresh Telos' }).click();
    await expect(page.getByRole('button', { name: 'All outcomes', exact: true })).toBeVisible();
    await expect(search).toHaveValue('frontend/src/pages/TodoView.tsx');
    await search.fill('');
    await page
      .getByLabel('Pinned categories', { exact: true })
      .getByRole('button', { name: 'All', exact: true })
      .click();
    await expect(page.getByRole('button', { name: records[0].summary, exact: true })).toBeVisible();
    const workRoot = records.find((record) => !record.parentId && record.profile === 'work')!;
    await expect(page.getByRole('button', { name: workRoot.summary, exact: true })).toBeVisible();
    await expect(page.locator('.todo-filters')).toHaveCount(0);
    collectionMode = 'empty';
    await reload();
    await expect(page.getByText('No outcomes yet.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'All outcomes', exact: true })).toBeVisible();
    collectionMode = 'error';
    await reload();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Unable to load Telos items' }),
    ).toBeVisible();
    await expect(page.getByText('No outcomes yet.')).toHaveCount(0);
    await navigate('/todos/fixture-studio');
    await expect(
      page.getByText('Child work unavailable. Refresh to check its current state.'),
    ).toBeVisible();
    await expect(page.getByText('No child work yet.')).toHaveCount(0);
    collectionMode = 'ready';
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Plan the recording setup', exact: true }),
    ).toBeVisible();
    // Keep each compact child row mounted while the canonical owner renews it.
    for (const tab of ['Overview', 'Work']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      const child = page.getByRole('button', { name: 'Plan the recording setup', exact: true });
      const row = child.locator('xpath=ancestor::li[1]');
      await row.evaluate((element) => {
        element.setAttribute('data-s7-mounted', 'same-row');
      });
      failChildConversations = true;
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect(row.getByText('Conversations unavailable', { exact: true })).toBeVisible();
      failChildConversations = false;
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect(row.getByRole('button', { name: 'Choose worker', exact: true })).toBeVisible();
      const childRecord = records.find((record) => record.itemId === 'fixture-studio-slice')!;
      childRecord.kind = 'coordinator';
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect(
        row.getByRole('button', { name: 'View coordinator', exact: true }),
      ).toBeVisible();
      childRecord.kind = 'work_item';
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect(row.getByRole('button', { name: 'Choose worker', exact: true })).toBeVisible();
      await expect(row).toHaveAttribute('data-s7-mounted', 'same-row');
      await expect(page.getByRole('button', { name: tab, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    }
    // Direct saved links must work independently of the item's remembered tab.
    const outcomePin = `/todos/fixture-studio?savedArtifact=${'e'.repeat(32)}&savedRevision=3&savedHash=${'b'.repeat(64)}`;
    for (const tab of ['Chat', 'Work']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      await navigate(outcomePin);
      await expect(page.getByRole('heading', { name: 'Retained outcome plan r3' })).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(1);
      await expect(page.getByRole('button', { name: tab, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await page.screenshot({
        path: info.outputPath(`saved-link-${tab.toLowerCase()}-${theme}.png`),
        fullPage: true,
      });
      denyArtifact = true;
      // Reload first renders the legacy fallback, then joins the outcome's
      // canonical child records. Keep denial until that workspace owns the dialog.
      const childRecordLoaded = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            '/api/telos/work/items/fixture-studio-slice/record' && response.status() === 200,
      );
      await reload();
      await childRecordLoaded;
      await expect(page.getByRole('button', { name: tab, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(
        page.getByRole('alert').filter({ hasText: 'no longer available to you' }),
      ).toBeVisible();
      denyArtifact = false;
      await page.getByRole('button', { name: 'Retry saved version', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Retained outcome plan r3' })).toBeVisible();
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('button', { name: tab, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(new URL(page.url()).searchParams.has('savedArtifact')).toBe(false);
    }
    records[0] = { ...records[0], kind: null };
    await navigate('/todos/fixture-studio');
    await expect(page.getByText('Unclassified · active', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Work', exact: true }).click();
    await page.getByRole('button', { name: 'Plan the recording setup', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Work', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Materials', exact: true }).click();
    await page.getByRole('link', { name: 'Saved studio plan', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Retained studio plan r3' })).toBeVisible();
    await reload();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByText('Unclassified · active', { exact: true })).toBeVisible();
    expect(records[0].kind).toBeNull();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    // CT14: a focused item unmounts this deeply expanded collection. Back must
    // wait past its short legacy fallback and later conversation-row growth.
    records[0] = { ...records[0], kind: 'outcome' };
    const scrollTemplate = records.find((record) => record.itemId === 'fixture-studio-slice')!;
    const scrollItems = Array.from({ length: 40 }, (_, index) =>
      TelosWorkItemSchema.parse({
        ...scrollTemplate,
        itemId: `fixture-scroll-${index + 1}`,
        parentId: 'fixture-studio',
        summary: `Scroll work item ${String(index + 1).padStart(2, '0')}`,
      }),
    );
    records.push(...scrollItems);
    const scrollRecordsLoaded = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/telos/work/items/fixture-scroll-40/record' &&
        response.status() === 200,
    );
    await page.getByRole('button', { name: 'Refresh Telos', exact: true }).click();
    await scrollRecordsLoaded;
    await expect(page.getByRole('region', { name: 'Outcomes tree', exact: true })).toBeVisible();
    await page.getByRole('searchbox').fill('');
    await page
      .getByLabel('Pinned categories', { exact: true })
      .getByRole('button', { name: 'All', exact: true })
      .click();
    await page.getByRole('button', { name: 'Expand all', exact: true }).click();
    const scrollRows = page
      .getByRole('button', { name: /^Scroll work item/ })
      .locator('xpath=ancestor::li[1]');
    await expect(
      scrollRows.getByRole('button', { name: 'Choose worker', exact: true }),
    ).toHaveCount(40);
    const lastScrollItem = page.getByRole('button', { name: 'Scroll work item 40', exact: true });
    await lastScrollItem.scrollIntoViewIfNeeded();
    const savedScroll = await page.locator('.todo-scroll').evaluate((element) => element.scrollTop);
    expect(savedScroll).toBeGreaterThan(500);
    await lastScrollItem.click();
    await expect(
      page
        .locator('.telos-item-workspace')
        .getByRole('heading', { name: 'Scroll work item 40', exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator('.telos-item-workspace')
        .getByRole('button', { name: 'Choose worker', exact: true }),
    ).toBeVisible();
    let releaseScrollRecords: (() => void) | undefined;
    recordReadGate = new Promise<void>((resolve) => {
      releaseScrollRecords = resolve;
    });
    try {
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(page.locator('.telos-legacy-page')).toBeVisible();
      await expect(page.locator('.todo-scroll')).toHaveJSProperty('scrollTop', 0);
    } finally {
      recordReadGate = undefined;
      releaseScrollRecords?.();
    }
    await expect(
      scrollRows.getByRole('button', { name: 'Choose worker', exact: true }),
    ).toHaveCount(40);
    await expect
      .poll(async () =>
        Math.abs(
          (await page.locator('.todo-scroll').evaluate((element) => element.scrollTop)) -
            savedScroll,
        ),
      )
      .toBeLessThanOrEqual(2);
    await page.screenshot({
      path: info.outputPath(`scroll-restored-${theme}.png`),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'New item', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue(
      /Help me plan a new Telos outcome/,
    );
    await expect(page.getByRole('button', { name: /Workspace controls/ })).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: isMobile ? 'More composer actions' : 'Attach image',
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByPlaceholder('Milestones — first line is the next action')).toHaveCount(
      0,
    );
    await page.screenshot({
      path: info.outputPath('new-item-ordinary-chat-' + theme + '.png'),
      fullPage: true,
    });
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
