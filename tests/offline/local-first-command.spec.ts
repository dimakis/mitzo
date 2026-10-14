import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { ordinaryRuntimeInventoryFixture } from '../../frontend/src/test-utils/ordinary-runtime-inventory-fixture';
import { localInventoryFixture } from '../../frontend/src/test-utils/local-inventory-fixture';
import {
  OrdinaryCodexFirstCommandSchema,
  OrdinaryCodexContinuationCommandSchema,
} from '../../packages/protocol/src/local-codex-first-command';
import { SwitchSessionMessage } from '../../packages/protocol/src/ws-schemas-v2';
test.use({ baseURL: 'https://mitzo-ui.test' });
const preparationId = '11111111-1111-4111-8111-111111111111';
const sessionId = 'local-fixture';
const intent = {
  version: 1,
  account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
  agentProfile: { profileId: 'agent', revision: 1 },
  execution: { location: 'local', targetId: 'mac' },
  capabilityRevision: 'caps-r1',
};
async function offline(
  page: Page,
  gateOff = false,
  restore = false,
  continuation = false,
  location: 'local' | 'openshell' = 'local',
) {
  const requests: unknown[] = [];
  const attachments: Array<string | null> = [];
  const controls: string[] = [];
  const forbidden: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(
    ({ restore, intent }) => {
      localStorage.setItem('mitzo:transport', 'sse');
      localStorage.setItem('mitzo-workspace-controls-expanded', '1');
      if (restore)
        localStorage.setItem(
          'mitzo-chat-draft:local-restored',
          JSON.stringify({
            version: 1,
            id: 'local-restored',
            text: 'Inspect the repository',
            images: [],
            contextBlocks: [],
            updatedAt: 1,
            settings: {
              runtimeSelection: intent,
              selection: intent.account,
              mode: 'agent',
              isolation: true,
              repositoryWorkspaceId: null,
              search: 'agentProfile=agent&profileRevision=1',
              summary: null,
            },
          }),
        );
      class OfflineEventSource extends EventTarget {
        readyState = 1;
        onmessage: ((event: MessageEvent) => void) | null = null;
        constructor(url: string) {
          super();
          if (url.includes('/api/chat/events')) {
            (window as unknown as Record<string, unknown>).__localFixtureSource = this;
            setTimeout(
              () =>
                this.dispatchEvent(
                  new MessageEvent('welcome', {
                    data: JSON.stringify({ connectionId: 'local-offline-sse' }),
                  }),
                ),
              0,
            );
          }
        }
        close() {
          this.readyState = 2;
        }
      }
      window.EventSource = OfflineEventSource as unknown as typeof EventSource;
    },
    { restore, intent },
  );
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') {
      forbidden.push(url.href);
      return route.abort();
    }
    const method = route.request().method();
    if (method === 'POST' && /^\/api\/chat\/(?:interrupt|stop|close|archive)$/.test(url.pathname))
      controls.push(url.pathname);
    const binding = {
      version: 2,
      account: localInventoryFixture().accounts[0].account,
      harness: { implementation: 'codex' },
      execution: {
        location,
        targetId: location === 'local' ? 'mac' : 'sandbox',
        targetRevision: 'target-r1',
      },
    };
    if (
      url.pathname === '/api/chat/runtime/capabilities' ||
      url.pathname === '/api/chat/local-codex/capabilities'
    )
      return route.fulfill(
        gateOff
          ? { status: 503, json: { ok: false, code: 'entry_disabled', error: 'Unavailable' } }
          : {
              json:
                location === 'local' ? localInventoryFixture() : ordinaryRuntimeInventoryFixture(),
            },
      );
    if (
      url.pathname === '/api/chat/local-codex/send' ||
      url.pathname === '/api/chat/local-codex/continue' ||
      url.pathname === '/api/chat/runtime/send' ||
      url.pathname === '/api/chat/runtime/continue'
    ) {
      const request = (
        url.pathname.endsWith('/continue')
          ? OrdinaryCodexContinuationCommandSchema
          : OrdinaryCodexFirstCommandSchema
      ).parse(route.request().postDataJSON());
      requests.push(request);
      expect(route.request().headers()['x-connection-id']).toBe('local-offline-sse');
      await route.fulfill({
        status: 202,
        json: {
          ok: true,
          clientMsgId: request.clientMsgId,
          sessionId,
          dispatched: true,
          state: 'consumed',
        },
      });
      return;
    }
    if (url.pathname === '/api/chat/switch') {
      expect(method).toBe('POST');
      expect(route.request().headers()['x-connection-id']).toBe('local-offline-sse');
      const selection = SwitchSessionMessage.strict().parse(route.request().postDataJSON());
      expect([sessionId, null]).toContain(selection.sessionId);
      attachments.push(selection.sessionId);
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === '/api/chat/send' || url.pathname.endsWith('/selection')) {
      forbidden.push(url.pathname);
      return route.fulfill({ status: 409, json: { error: 'Legacy route prohibited in fixture' } });
    }
    if (url.pathname === '/api/repository-workspaces/preview' && method === 'POST')
      return route.fulfill({
        json: {
          id: preparationId,
          repository: 'owner/repository',
          baseBranch: 'main',
          baseOid: 'a'.repeat(40),
          featureBranch: 'task-fixture',
          state: 'preview',
        },
      });
    if (url.pathname === `/api/repository-workspaces/${preparationId}/prepare` && method === 'POST')
      return route.fulfill({
        json: {
          id: preparationId,
          repository: 'owner/repository',
          baseBranch: 'main',
          baseOid: 'a'.repeat(40),
          featureBranch: 'task-fixture',
          state: 'ready',
        },
      });
    if (url.pathname === '/api/repository-workspaces/catalog')
      return route.fulfill({
        json: {
          available: true,
          repositories: [
            { connectionId: 'github', repository: 'owner/repository', label: 'GitHub fixture' },
          ],
        },
      });
    if (url.pathname === `/api/sessions/${sessionId}/meta`)
      return route.fulfill({
        json: {
          sessionId,
          sessionType: 'chat',
          mode: 'agent',
          runtimeBinding: binding,
          runtimeCommandScope: continuation ? 'conversation' : 'first-command-only',
          repositoryWorkspaceId: preparationId,
          agentProfile: localInventoryFixture().agentProfiles[0],
          accountBinding: {
            ...binding.account,
            accountLabel: 'Personal ChatGPT',
            model: 'luna-fixture',
          },
          modelSelection: {
            model: 'luna-fixture',
            reasoningEffort: 'low',
            models: localInventoryFixture().accounts[0].models,
          },
        },
      });
    if (url.pathname.startsWith('/api/')) {
      if (method !== 'GET') {
        if (
          ![
            '/api/chat/reconnect',
            '/api/chat/session-event-applied',
            '/api/chat/reconnect-snapshot-applied',
            '/api/chat/probe',
            '/api/telemetry/v1/traces',
          ].includes(url.pathname)
        )
          forbidden.push(url.pathname);
        return route.fulfill({ json: { ok: true } });
      }
      const fixtures: Record<string, unknown> = {
        '/api/auth/check': { authenticated: true },
        '/api/config': { quickActions: [], contextBlocks: {} },
        '/api/accounts': [],
        '/api/agent-library': { drafts: [], versions: localInventoryFixture().agentProfiles },
        '/api/service-health': { services: [], checkedAt: 0 },
        '/api/version': {
          version: 'offline',
          branch: 'fixture',
          hash: 'a'.repeat(40),
          updateAvailable: false,
        },
        '/api/home/preferences': {
          revision: 1,
          names: { briefing: 'Jeeves', terminal: 'Minion' },
          pins: [],
        },
        '/api/home/briefing-chats': [],
        '/api/tasks/loop': { state: 'idle' },
        [`/api/sessions/${sessionId}/symposium/status`]: { sessionId, config: null, seats: [] },
      };
      return route.fulfill({ json: fixtures[url.pathname] ?? [] });
    }
    const asset =
      url.pathname.startsWith('/assets/') || extname(url.pathname)
        ? url.pathname.slice(1)
        : 'index.html';
    const types: Record<string, string> = {
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.woff2': 'font/woff2',
    };
    try {
      return route.fulfill({
        body: await readFile(resolve('frontend/dist', asset)),
        contentType: types[extname(asset)] ?? 'text/html',
      });
    } catch {
      return route.fulfill({ status: 404, body: '' });
    }
  });
  return { requests, forbidden, errors, attachments, controls };
}
async function emitLocalState(page: Page, state: 'running' | 'idle') {
  await page.evaluate(
    ({ sessionId, state }) => {
      const source = (window as unknown as { __localFixtureSource: EventSource })
        .__localFixtureSource;
      source.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'session_state_changed', sessionId, state }),
        }),
      );
    },
    { sessionId, state },
  );
}
for (const appearance of ['light', 'dark'] as const) {
  test(`Local first command: exact choices, preparation and bound controls (${appearance})`, async ({
    page,
  }, testInfo) => {
    const fixture = await offline(page);
    await page.addInitScript((theme) => {
      localStorage.setItem('mitzo-theme', theme);
      localStorage.setItem('mitzo-accent', 'mint');
      localStorage.setItem('mitzo-font', 'georgia');
    }, appearance);
    if (testInfo.project.name.startsWith('mobile'))
      await page.setViewportSize({ width: 320, height: 740 });
    await page.goto('/chat');
    await expect(page.getByRole('combobox', { name: 'Run on' })).toHaveValue('openshell');
    await page.getByRole('combobox', { name: 'Run on' }).focus();
    await expect(page.getByRole('combobox', { name: 'Run on' })).toBeFocused();
    const runOnBounds = await page.getByRole('combobox', { name: 'Run on' }).boundingBox();
    expect(runOnBounds?.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await page.getByRole('combobox', { name: 'Run on' }).selectOption('local');
    await page.getByRole('combobox', { name: 'Account', exact: true }).selectOption('personal');
    await page.getByRole('combobox', { name: 'Thinking', exact: true }).selectOption('low');
    await page
      .getByRole('combobox', { name: 'Agent', exact: true })
      .selectOption(JSON.stringify(['saved', 'agent', 1]));
    await page.getByRole('button', { name: 'Use these Local choices' }).click();
    const repository = page.getByRole('button', { name: 'Add repository' });
    await expect(page.getByRole('button', { name: /^Workspace controls/ })).toBeInViewport();
    await expect(repository).toBeInViewport();
    const panel = page.locator('.workspace-controls > .motion-disclosure');
    const panelBounds = await panel.boundingBox();
    const repositoryBounds = await page.locator('.repository-chat-picker').boundingBox();
    if (testInfo.project.name.startsWith('mobile')) {
      expect(panelBounds!.y + panelBounds!.height).toBeLessThanOrEqual(repositoryBounds!.y);
    } else {
      expect(panelBounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height * 0.45);
    }
    await repository.click();
    await page
      .getByRole('combobox', { name: 'GitHub repository' })
      .selectOption('github:owner/repository');
    await page.getByRole('button', { name: 'Preview repository' }).click();
    await page.getByRole('button', { name: 'Prepare repository' }).click();
    await page.getByRole('textbox', { name: 'Message Mitzo' }).fill('Inspect the repository');
    await page.getByRole('button', { name: 'Use these Local choices' }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Use these Local choices' })).toBeInViewport();
    await expect(page.getByRole('button', { name: /^Workspace controls/ })).toBeInViewport();
    await expect(page.getByRole('textbox', { name: 'Message Mitzo' })).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`local-reviewed-${appearance}.png`),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => fixture.requests.length).toBe(1);
    expect(fixture.requests[0]).toMatchObject({
      runOn: 'local',
      repositoryWorkspaceId: preparationId,
      runtime: {
        account: { accountId: 'personal', profileRevision: 'routing-r1' },
        targetId: 'mac',
      },
      selection: {
        agent: { profileId: 'agent', revision: 1 },
        model: 'luna-fixture',
        thinking: 'low',
      },
      payload: { text: 'Inspect the repository' },
    });
    await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}`));
    await expect(page.getByText('Run on: Local · first command only')).toBeVisible();
    await expect(page.getByText('Repository helper · r1', { exact: true })).toBeVisible();
    await emitLocalState(page, 'running');
    await page.getByRole('textbox', { name: 'Message Mitzo' }).fill('Keep this follow-up draft');
    await page.getByRole('textbox', { name: 'Message Mitzo' }).press('Enter');
    await expect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue(
      'Keep this follow-up draft',
    );
    await expect(page.getByRole('button', { name: 'Stop generation' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Interrupt and send now' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Queue message' })).toHaveCount(0);
    await emitLocalState(page, 'idle');
    await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue(
      'Keep this follow-up draft',
    );
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await page.screenshot({
      path: testInfo.outputPath(`local-bound-${appearance}.png`),
      fullPage: true,
    });
    expect(fixture.forbidden).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}
test('Local first command: restored Local remains visible and blocked with gate off', async ({
  page,
}, testInfo) => {
  const fixture = await offline(page, true, true);
  if (testInfo.project.name.startsWith('mobile'))
    await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/chat?draft=local-restored');
  await expect(page.getByRole('combobox', { name: 'Run on' })).toHaveValue('local');
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveValue(
    JSON.stringify(['saved', 'agent', 1]),
  );
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  const restoredPanel = await page
    .locator('.workspace-controls > .motion-disclosure')
    .boundingBox();
  const restoredRepository = await page.locator('.repository-chat-picker').boundingBox();
  if (testInfo.project.name.startsWith('mobile'))
    expect(restoredPanel!.y + restoredPanel!.height).toBeLessThanOrEqual(restoredRepository!.y);
  await page.getByRole('button', { name: 'Refresh execution choices' }).focus();
  await expect(page.getByRole('button', { name: 'Refresh execution choices' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Refresh execution choices' })).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath('local-restored-disabled.png'),
    fullPage: true,
  });
  expect(fixture.requests).toEqual([]);
  expect(fixture.forbidden).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

async function assertWorkspaceHeadingFits(page: Page) {
  const toggle = page.getByRole('button', { name: /^Workspace controls/ });
  const [heading, status, arrow, access] = await Promise.all([
    toggle.boundingBox(),
    toggle.locator('.conversation-state').boundingBox(),
    toggle.locator(':scope > svg:last-child').boundingBox(),
    page.getByRole('button', { name: 'Access', exact: true }).boundingBox(),
  ]);
  expect(heading).not.toBeNull();
  expect(status).not.toBeNull();
  expect(arrow).not.toBeNull();
  expect(access).not.toBeNull();
  expect(status!.x + status!.width).toBeLessThanOrEqual(heading!.x + heading!.width + 1);
  expect(arrow!.x + arrow!.width).toBeLessThanOrEqual(heading!.x + heading!.width + 1);
  expect(heading!.x + heading!.width).toBeLessThanOrEqual(access!.x);
}

test('Local first command: metadata failure stays blocked and Retry restores the bound controls', async ({
  page,
}, testInfo) => {
  const fixture = await offline(page);
  let recovered = false;
  let releaseInitialMetadata!: () => void;
  const initialMetadata = new Promise<void>((resolve) => (releaseInitialMetadata = resolve));
  await page.route(`**/api/sessions/${sessionId}/meta`, async (route) => {
    if (recovered) return route.fallback();
    await initialMetadata;
    return route.fulfill({ status: 503, json: { error: 'Metadata unavailable' } });
  });
  if (testInfo.project.name.startsWith('mobile'))
    await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`/chat/${sessionId}`);
  const workspace = page.getByRole('button', { name: /^Workspace controls/ });
  await expect(workspace.locator('.conversation-state')).toHaveText(
    'Loading conversation settings',
  );
  await assertWorkspaceHeadingFits(page);
  releaseInitialMetadata();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Conversation settings are unavailable' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Run on' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add agent', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reusable profile drafts' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open review findings' })).toBeEnabled();
  for (const mode of ['Ask', 'Agent', 'Auto']) {
    const control = page.getByRole('button', { name: mode, exact: true });
    if (await control.count()) await expect(control).toBeDisabled();
  }
  await page.getByRole('button', { name: 'Retry conversation settings' }).focus();
  await expect(page.getByRole('button', { name: 'Retry conversation settings' })).toBeFocused();
  await assertWorkspaceHeadingFits(page);
  await page.screenshot({ path: testInfo.outputPath('local-metadata-error.png'), fullPage: true });
  recovered = true;
  await page.getByRole('button', { name: 'Retry conversation settings' }).press('Enter');
  await expect(page.getByText('Run on: Local · first command only')).toBeVisible();
  await expect(workspace.locator('.conversation-state')).toHaveText('First command');
  await assertWorkspaceHeadingFits(page);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath('local-metadata-recovered.png'),
    fullPage: true,
  });
  expect(fixture.requests).toEqual([]);
  expect(fixture.forbidden).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('Local first command: oversized complete command retains its image and enables Send only after removal', async ({
  page,
}, testInfo) => {
  const fixture = await offline(page, false, true);
  await page.addInitScript(() => {
    const key = 'mitzo-chat-draft:local-restored';
    const draft = JSON.parse(localStorage.getItem(key)!);
    draft.images = [
      {
        data: 'AAAA'.repeat(270000),
        mediaType: 'image/png',
        preview:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      },
    ];
    localStorage.setItem(key, JSON.stringify(draft));
  });
  if (testInfo.project.name.startsWith('mobile'))
    await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/chat?draft=local-restored');
  await page.getByRole('button', { name: 'Add repository' }).click();
  await page
    .getByRole('combobox', { name: 'GitHub repository' })
    .selectOption('github:owner/repository');
  await page.getByRole('button', { name: 'Preview repository' }).click();
  await page.getByRole('button', { name: 'Prepare repository' }).click();
  await expect(page.getByText(/Local commands must fit within 1 MiB/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Preview attachment 1' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message Mitzo' }).press('Enter');
  expect(fixture.requests).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath('local-oversized-attachment.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Remove attachment 1' }).click();
  await expect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue(
    'Inspect the repository',
  );
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  expect(fixture.requests).toEqual([]);
  expect(fixture.forbidden).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('Local conversation: future thinking and queued command retain independent snapshots', async ({
  page,
}, testInfo) => {
  const fixture = await offline(page, false, false, true);
  if (testInfo.project.name.startsWith('mobile'))
    await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/chat/${sessionId}`);
  await expect(page.getByText('Run on: Local Mac · fixed for this conversation')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Account' })).toBeDisabled();
  await expect(page.getByText('Runs with Codex')).toBeVisible();
  await page.getByRole('combobox', { name: 'Thinking', exact: true }).selectOption('high');
  await page.getByRole('button', { name: 'Use these conversation choices' }).click();
  await page.getByRole('textbox', { name: 'Message Mitzo' }).fill('First follow-up');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => fixture.requests.length).toBe(1);
  await emitLocalState(page, 'running');
  await page.getByRole('combobox', { name: 'Thinking', exact: true }).selectOption('low');
  await page.getByRole('button', { name: 'Use these conversation choices' }).click();
  await page.getByRole('textbox', { name: 'Message Mitzo' }).fill('Queued follow-up');
  await page.getByRole('button', { name: 'Queue message', exact: true }).click();
  await expect.poll(() => fixture.requests.length).toBe(2);
  expect(fixture.requests).toMatchObject([
    { sessionId, selection: { thinking: 'high' }, payload: { text: 'First follow-up' } },
    { sessionId, selection: { thinking: 'low' }, payload: { text: 'Queued follow-up' } },
  ]);
  await page.screenshot({
    path: testInfo.outputPath('local-conversation-settings.png'),
    fullPage: true,
  });
  expect(fixture.forbidden).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('OpenShell conversation: default route starts and continues without legacy settings writes', async ({
  page,
}, testInfo) => {
  const fixture = await offline(page, false, false, true, 'openshell');
  if (testInfo.project.name.startsWith('mobile'))
    await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/chat');
  await expect(page.getByRole('combobox', { name: 'Run on' })).toHaveValue('openshell');
  await page.getByRole('combobox', { name: 'Account', exact: true }).selectOption('personal');
  await page.getByRole('combobox', { name: 'Thinking', exact: true }).selectOption('low');
  await page
    .getByRole('combobox', { name: 'Agent', exact: true })
    .selectOption(JSON.stringify(['saved', 'agent', 1]));
  await expect(page.getByText('Runs with Codex')).toBeVisible();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Execution choices changed. Refresh and review before sending.' }),
  ).not.toHaveCount(0);
  await page.getByRole('button', { name: 'Use these OpenShell choices' }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Execution choices changed. Refresh and review before sending.' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Add repository' }).click();
  await page
    .getByRole('combobox', { name: 'GitHub repository' })
    .selectOption('github:owner/repository');
  await page.getByRole('button', { name: 'Preview repository' }).click();
  await page.getByRole('button', { name: 'Prepare repository' }).click();
  await page.getByRole('textbox', { name: 'Message Mitzo' }).fill('Inspect OpenShell checkout');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Run on: OpenShell · fixed for this conversation')).toBeVisible();
  await expect.poll(() => fixture.requests.length).toBe(1);
  await page.getByRole('combobox', { name: 'Thinking', exact: true }).selectOption('high');
  await page.getByRole('textbox', { name: 'Message Mitzo' }).fill('Continue in this checkout');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Queue message', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Queue message', exact: true }).click();
  await expect.poll(() => fixture.requests.length).toBe(2);
  expect(fixture.requests).toMatchObject([
    { runOn: 'openshell', capabilityRevision: 'sandbox-caps-r1', selection: { thinking: 'low' } },
    {
      runOn: 'openshell',
      sessionId,
      capabilityRevision: 'sandbox-caps-r1',
      selection: { thinking: 'high' },
    },
  ]);
  await page.getByRole('button', { name: 'New session on Local Mac' }).click();
  await expect.poll(() => fixture.attachments.at(-1)).toBe(null);
  await expect(page.getByRole('combobox', { name: 'Run on' })).toHaveValue('local');
  await expect(page.getByRole('combobox', { name: 'Account', exact: true })).toHaveValue(
    'personal',
  );
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  expect(fixture.controls).toEqual([]);
  expect(fixture.requests).toHaveLength(2);
  await page.screenshot({
    path: testInfo.outputPath('openshell-new-session-elsewhere.png'),
    fullPage: true,
  });
  expect(fixture.forbidden).toEqual([]);
  expect(fixture.errors).toEqual([]);
});
