import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { createTelosWorkFixtures } from '../../frontend/src/test-utils/telos-work-fixtures';
import { localInventoryFixture } from '../../frontend/src/test-utils/local-inventory-fixture';
import type { TelosWorkControlView } from '@mitzo/protocol';

test.use({ baseURL: 'https://mitzo-ui.test' });
const bundle = build({
  entryPoints: [resolve('tests/fixtures/telos-chat-routes.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/telos-coordinator-controls.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});
for (const scope of ['new_worker_dispatch', 'publication', 'safe_point'] as const)
  test(`ordinary coordinator request/receipt/release preserves chat (${scope})`, async ({
    page,
    isMobile,
  }, info) => {
    const files = (await bundle).outputFiles!;
    const inventory = localInventoryFixture();
    const source = createTelosWorkFixtures().homeStudio.items[0];
    const coordinator = {
      ...source,
      itemId: 'coordinator',
      parentId: null,
      kind: 'coordinator' as const,
      summary: 'Feature programme',
    };
    const outcomes = Array.from({ length: 6 }, (_, i) => ({
      ...source,
      itemId: `outcome-${i}`,
      parentId: 'coordinator',
      kind: 'outcome' as const,
      summary: `Feature ${i}`,
    }));
    const workers = outcomes.slice(1).map((r, i) => ({
      ...source,
      itemId: `worker-${i}`,
      parentId: r.itemId,
      kind: 'work_item' as const,
      summary: `Worker ${i}`,
    }));
    const job = {
      ...source,
      itemId: 'job',
      parentId: null,
      kind: 'work_item' as const,
      summary: 'Unrelated Job',
    };
    const records = [coordinator, ...outcomes, ...workers, job];
    const conversation = (id: string) =>
      id === 'coordinator'
        ? 'coordinator-chat'
        : id === 'job'
          ? 'job-chat'
          : id.startsWith('worker-')
            ? `native-${id.split('-')[1]}`
            : `lead-${id.split('-')[1]}`;
    const work = (id: string) => {
      const r = records.find((r) => r.itemId === id)!;
      return {
        itemId: id,
        kind: r.kind,
        parentId: r.parentId,
        revision: 'a'.repeat(64),
        sources: [],
        attempts: [],
        links: [
          {
            version: 1,
            linkId: id,
            itemId: id,
            role: r.kind === 'work_item' ? 'worker' : 'lead',
            conversation: { namespace: 'mitzo', conversationId: conversation(id) },
            linkedAt: null,
            linkedBy: null,
            availability: 'available',
            attemptId: null,
          },
        ],
        assignments: [
          {
            itemId: id,
            role: r.kind === 'work_item' ? 'worker' : 'lead',
            conversation: { namespace: 'mitzo', conversationId: conversation(id) },
            revision: 1,
            assignedAt: null,
            assignedBy: null,
          },
        ],
      };
    };
    function legacy(id: string): unknown {
      const r = records.find((r) => r.itemId === id)!;
      const children = records.filter((c) => c.parentId === id).map((c) => legacy(c.itemId));
      return {
        ...r,
        id,
        urgency: 0.5,
        ageDays: 0,
        children,
        childCount: children.length,
        completedChildCount: 0,
        goalId: null,
      };
    }
    let retained: TelosWorkControlView | null = null;
    const calls: Record<string, unknown>[] = [],
      unexpected: string[] = [],
      errors: string[] = [];
    function projection(stage: TelosWorkControlView['stage']): TelosWorkControlView {
      return {
        version: 1,
        controlId: 'control',
        coordinatorItemId: 'coordinator',
        coordinatorConversationId: 'coordinator-chat',
        priorityItemId: 'outcome-0',
        scope,
        stage,
        publicationRevalidation:
          stage === 'released' && scope === 'publication' ? 'required' : 'not_applicable',
        targets: outcomes.slice(1).map((r, i) => ({
          itemId: r.itemId,
          leadConversationId: conversation(r.itemId),
          assignmentRevision: 1,
          stage: stage === 'released' ? 'acknowledged' : stage,
          workers: [
            {
              itemId: workers[i].itemId,
              conversationId: conversation(workers[i].itemId),
              assignmentRevision: 1,
              stage: stage === 'acknowledged' || stage === 'released' ? 'requested' : stage,
            },
          ],
        })),
        history: [],
      };
    }
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 850 });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const file = files.find(
        (file) => path === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (path.startsWith('/chat') || path.startsWith('/todos'))
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html data-theme="${scope === 'publication' ? 'light' : 'dark'}" data-accent="${scope === 'publication' ? 'teal' : 'mint'}" data-font="${scope === 'publication' ? 'georgia' : 'system'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
        });
      if (path === '/api/telos/work/controls') {
        const command = route.request().postDataJSON();
        calls.push(command);
        if (command.operation === 'inbox')
          return route.fulfill({
            json:
              retained &&
              (command.itemId === 'coordinator' ||
                retained.targets.some(
                  (t) =>
                    t.itemId === command.itemId ||
                    t.workers.some((w) => w.itemId === command.itemId),
                ))
                ? [retained]
                : [],
          });
        if (command.operation === 'read') return route.fulfill({ json: retained });
        if (command.operation === 'request') {
          retained = projection('requested');
          return route.fulfill({ json: retained });
        }
        if (command.operation === 'release') {
          retained = projection('released');
          return route.fulfill({ json: retained });
        }
        unexpected.push('forbidden-control:' + command.operation);
        return route.fulfill({ status: 403, json: { error: 'Native recipient required' } });
      }
      if (path === '/api/telos/work/links') {
        const { conversationId } = route.request().postDataJSON();
        return route.fulfill({
          json: records
            .filter((r) => conversation(r.itemId) === conversationId)
            .flatMap((r) => work(r.itemId).links),
        });
      }
      if (route.request().method() !== 'GET') {
        unexpected.push(path);
        return route.fulfill({ status: 405, json: { error: 'No implicit write' } });
      }
      if (path === '/api/todos')
        return route.fulfill({
          json: { profiles: ['manual'], items: [legacy('coordinator'), legacy('job')] },
        });
      const item = path.match(/^\/api\/telos\/work\/items\/([^/]+)(\/record)?$/);
      if (item)
        return route.fulfill({
          json: item[2] ? records.find((r) => r.itemId === item[1]) : work(item[1]),
        });
      if (path === '/api/sessions')
        return route.fulfill({
          json: {
            sessions: records.map((r) => ({
              id: conversation(r.itemId),
              summary: r.summary,
              lastModified: 1,
              isActive: false,
              totalTokens: 0,
            })),
            hasMore: false,
          },
        });
      const meta = path.match(/^\/api\/sessions\/([^/]+)\/(meta|messages|symposium\/status)$/);
      if (meta) {
        if (meta[2] === 'messages') return route.fulfill({ json: [] });
        if (meta[2] === 'symposium/status')
          return route.fulfill({ json: { sessionId: meta[1], config: null, seats: [] } });
        return route.fulfill({
          json: {
            sessionId: meta[1],
            sessionType: 'chat',
            isHidden: false,
            isActive: false,
            accountBinding: {
              ...inventory.accounts[0].account,
              accountLabel: 'Offline personal account',
              model: 'luna-fixture',
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
              model: 'luna-fixture',
              reasoningEffort: 'low',
              models: inventory.accounts[0].models,
            },
            ordinaryWorkspaceId: '11111111-1111-4111-8111-111111111111',
          },
        });
      }
      if (path === '/api/chat/runtime/capabilities') return route.fulfill({ json: inventory });
      if (path === '/api/tasks') return route.fulfill({ json: { tasks: [] } });
      if (path === '/api/home/preferences')
        return route.fulfill({
          json: { revision: 0, names: { briefing: 'Minion', terminal: 'Minion' }, pins: [] },
        });
      if (path === '/api/service-health')
        return route.fulfill({ json: { services: [], checkedAt: 1 } });
      if (path === '/api/agent-library')
        return route.fulfill({ json: { drafts: [], versions: inventory.agentProfiles } });
      if (path === '/api/repository-workspaces/catalog')
        return route.fulfill({ json: { available: true, repositories: [] } });
      return route.fulfill({
        json:
          path.includes('skills') || path.includes('proposals') || path.includes('briefing-chats')
            ? []
            : {},
      });
    });
    await page.goto('/chat/coordinator-chat?telosChatItem=coordinator');
    const draft = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
    await expect(draft).toBeVisible();
    await draft.fill('Retain coordinator draft');
    await draft.evaluate((el) => {
      el.dataset.controlDraft = 'original';
    });
    const controls = page.getByRole('region', { name: 'Coordinator controls' });
    await expect(controls.getByRole('button', { name: 'Feature 0', exact: true })).toBeEnabled();
    expect(calls.every((c) => c.operation === 'inbox')).toBe(true);
    const geometry = await controls.locator('button, select').evaluateAll((elements) =>
      elements.map((element) => ({
        label: element.textContent,
        height: element.getBoundingClientRect().height,
      })),
    );
    expect(
      geometry.every((value) => value.height >= 44),
      JSON.stringify(geometry),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath(`coordinator-${scope}-request.png`),
      fullPage: true,
    });
    await controls.getByRole('button', { name: 'Feature 0', exact: true }).click();
    await controls.getByRole('combobox', { name: 'Hold scope' }).selectOption(scope);
    await controls.getByRole('button', { name: 'Send hold to five leads' }).click();
    await expect(
      controls.getByRole('heading', { name: 'Hold requested · acknowledgements pending' }),
    ).toBeVisible();
    expect(calls.find((c) => c.operation === 'request')).toEqual({
      operation: 'request',
      requestId: expect.any(String),
      coordinatorItemId: 'coordinator',
      priorityItemId: 'outcome-0',
      targetItemIds: outcomes.slice(1).map((r) => r.itemId),
      scope,
    });
    retained = projection('acknowledged');
    await controls.getByRole('button', { name: 'Check acknowledgements' }).click();
    await expect(
      controls.getByRole('heading', { name: 'Acknowledged · application pending' }),
    ).toBeVisible();
    if (scope === 'new_worker_dispatch') {
      retained = projection('applied');
      await controls.getByRole('button', { name: 'Check acknowledgements' }).click();
      await expect(
        controls.getByRole('heading', { name: 'Hold applied', exact: true }),
      ).toBeVisible();
    }
    await controls.getByRole('button', { name: 'Inspect work tree' }).click();
    await expect(page.getByRole('region', { name: 'Work tree', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close work tree' }).click();
    await expect(page.getByRole('region', { name: 'Work tree', exact: true })).toHaveCount(0);
    await expect(page.locator('.telos-chat-tree-presence')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Toggle work tree' })).toBeFocused();
    await expect(draft).toHaveValue('Retain coordinator draft');
    await expect(draft).toHaveAttribute('data-control-draft', 'original');
    await controls.getByRole('heading').first().scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`coordinator-${scope}-receipt.png`),
      fullPage: true,
    });
    await controls.getByRole('button', { name: 'Release held leads' }).click();
    await expect(
      controls.getByRole('heading', {
        name: scope === 'publication' ? 'Hold released · revalidation required' : 'Hold released',
        exact: true,
      }),
    ).toBeVisible();
    if (scope === 'publication')
      await expect(controls.getByText(/Current-main revalidation is required/)).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('heading', {
        name: scope === 'publication' ? 'Hold released · revalidation required' : 'Hold released',
        exact: true,
      }),
    ).toBeVisible();
    expect(calls.filter((c) => c.operation === 'request')).toHaveLength(1);
    expect(calls.filter((c) => c.operation === 'release')).toHaveLength(1);
    await page.goto('/chat/native-0?telosChatItem=worker-0');
    const child = page.getByRole('region', { name: 'Scoped coordination receipt' });
    await expect(child.getByText('Worker 0', { exact: true })).toBeVisible();
    await expect(child.getByText('Worker 1', { exact: true })).toHaveCount(0);
    await expect(child.getByRole('button', { name: 'Release held leads' })).toHaveCount(0);
    await page.goto('/chat/job-chat?telosChatItem=job');
    await expect(page.getByRole('textbox', { name: 'Message Mitzo', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Scoped coordination receipt' })).toHaveCount(0);
    expect(
      calls.every((c) => ['inbox', 'read', 'request', 'release'].includes(c.operation as string)),
    ).toBe(true);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
