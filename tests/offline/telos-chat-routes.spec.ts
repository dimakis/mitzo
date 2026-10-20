import { settingsHome, settingRow } from '../support/chat-settings';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  TelosReviewedSourceViewSchema,
  TelosWorkItemSchema,
  TelosWorkControlCommandSchema,
  TelosWorkViewSchema,
} from '@mitzo/protocol';
import { localInventoryFixture } from '../../frontend/src/test-utils/local-inventory-fixture';
test.use({ baseURL: 'https://mitzo-ui.test' });
const bundle = build({
  entryPoints: [resolve('tests/fixtures/telos-chat-routes.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/telos-chat-routes.js',
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
for (const { software, regression } of [
  { software: false, regression: null },
  { software: true, regression: null },
  { software: false, regression: 'view-item' },
  { software: false, regression: 'reconnect' },
] as const)
  test(
    regression
      ? `S8 review regression: ${regression}`
      : `S8 actual item and ordinary routes retain chat ownership (${software ? 'repository' : 'non-code'})`,
    async ({ page, isMobile }, info) => {
      test.setTimeout(60_000);
      const files = (await bundle).outputFiles!;
      const inventory = localInventoryFixture();
      inventory.accounts[0].models.push({
        id: 'luna-review-fixture',
        label: 'Luna review fixture',
        reasoningEfforts: ['low', 'high'],
      });
      const errors: string[] = [],
        writes: string[] = [];
      const controlInboxReads: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const record = TelosWorkItemSchema.parse({
        version: 1,
        itemId: 'slice',
        kind: 'work_item',
        parentId: null,
        summary: software ? 'Review contributor controls' : 'Plan a recording session',
        intent: 'Retain the agreed work',
        rationale: 'Keep reviewed context',
        acceptanceCriteria: ['Review the returned evidence'],
        profile: 'manual',
        status: 'active',
        starred: false,
        priority: 7,
        categories: ['Job'],
        createdAt: null,
        updatedAt: null,
        contextHints: {
          repos: software ? ['fixture/mitzo'] : [],
          paths: [],
          issues: [],
          docIds: [],
          people: [],
          jiraKeys: [],
          keywords: [],
          taskHint: '',
          sessionIds: [],
        },
        sources: [],
        links: [],
        legacyFields: {},
      });
      const work = TelosWorkViewSchema.parse({
        itemId: 'slice',
        kind: 'work_item',
        parentId: null,
        revision: 'a'.repeat(64),
        links: ['worker', 'reviewer'].map((role) => ({
          version: 1,
          linkId: role,
          itemId: 'slice',
          role,
          conversation: { namespace: 'mitzo', conversationId: role },
          linkedAt: '2026-10-19',
          linkedBy: 'Dimitri',
          availability: 'available',
          attemptId: null,
        })),
        assignments: [
          {
            itemId: 'slice',
            role: 'worker',
            conversation: { namespace: 'mitzo', conversationId: 'worker' },
            revision: 1,
            assignedAt: null,
            assignedBy: null,
          },
        ],
        sources: [],
        attempts: [
          {
            version: 1,
            requestId: 'request',
            attemptId: 'attempt',
            predecessorAttemptId: null,
            leadConversationId: 'lead',
            childItemId: 'slice',
            contextSnapshotId: 'snapshot',
            state: 'chat_ready',
            workerConversationId: 'worker',
            allocationReceiptId: 'receipt',
            executionTaskId: 'execution-worker',
            accountingGoalId: null,
            turnCommandId: null,
          },
        ],
      });
      const legacy = {
        id: 'slice',
        summary: record.summary,
        profile: 'manual',
        urgency: 0.5,
        priority: 7,
        starred: false,
        status: 'active',
        ageDays: 0,
        parentId: null,
        children: [],
        childCount: 0,
        completedChildCount: 0,
        sources: [],
        links: [],
        contextHints: record.contextHints,
        goalId: null,
      };
      const child = TelosWorkItemSchema.parse({
        ...record,
        itemId: 'child',
        parentId: 'slice',
        summary: 'Check the retained plan',
      });
      const childLegacy = { ...legacy, id: 'child', parentId: 'slice', summary: child.summary };
      const reconnectChild = TelosWorkItemSchema.parse({
        ...child,
        itemId: 'after-reconnect',
        summary: 'Child discovered after reconnect',
      });
      const resumeChild = TelosWorkItemSchema.parse({
        ...child,
        itemId: 'after-resume',
        summary: 'Child discovered after resume',
      });
      let collectionChildren = [childLegacy];
      const readCounts = { todos: 0, tasks: 0 };
      const snapshot = {
        version: 1,
        snapshotId: 'source-review',
        itemId: 'slice',
        source: { namespace: 'mitzo', conversationId: 'worker' },
        selection: { kind: 'selected', messageIds: ['worker'], blockIds: [], throughSequence: 2 },
        author: null,
        sourceCreatedAt: null,
        adoptedAt: null,
        artifacts: [],
        adoptedBrief: null,
      };
      const sourceSelection = {
        requestId: '11111111-1111-4111-8111-111111111111',
        expectedMembershipRevision: 0,
        sourceConversationId: 'worker',
        boundary: { sequence: 2, messageId: 'worker' },
        mode: 'selected',
        messageIds: ['worker'],
        artifacts: [],
        purpose: 'Retain plan',
        joiningBrief: '',
      };
      const sourceView = TelosReviewedSourceViewSchema.parse({
        available: true,
        snapshot,
        sourceHref: '/chat/worker?telosItem=slice&telosSource=source-review',
        packet: {
          version: 1,
          actorId: 'offline',
          itemId: 'slice',
          workRevision: work.revision,
          selection: sourceSelection,
          brief: { sha256: 'b'.repeat(64), text: 'Retain the plan' },
          context: {
            requestId: sourceSelection.requestId,
            sourceConversationId: 'worker',
            boundary: sourceSelection.boundary,
            mode: 'selected',
            purpose: 'Retain plan',
            joiningBrief: '',
            messages: [],
            artifacts: [],
            capacity: { status: 'unverified', reason: 'Offline source inspection' },
            summary: null,
          },
          attributions: {},
          sourceTitle: 'Worker plan',
          sourceCreatedAt: null,
        },
      });
      let taskDone = false;
      let taskTitle = 'Review evidence';
      let holdMetadata = false;
      let releaseMetadata!: () => void;
      const metadataHeld = new Promise<void>((resolve) => {
        releaseMetadata = resolve;
      });
      await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
      await page.emulateMedia({
        reducedMotion: 'no-preference',
        colorScheme: software ? 'light' : 'dark',
      });
      await page.routeWebSocket('**/*', (socket) => socket.close());
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url()),
          path = url.pathname;
        if (url.hostname !== 'mitzo-ui.test') return route.abort();
        const asset = files.find(
          (file) => path === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
        );
        if (asset)
          return route.fulfill({
            body: asset.text,
            contentType: asset.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          });
        if (path.startsWith('/todos') || path.startsWith('/chat'))
          return route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><html data-theme="${software ? 'light' : 'dark'}" data-accent="${software ? 'teal' : 'mint'}" data-font="${software ? 'georgia' : 'system'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
          });
        if (path === '/api/telos/work/links') {
          const input = route.request().postDataJSON();
          return route.fulfill({
            json: work.links.filter(
              (link) => link.conversation.conversationId === input.conversationId,
            ),
          });
        }
        if (path === '/api/telos/work/controls' && route.request().method() === 'POST') {
          const input = TelosWorkControlCommandSchema.safeParse(route.request().postDataJSON());
          if (input.success && input.data.operation === 'inbox' && input.data.itemId === 'slice') {
            controlInboxReads.push(input.data.itemId);
            return route.fulfill({ json: [] });
          }
        }
        if (route.request().method() !== 'GET') {
          writes.push(path);
          return route.fulfill({ status: 405, json: { error: 'No implicit writes allowed' } });
        }
        if (path === '/api/todos') {
          readCounts.todos++;
          return route.fulfill({
            json: {
              profiles: ['manual'],
              items: [
                { ...legacy, children: collectionChildren, childCount: collectionChildren.length },
              ],
            },
          });
        }
        for (const added of [reconnectChild, resumeChild]) {
          if (path === `/api/telos/work/items/${added.itemId}/record`)
            return route.fulfill({ json: added });
          if (path === `/api/telos/work/items/${added.itemId}`)
            return route.fulfill({
              json: {
                ...work,
                itemId: added.itemId,
                parentId: 'slice',
                links: [],
                assignments: [],
                sources: [],
                attempts: [],
              },
            });
        }
        if (path === '/api/telos/work/items/child/record') return route.fulfill({ json: child });
        if (path === '/api/telos/work/items/child')
          return route.fulfill({
            json: {
              ...work,
              itemId: 'child',
              parentId: 'slice',
              links: [],
              assignments: [],
              sources: [],
              attempts: [],
            },
          });
        if (path === '/api/telos/work/items/slice/sources/source-review')
          return route.fulfill({ json: sourceView });
        if (path === '/api/telos/work/items/slice') return route.fulfill({ json: work });
        if (path === '/api/telos/work/items/slice/record') return route.fulfill({ json: record });
        if (path === '/api/telos/work/conversations/links')
          return route.fulfill({
            json: work.links.filter(
              (link) => link.conversation.conversationId === url.searchParams.get('conversationId'),
            ),
          });
        if (path.includes('/artifacts'))
          return route.fulfill({ json: { artifacts: [], hasMore: false } });
        const session = path.match(
          /^\/api\/sessions\/(worker|reviewer)\/(meta|messages|symposium\/status)$/,
        );
        if (session) {
          const id = session[1];
          if (session[2] === 'meta') {
            if (holdMetadata && id === 'worker') await metadataHeld;
            return route.fulfill({
              json: {
                sessionId: id,
                sessionType: 'chat',
                isHidden: false,
                isActive: false,
                accountBinding: {
                  ...inventory.accounts[0].account,
                  accountLabel: 'Offline personal account',
                  model: id === 'reviewer' ? 'luna-review-fixture' : 'luna-fixture',
                },
                runtimeBinding: {
                  version: 2,
                  account: inventory.accounts[0].account,
                  harness: { implementation: 'codex' },
                  execution: { location: 'local', targetId: 'mac', targetRevision: 'target-r1' },
                },
                runtimeCommandScope: 'conversation',
                agentProfile: inventory.agentProfiles[0],
                modelSelection: {
                  model: id === 'reviewer' ? 'luna-review-fixture' : 'luna-fixture',
                  reasoningEffort: id === 'reviewer' ? 'high' : 'low',
                  models: inventory.accounts[0].models,
                },
                ...(software
                  ? { repositoryWorkspaceId: 'repository-fixture' }
                  : { ordinaryWorkspaceId: '11111111-1111-4111-8111-111111111111' }),
              },
            });
          }
          if (session[2] === 'messages')
            return route.fulfill({
              json: [
                {
                  messageId: id,
                  role: 'assistant',
                  blocks: [
                    {
                      blockId: id,
                      blockType: 'text',
                      content:
                        id === 'worker'
                          ? 'Worker retained transcript'
                          : 'Reviewer retained transcript',
                    },
                  ],
                },
              ],
            });
          return route.fulfill({ json: { sessionId: id, config: null, seats: [] } });
        }
        if (path === '/api/sessions')
          return route.fulfill({
            json: {
              sessions: ['worker', 'reviewer'].map((id) => ({
                id,
                summary: `${id} conversation`,
                isActive: false,
                lastModified: 1,
                totalTokens: 0,
              })),
              hasMore: false,
            },
          });
        if (path === '/api/tasks') {
          readCounts.tasks++;
          return route.fulfill({
            json: {
              tasks: [
                {
                  id: 'execution-worker',
                  parentId: null,
                  title: taskTitle,
                  description: null,
                  status: taskDone ? 'done' : 'pending_review',
                  sessionId: 'worker',
                  sessionPolicy: 'reuse',
                  priority: 7,
                  depth: 0,
                  annotations: [],
                  summary: null,
                  requiresApproval: true,
                  tokenUsage: 0,
                  claimedBy: null,
                  claimedAt: null,
                  createdAt: 1,
                  updatedAt: 1,
                  completedAt: null,
                  stageType: null,
                  gateConfig: null,
                  artifacts: null,
                  retryCount: 0,
                  maxRetries: 0,
                  templateId: null,
                  children: [],
                },
              ],
            },
          });
        }
        if (path === '/api/loop/status')
          return route.fulfill({
            json: {
              state: 'idle',
              goalId: null,
              activeTaskId: null,
              progress: null,
              specMode: false,
              awaitingApproval: false,
              spawnEnabled: false,
            },
          });
        if (path === '/api/chat/runtime/capabilities') return route.fulfill({ json: inventory });
        if (path === '/api/accounts')
          return route.fulfill({
            json: [
              {
                id: 'personal',
                label: 'Offline personal account',
                models: [
                  { id: 'luna-fixture', label: 'Luna fixture', reasoningEfforts: ['low', 'high'] },
                ],
              },
            ],
          });
        if (path === '/api/agent-library')
          return route.fulfill({
            json: { drafts: [], versions: localInventoryFixture().agentProfiles },
          });
        if (path === '/api/repository-workspaces/catalog')
          return route.fulfill({ json: { available: true, repositories: [] } });
        if (path === '/api/home/preferences')
          return route.fulfill({
            json: { revision: 0, names: { briefing: 'Minion', terminal: 'Minion' }, pins: [] },
          });
        if (path === '/api/service-health')
          return route.fulfill({ json: { services: [], checkedAt: 1 } });
        if (path === '/api/events')
          return route.fulfill({ contentType: 'text/event-stream', body: '' });
        if (['/mitzo-icon.png', '/mitzo-wordmark.png'].includes(path))
          return route.fulfill({
            body: await readFile('frontend/public' + path),
            contentType: 'image/png',
          });
        return route.fulfill({
          json:
            path.includes('skills') || path.includes('briefing-chats') || path.includes('proposals')
              ? []
              : {},
        });
      });
      if (regression) {
        work.links = work.links.filter((link) => link.conversation.conversationId === 'worker');
        await page.addInitScript(() => sessionStorage.setItem('telos.item.tab.slice', 'Chat'));
        await page.goto('/chat/worker?telosChatItem=slice');
        await expect(page.getByText('Worker retained transcript', { exact: true })).toBeVisible();
        const draft = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
        await draft.fill('Retain review regression draft');
        if (regression === 'view-item') {
          await page.getByRole('button', { name: 'View item: ' + record.summary }).click();
          await expect(page).toHaveURL(/\/todos\/slice\?view=Overview$/);
          await expect(
            page
              .getByRole('navigation', { name: 'Item views' })
              .getByRole('button', { name: 'Overview', exact: true }),
          ).toHaveAttribute('aria-pressed', 'true');
          await page.screenshot({
            path: info.outputPath('review-view-item-overview.png'),
            fullPage: true,
          });
        } else {
          await page.getByRole('button', { name: 'Toggle work tree' }).click();
          const region = page.getByRole('region', { name: 'Work tree' });
          await region.getByRole('button', { name: 'Expand all' }).click();
          await expect(
            region.getByRole('button', { name: child.summary, exact: true }),
          ).toBeVisible();
          await expect(
            region.getByText('Awaiting review · Review evidence', { exact: true }),
          ).toBeVisible();
          const before = { ...readCounts };
          await page.evaluate(() => window.fixtureConnection(false));
          collectionChildren = [
            childLegacy,
            { ...childLegacy, id: reconnectChild.itemId, summary: reconnectChild.summary },
          ];
          taskDone = true;
          await page.evaluate(() => window.fixtureConnection(true));
          await expect
            .soft(region.getByRole('button', { name: reconnectChild.summary, exact: true }))
            .toBeVisible();
          await expect
            .soft(region.getByText('Task done · Review evidence', { exact: true }))
            .toBeVisible();
          expect(readCounts.todos).toBeGreaterThan(before.todos);
          expect(readCounts.tasks).toBeGreaterThan(before.tasks);
          await expect(
            region
              .locator('.telos-tree-row[aria-current="page"]')
              .getByText('active', { exact: true }),
          ).toBeVisible();
          await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', {
              configurable: true,
              value: 'hidden',
            });
            document.dispatchEvent(new Event('visibilitychange'));
          });
          collectionChildren = [
            ...collectionChildren,
            { ...childLegacy, id: resumeChild.itemId, summary: resumeChild.summary },
          ];
          taskTitle = 'Review resumed evidence';
          await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', {
              configurable: true,
              value: 'visible',
            });
            document.dispatchEvent(new Event('visibilitychange'));
          });
          await expect(
            region.getByRole('button', { name: resumeChild.summary, exact: true }),
          ).toBeVisible();
          await expect(
            region.getByText('Task done · Review resumed evidence', { exact: true }),
          ).toBeVisible();
          await page.screenshot({
            path: info.outputPath('review-reconnected-tree.png'),
            fullPage: true,
          });
          await expect(
            region
              .locator('.telos-tree-row[aria-current="page"]')
              .getByText('active', { exact: true }),
          ).toBeVisible();
          await page.getByRole('button', { name: 'Close work tree' }).click();
          await expect(page.getByRole('button', { name: 'Toggle work tree' })).toBeFocused();
          await expect(draft).toHaveValue('Retain review regression draft');
        }
        expect(writes).toEqual([]);
        expect(errors).toEqual([]);
        return;
      }
      await page.goto('/todos');
      await page.getByRole('button', { name: 'Browse categories' }).click();
      await page
        .getByLabel('Discover categories')
        .getByRole('button', { name: 'Job', exact: true })
        .click();
      await page.getByRole('searchbox', { name: 'Search Telos tree' }).fill(record.summary);
      await page.getByRole('button', { name: record.summary, exact: true }).click();
      await page
        .getByRole('navigation', { name: 'Item views' })
        .getByRole('button', { name: 'Chat', exact: true })
        .click();
      await expect(page.getByRole('heading', { name: 'Chats · 2' })).toBeVisible();
      await expect(
        page.getByRole('button', { name: /^Open Assigned worker(?:\b|:)/ }),
      ).toContainText('worker conversation');
      await page.screenshot({
        path: info.outputPath(`s8-chooser-${software ? 'repository' : 'ordinary'}.png`),
        fullPage: true,
      });
      holdMetadata = true;
      await page.getByRole('button', { name: /^Open Assigned worker(?:\b|:)/ }).click();
      try {
        const immediateBack = page.getByRole('link', { name: 'Back', exact: true });
        await expect(immediateBack).toHaveAttribute('href', '/todos/slice?view=Chat&chooseChat=1');
        await expect(
          page.getByRole('button', { name: 'View item: ' + record.summary }),
        ).toHaveCount(0);
        await immediateBack.click();
        await expect(page.getByRole('heading', { name: 'Chats · 2' })).toBeVisible();
      } finally {
        holdMetadata = false;
        releaseMetadata();
      }
      await page.getByRole('button', { name: /^Open Assigned worker(?:\b|:)/ }).click();
      await expect(page).toHaveURL(/\/chat\/worker\?telosChatItem=slice$/);
      await expect(page.getByText('Worker retained transcript', { exact: true })).toBeVisible();
      const input = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
      await input.fill('Worker independent draft');
      const workerSettings = await settingsHome(page);
      await expect(settingRow(workerSettings, 'Model')).toContainText('Luna fixture');
      await page.getByRole('button', { name: /^Workspace controls/ }).click();
      await expect(input).toHaveValue('Worker independent draft');
      await page.getByRole('button', { name: 'Open session tray', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Resources', exact: true })).toBeVisible();
      await page
        .getByRole('dialog', { name: 'Resources', exact: true })
        .getByRole('button', { name: 'Close', exact: true })
        .click();
      await expect(input).toHaveValue('Worker independent draft');
      await expect(page).toHaveURL(/\/chat\/worker\?telosChatItem=slice$/);

      await expect(
        page.getByRole('button', { name: 'View item: ' + record.summary }),
      ).toBeVisible();
      const back = page.getByRole('link', { name: 'Back', exact: true });
      await expect(back).toHaveCount(1);
      const tree = page.getByRole('button', { name: 'Toggle work tree' });
      await expect(tree).toHaveAttribute('aria-expanded', 'false');
      await tree.click();
      await expect(
        page.getByRole('region', { name: 'Work tree' }).getByText('P7', { exact: true }),
      ).toBeVisible();
      await expect(page.getByText('Awaiting review', { exact: false })).toBeVisible();
      await page.evaluate(async () => {
        await Promise.all(
          document.getAnimations().map((animation) => animation.finished.catch(() => {})),
        );
      });
      await expect(page.locator('.telos-chat-tree-presence')).toHaveCSS('opacity', '1');
      await page.screenshot({
        path: info.outputPath(`s8-work-tree-${software ? 'repository' : 'ordinary'}.png`),
        fullPage: true,
      });
      await page.getByRole('button', { name: 'Close work tree' }).click();
      await expect(tree).toBeFocused();
      await expect(input).toHaveValue('Worker independent draft');
      await back.click();
      await expect(page.getByRole('heading', { name: 'Chats · 2' })).toBeVisible();
      await page.getByRole('button', { name: /^Open Reviewer(?:\b|:)/ }).click();
      await expect(page.getByText('Reviewer retained transcript', { exact: true })).toBeVisible();
      await expect(input).toHaveValue('');
      await input.fill('Reviewer independent draft');
      const reviewerSettings = await settingsHome(page);
      await expect(settingRow(reviewerSettings, 'Model')).toContainText('Luna review fixture');
      await page.getByRole('button', { name: /^Workspace controls/ }).click();
      await page.getByRole('button', { name: 'Chats for this item: 2' }).click();
      const restoredWorkerReads = ['/api/telos/work/controls', '/api/todos'].map((path) =>
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === path &&
            response.request().headers()['referer']?.includes('/chat/worker') === true,
        ),
      );
      await page.getByRole('button', { name: /^Open Assigned worker(?:\b|:)/ }).click();
      await expect(input).toHaveValue('Worker independent draft');
      for (const response of await Promise.all(restoredWorkerReads)) {
        expect(response.ok()).toBe(true);
        expect(await response.finished()).toBeNull();
      }
      await expect(page.getByText('Worker retained transcript', { exact: true })).toBeVisible();
      await expect(page.getByText(/^(Loading|Refreshing) coordination receipts…$/)).toHaveCount(0);
      await page.reload();
      await expect(input).toHaveValue('Worker independent draft');
      await page.screenshot({
        path: info.outputPath(`s8-route-${software ? 'repository' : 'ordinary'}.png`),
        fullPage: true,
      });
      await page.getByRole('button', { name: 'Toggle work tree' }).click();
      taskDone = true;
      record.priority = 8;
      await page.evaluate(() => {
        window.fixtureTodoEvents.dispatchEvent(new MessageEvent('todo_update', { data: '{}' }));
        window.fixtureTodoEvents.dispatchEvent(new MessageEvent('task_state', { data: '{}' }));
      });
      const refreshedTree = page.getByRole('region', { name: 'Work tree' });
      await expect(refreshedTree.getByText('P8', { exact: true })).toBeVisible();
      await expect(
        refreshedTree.getByText('Task done · Review evidence', { exact: true }),
      ).toBeVisible();
      await expect(refreshedTree.getByText('active', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Close work tree' }).click();
      await expect(input).toHaveValue('Worker independent draft');
      await page.evaluate(() =>
        sessionStorage.setItem('telos.item.history.child', JSON.stringify(['stale-item'])),
      );
      const retainedState = await page.evaluate(() => history.state.usr.telosChatReturn.state);
      await page.getByRole('button', { name: 'Toggle work tree' }).click();
      await page
        .getByRole('region', { name: 'Work tree' })
        .getByRole('button', { name: 'Expand all' })
        .click();
      await page
        .getByRole('region', { name: 'Work tree' })
        .getByRole('button', { name: child.summary, exact: true })
        .click();
      await expect(page).toHaveURL(/\/todos\/child$/);
      expect(await page.evaluate(() => history.state.usr.activeProfile)).toBe(
        retainedState.activeProfile,
      );
      expect(await page.evaluate(() => history.state.usr.scrollTop)).toBe(retainedState.scrollTop);
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(page).toHaveURL(/\/todos\/slice$/);
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(page).toHaveURL(/\/todos$/);
      await expect(page.getByRole('searchbox', { name: 'Search Telos tree' })).toHaveValue(
        record.summary,
      );
      await expect(page.getByRole('button', { name: 'Job', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await page.getByRole('button', { name: record.summary, exact: true }).click();
      work.sources = [sourceView.snapshot];
      await page
        .getByRole('navigation', { name: 'Item views' })
        .getByRole('button', { name: 'Materials', exact: true })
        .click();
      const sourceReturnState = await page.evaluate(() => history.state.usr);
      await page.getByRole('button', { name: 'Open original chat', exact: true }).click();
      await expect(page).toHaveURL(/\/chat\/worker\?telosItem=slice&telosSource=source-review$/);
      await expect(
        page.getByRole('button', { name: 'View item: ' + record.summary }),
      ).toBeVisible();
      expect(await page.evaluate(() => history.state.usr.telosChatReturn.state)).toEqual(
        sourceReturnState,
      );
      await expect(input).toHaveValue('Worker independent draft');
      await page.evaluate(() => sessionStorage.setItem('telos.item.tab.slice', 'Chat'));
      await page.getByRole('link', { name: 'Back', exact: true }).click();
      await expect(page).toHaveURL(/\/todos\/slice\?view=Materials$/);
      await expect(
        page
          .getByRole('navigation', { name: 'Item views' })
          .getByRole('button', { name: 'Materials', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
      expect(await page.evaluate(() => history.state.usr)).toEqual(sourceReturnState);
      await page
        .getByRole('navigation', { name: 'Item views' })
        .getByRole('button', { name: 'Chat', exact: true })
        .click();
      await expect(page.getByRole('heading', { name: 'Chats · 2' })).toBeVisible();
      work.links = work.links.filter((link) => link.role !== 'reviewer');
      await page.evaluate(() => {
        const events = window.fixtureTodoEvents as EventTarget & {
          onerror: (() => void) | null;
          onopen: (() => void) | null;
        };
        events.onerror?.();
        events.onopen?.();
      });
      await expect(page.getByRole('heading', { name: 'Chats · 1' })).toBeVisible();
      await expect(page).toHaveURL(/\/todos\/slice$/);
      expect(writes).toEqual([]);
      expect(controlInboxReads.length).toBeGreaterThan(0);
      expect(errors).toEqual([]);
    },
  );
