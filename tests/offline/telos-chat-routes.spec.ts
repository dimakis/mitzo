import { settingsHome, settingRow } from '../support/chat-settings';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { TelosWorkItemSchema, TelosWorkViewSchema } from '@mitzo/protocol';
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
for (const software of [false, true])
  test(`S8 actual item and ordinary routes retain chat ownership (${software ? 'repository' : 'non-code'})`, async ({
    page,
    isMobile,
  }, info) => {
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
      if (route.request().method() !== 'GET') {
        writes.push(path);
        return route.fulfill({ status: 405, json: { error: 'No implicit writes allowed' } });
      }
      if (path === '/api/todos')
        return route.fulfill({ json: { profiles: ['manual'], items: [legacy] } });
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
        if (session[2] === 'meta')
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
      if (path === '/api/tasks')
        return route.fulfill({
          json: {
            tasks: [
              {
                id: 'execution-worker',
                parentId: null,
                title: 'Review evidence',
                description: null,
                status: 'pending_review',
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
    await page.goto('/todos/slice?view=Chat');
    await expect(page.getByRole('heading', { name: 'Chats · 2' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Open Assigned worker(?:\b|:)/ })).toContainText(
      'worker conversation',
    );
    await page.screenshot({
      path: info.outputPath(`s8-chooser-${software ? 'repository' : 'ordinary'}.png`),
      fullPage: true,
    });
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

    await expect(page.getByRole('button', { name: 'View item: ' + record.summary })).toBeVisible();
    const back = page.getByRole('link', { name: 'Back', exact: true });
    await expect(back).toHaveCount(1);
    const tree = page.getByRole('button', { name: 'Toggle work tree' });
    await expect(tree).toHaveAttribute('aria-expanded', 'false');
    await tree.click();
    await expect(
      page.getByRole('region', { name: 'Work tree' }).getByText('P7', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Awaiting review', { exact: false })).toBeVisible();
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
    await page.getByRole('button', { name: /^Open Assigned worker(?:\b|:)/ }).click();
    await expect(input).toHaveValue('Worker independent draft');
    await page.reload();
    await expect(input).toHaveValue('Worker independent draft');
    await page.screenshot({
      path: info.outputPath(`s8-route-${software ? 'repository' : 'ordinary'}.png`),
      fullPage: true,
    });
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });
