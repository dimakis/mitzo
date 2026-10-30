import {
  settingRow,
  chooseSetting,
  openChatSetting,
  settingsHome,
  chooseAgent,
  settingChoices,
} from '../support/chat-settings';
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
  await page.emulateMedia({ reducedMotion: 'reduce' });
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
    if (url.pathname === '/api/telos/work/links') {
      expect(route.request().method()).toBe('POST');
      const body = route.request().postDataJSON();
      expect([sessionId]).toContain(body.conversationId);
      expect(body).toEqual({ namespace: 'mitzo', conversationId: body.conversationId });
      return route.fulfill({ json: [] });
    }
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
            '/api/chat/unwatch',
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

async function openAgentSettings(page: Page) {
  const trigger = page.getByRole('button', { name: /^Workspace controls,/ });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  await expect(page.getByRole('region', { name: 'Agent settings', exact: true })).toBeVisible();
  await openChatSetting(page, 'execution');
}
async function assertBoundRunOn(page: Page, location: 'local' | 'openshell', firstCommand = false) {
  await openChatSetting(page, 'execution');
  const panel = page.getByRole('region', { name: 'Agent settings', exact: true });
  const cards = panel.getByRole('group', { name: 'Run on', exact: true });
  await expect(cards.getByRole('button')).toHaveCount(2);
  for (const [value, name] of [
    ['local', 'Local Mac'],
    ['openshell', 'OpenShell'],
  ] as const) {
    const card = cards.getByRole('button', { name, exact: true });
    await expect(card).toHaveAttribute('aria-pressed', String(value === location));
    await expect(card).toBeDisabled();
  }
  await expect(panel.getByText('Fixed for this conversation', { exact: true })).toBeVisible();
  if (firstCommand) {
    await expect(panel.getByRole('status')).toHaveText(
      `This ${location === 'local' ? 'Local' : 'OpenShell'} conversation supports its first command only. Start a new chat for another command.`,
    );
    await expect(
      page.getByRole('button', { name: /^Workspace controls/ }),
    ).toHaveAccessibleDescription('First command');
  }
}
async function assertSettingsGeometry(page: Page) {
  const panel = page.getByRole('region', { name: 'Agent settings', exact: true });
  const bounds = await panel.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await expect(page.getByRole('textbox', { name: 'Message Mitzo' })).toBeInViewport();
  await expect(page.getByRole('button', { name: /^Workspace controls/ })).toBeInViewport();
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
    await openAgentSettings(page);
    await expect(page.getByRole('button', { name: 'OpenShell', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'OpenShell', exact: true }).focus();
    await expect(page.getByRole('button', { name: 'OpenShell', exact: true })).toBeFocused();
    const runOnBounds = await page
      .getByRole('button', { name: 'OpenShell', exact: true })
      .boundingBox();
    expect(runOnBounds?.height).toBeGreaterThanOrEqual(44);
    await expect(
      page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: 'Local Mac', exact: true }).click();
    await chooseSetting(page, 'Account', 'personal');
    await chooseSetting(page, 'Thinking level', 'low');
    await chooseAgent(page, JSON.stringify(['saved', 'agent', 1]));
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await openAgentSettings(page);
    await settingsHome(page);
    const repository = page.locator('[data-quick-setting=repository]');
    await expect(page.getByRole('button', { name: /^Workspace controls/ })).toBeInViewport();
    await repository.scrollIntoViewIfNeeded();
    await expect(repository).toBeInViewport();
    await repository.click();
    await page
      .getByRole('combobox', { name: 'GitHub repository' })
      .selectOption('github:owner/repository');
    await page.getByRole('button', { name: 'Preview repository' }).click();
    await page.getByRole('button', { name: 'Prepare repository' }).click();
    await page.getByRole('textbox', { name: 'Message Mitzo' }).fill('Inspect the repository');
    await openAgentSettings(page);
    await page.getByRole('button', { name: 'Done', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: /^Workspace controls/ })).toBeInViewport();
    await expect(page.getByRole('textbox', { name: 'Message Mitzo' })).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`local-reviewed-${appearance}.png`),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }).click();
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
    await openAgentSettings(page);
    await assertBoundRunOn(page, 'local', true);
    await openChatSetting(page, 'agent');
    await expect(
      page
        .getByRole('region', { name: 'Agent settings', exact: true })
        .getByText('Repository helper · r1', { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: 'Agent settings', exact: true })
        .locator('select[aria-label="Agent"]'),
    ).toHaveCount(0);
    await page.getByRole('button', { name: /^Workspace controls,/ }).click();
    await emitLocalState(page, 'running');
    await page.getByRole('textbox', { name: 'Message Mitzo' }).fill('Keep this follow-up draft');
    await page.getByRole('textbox', { name: 'Message Mitzo' }).press('Enter');
    await expect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue(
      'Keep this follow-up draft',
    );
    await expect(page.getByRole('button', { name: 'Stop generation' })).toBeEnabled();
    await expect(
      page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Interrupt and send now' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Queue message' })).toHaveCount(0);
    await emitLocalState(page, 'idle');
    await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue(
      'Keep this follow-up draft',
    );
    await expect(
      page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }),
    ).toBeDisabled();
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
  await openAgentSettings(page);
  await expect(page.getByRole('button', { name: 'Local Mac', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('select[aria-label="Agent"]')).toHaveValue(
    JSON.stringify(['saved', 'agent', 1]),
  );
  await expect(
    page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }),
  ).toBeDisabled();
  await assertSettingsGeometry(page);
  await page.getByRole('button', { name: /^Workspace controls,/ }).focus();
  await expect(page.getByRole('button', { name: /^Workspace controls,/ })).toBeFocused();
  await expect(page.getByRole('button', { name: /^Workspace controls,/ })).toBeInViewport();
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
  const [context, settings, icon, access] = await Promise.all([
    page.locator('.workspace-controls-context').boundingBox(),
    toggle.boundingBox(),
    toggle.locator('[data-icon="settings"]').boundingBox(),
    page.getByRole('button', { name: 'Access', exact: true }).boundingBox(),
  ]);
  expect(context).not.toBeNull();
  expect(settings).not.toBeNull();
  expect(icon).not.toBeNull();
  expect(access).not.toBeNull();
  expect(context!.x + context!.width).toBeLessThanOrEqual(settings!.x + 1);
  expect(icon!.x + icon!.width).toBeLessThanOrEqual(settings!.x + settings!.width + 1);
  expect(settings!.x + settings!.width).toBeLessThanOrEqual(access!.x);
  expect(access!.x + access!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
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
  await expect(workspace).toHaveAccessibleDescription('Loading conversation settings');
  await assertWorkspaceHeadingFits(page);
  releaseInitialMetadata();
  await expect(workspace).toHaveAccessibleDescription('Needs review');
  await openAgentSettings(page);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Conversation settings are unavailable' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Run on' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add agent', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reusable profile drafts' })).toHaveCount(0);
  await openChatSetting(page, 'more');
  await expect(page.getByRole('button', { name: 'Open review findings' })).toHaveCount(0);
  for (const mode of ['Ask', 'Agent', 'Auto']) {
    const control = page.getByRole('button', { name: mode, exact: true });
    if (await control.count()) await expect(control).toBeDisabled();
  }
  await openChatSetting(page, 'execution');
  await page.getByRole('button', { name: 'Retry conversation settings' }).focus();
  await expect(page.getByRole('button', { name: 'Retry conversation settings' })).toBeFocused();
  await assertWorkspaceHeadingFits(page);
  await page.screenshot({ path: testInfo.outputPath('local-metadata-error.png'), fullPage: true });
  recovered = true;
  await page.getByRole('button', { name: 'Retry conversation settings' }).press('Enter');
  await openAgentSettings(page);
  await assertBoundRunOn(page, 'local', true);
  await expect(workspace).toHaveAccessibleDescription('First command');
  await assertWorkspaceHeadingFits(page);
  await expect(
    page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath('local-metadata-recovered.png'),
    fullPage: true,
  });
  expect(fixture.requests).toEqual([]);
  expect(fixture.forbidden).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('Local first command: screenshot above the former 1 MiB command cap remains sendable', async ({
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
  await openAgentSettings(page);
  // This size fixture deliberately starts with a legacy unconfirmed account.
  // Explicitly confirm its existing enrolled candidate before freezing preparation.
  const account = settingRow(page, 'Account');
  await expect(account).toHaveAttribute('aria-label', 'Account, Confirm account: Personal ChatGPT');
  await expect(
    settingChoices(page, 'Account').locator('[data-setting-value="__mitzo_confirm_account__"]'),
  ).toBeDisabled();
  await chooseSetting(page, 'Account', 'personal');
  await expect(account).toHaveAttribute('data-value', 'personal');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await openAgentSettings(page);
  await openChatSetting(page, 'repository');
  await page
    .getByRole('combobox', { name: 'GitHub repository' })
    .selectOption('github:owner/repository');
  await page.getByRole('button', { name: 'Preview repository' }).click();
  await page.getByRole('button', { name: 'Prepare repository' }).click();
  await expect(page.getByText(/commands must fit within/)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Preview attachment 1' })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('local-large-attachment.png'),
    fullPage: true,
  });
  await page.getByRole('textbox', { name: 'Message Mitzo' }).press('Enter');
  await expect.poll(() => fixture.requests.length).toBe(1);
  expect(fixture.requests[0]).toMatchObject({
    payload: { images: [{ data: 'AAAA'.repeat(270000), mediaType: 'image/png' }] },
  });
  expect(fixture.forbidden).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('Bound Agent settings keeps Close and Done reachable with a long draft in short viewports', async ({
  page,
}, testInfo) => {
  const fixture = await offline(page, false, false, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/chat/${sessionId}`);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '20px';
  });
  const workspace = page.getByRole('button', { name: /^Workspace controls/ });
  if ((await workspace.getAttribute('aria-expanded')) === 'true') await workspace.click();
  const input = page.getByRole('textbox', { name: 'Message Mitzo' });
  const draft = Array.from(
    { length: 12 },
    (_, index) =>
      `Retain planning line ${index + 1} while reviewing the original bound session settings.`,
  ).join('\n');
  await input.fill(draft);
  const trigger = page.getByRole('button', { name: /^Workspace controls,/ });
  const panel = page.getByRole('region', { name: 'Agent settings', exact: true });
  for (const [width, height] of [
    [390, 844],
    [320, 480],
  ]) {
    await page.setViewportSize({ width, height });
    await openAgentSettings(page);
    await assertBoundRunOn(page, 'local');
    await expect(settingRow(panel, 'Account')).toHaveAttribute('data-readonly', 'true');
    await expect(settingRow(panel, 'Account')).toHaveAttribute('data-value', 'personal');
    await settingsHome(page);
    for (const control of [settingRow(panel, 'Account'), settingRow(panel, 'Model')]) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport();
      const contained = await control.evaluate((element) => {
        const body = element.closest<HTMLElement>('[role="region"]')!;
        const style = getComputedStyle(body);
        const viewport = body.getBoundingClientRect();
        const field = element.getBoundingClientRect();
        const top = viewport.top + body.clientTop + parseFloat(style.paddingTop);
        const bottom =
          viewport.top + body.clientTop + body.clientHeight - parseFloat(style.paddingBottom);
        const left = viewport.left + body.clientLeft + parseFloat(style.paddingLeft);
        const right =
          viewport.left + body.clientLeft + body.clientWidth - parseFloat(style.paddingRight);
        return {
          usableHeight: bottom - top,
          height: field.height,
          top: field.top - top,
          bottom: bottom - field.bottom,
          left: field.left - left,
          right: right - field.right,
        };
      });
      expect(contained.usableHeight + 1).toBeGreaterThanOrEqual(contained.height);
      for (const inset of [contained.top, contained.bottom, contained.left, contained.right])
        expect(inset).toBeGreaterThanOrEqual(-1);
    }
    const close = panel.getByRole('button', { name: 'Close agent settings', exact: true });
    await close.scrollIntoViewIfNeeded();
    await expect(close).toBeInViewport();
    await expect(workspace).toBeInViewport();
    await expect(
      page.getByRole('navigation', { name: 'Main navigation' }).first(),
    ).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(input).toHaveValue(draft);
    await close.click();
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    await input.scrollIntoViewIfNeeded();
    await expect(input).toBeInViewport();
    await input.focus();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(draft);
    await openAgentSettings(page);
    const done = panel.getByRole('button', { name: 'Done', exact: true });
    await done.scrollIntoViewIfNeeded();
    await expect(done).toBeInViewport();
    await expect(workspace).toBeInViewport();
    await expect(
      page.getByRole('navigation', { name: 'Main navigation' }).first(),
    ).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath(`local-approved-agent-settings-bound-${width}.png`),
      fullPage: true,
    });
    await done.click();
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    await input.scrollIntoViewIfNeeded();
    await input.focus();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(draft);
  }
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
  await openAgentSettings(page);
  await assertBoundRunOn(page, 'local');
  await expect(settingRow(page, 'Account')).toHaveAttribute('data-readonly', 'true');
  await expect(page.getByText('Runs with Codex')).toBeVisible();
  await chooseSetting(page, 'Thinking level', 'high');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message Mitzo' }).fill('First follow-up');
  await page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }).click();
  await expect.poll(() => fixture.requests.length).toBe(1);
  await emitLocalState(page, 'running');
  await openAgentSettings(page);
  await chooseSetting(page, 'Thinking level', 'low');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message Mitzo' }).fill('Queued follow-up');
  await page.getByRole('button', { name: 'Queue message', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Up next' })).toBeVisible();
  expect(fixture.requests).toHaveLength(1);
  await emitLocalState(page, 'idle');
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
  await openAgentSettings(page);
  await expect(page.getByRole('button', { name: 'OpenShell', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await chooseSetting(page, 'Account', 'personal');
  await chooseSetting(page, 'Thinking level', 'low');
  await chooseAgent(page, JSON.stringify(['saved', 'agent', 1]));
  await expect(page.getByText('Runs with Codex')).toBeVisible();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Execution choices changed. Refresh and review before sending.' }),
  ).not.toHaveCount(0);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await openAgentSettings(page);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Execution choices changed. Refresh and review before sending.' }),
  ).toHaveCount(0);
  await openChatSetting(page, 'repository');
  await page
    .getByRole('combobox', { name: 'GitHub repository' })
    .selectOption('github:owner/repository');
  await page.getByRole('button', { name: 'Preview repository' }).click();
  await page.getByRole('button', { name: 'Prepare repository' }).click();
  await page.getByRole('textbox', { name: 'Message Mitzo' }).fill('Inspect OpenShell checkout');
  await page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }).click();
  // The draft composer is replaced when session metadata binds the conversation.
  // Open settings on that bound composer, rather than the outgoing draft.
  await expect(
    page.getByRole('button', { name: /^Workspace controls/ }),
  ).toHaveAccessibleDescription('Conversation');
  await openAgentSettings(page);
  await assertBoundRunOn(page, 'openshell');
  await expect.poll(() => fixture.requests.length).toBe(1);
  await chooseSetting(page, 'Thinking level', 'high');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message Mitzo' }).fill('Continue in this checkout');
  await expect(
    page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Queue message', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Queue message', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Up next' })).toBeVisible();
  expect(fixture.requests).toHaveLength(1);
  await emitLocalState(page, 'idle');
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
  await openAgentSettings(page);
  await page.getByRole('button', { name: 'New session on Local Mac' }).click();
  await expect(page).toHaveURL(/\/chat\?draft=/);
  await expect.poll(() => fixture.attachments.at(-1)).toBe(null);
  const newWorkspace = page.getByRole('button', { name: /^Workspace controls/ });
  await expect(newWorkspace).toHaveAccessibleDescription('First command');
  await expect(newWorkspace).toHaveAttribute('aria-expanded', 'false');
  await openAgentSettings(page);
  await expect(page.getByRole('button', { name: 'Local Mac', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(settingRow(page, 'Account')).toHaveAttribute('data-value', 'personal');
  await expect(
    page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }),
  ).toBeDisabled();
  expect(fixture.controls).toEqual([]);
  expect(fixture.requests).toHaveLength(2);
  await page.screenshot({
    path: testInfo.outputPath('openshell-new-session-elsewhere.png'),
    fullPage: true,
  });
  expect(fixture.forbidden).toEqual([]);
  expect(fixture.errors).toEqual([]);
});
