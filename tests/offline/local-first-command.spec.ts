import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { localInventoryFixture } from '../../frontend/src/test-utils/local-inventory-fixture';
import { LocalCodexFirstCommandSchema } from '../../packages/protocol/src/local-codex-first-command';
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
async function offline(page: Page, gateOff = false, restore = false) {
  const requests: unknown[] = [];
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
    const binding = {
      version: 2,
      account: localInventoryFixture().accounts[0].account,
      harness: { implementation: 'codex' },
      execution: { location: 'local', targetId: 'mac', targetRevision: 'target-r1' },
    };
    if (url.pathname === '/api/chat/local-codex/capabilities')
      return route.fulfill(
        gateOff
          ? { status: 503, json: { ok: false, code: 'entry_disabled', error: 'Unavailable' } }
          : { json: localInventoryFixture() },
      );
    if (url.pathname === '/api/chat/local-codex/send') {
      const request = LocalCodexFirstCommandSchema.parse(route.request().postDataJSON());
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
    if (url.pathname === '/api/chat/send') {
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
          runtimeCommandScope: 'first-command-only',
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
            '/api/chat/switch-session',
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
  return { requests, forbidden, errors };
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
    await page.getByRole('combobox', { name: 'Run on' }).selectOption('local:mac');
    await page.getByRole('combobox', { name: 'Account', exact: true }).selectOption('personal');
    await page.getByRole('combobox', { name: 'Thinking', exact: true }).selectOption('low');
    await page
      .getByRole('combobox', { name: 'Agent', exact: true })
      .selectOption(JSON.stringify(['saved', 'agent', 1]));
    await page.getByRole('button', { name: 'Use these Local choices' }).click();
    await page.getByRole('button', { name: 'Add repository' }).click();
    await page
      .getByRole('combobox', { name: 'GitHub repository' })
      .selectOption('github:owner/repository');
    await page.getByRole('button', { name: 'Preview repository' }).click();
    await page.getByRole('button', { name: 'Prepare repository' }).click();
    await page.getByRole('textbox', { name: 'Message Mitzo' }).fill('Inspect the repository');
    await page.getByRole('button', { name: 'Use these Local choices' }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Use these Local choices' })).toBeInViewport();
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
  await page.goto('/chat?draft=local-restored');
  await expect(page.getByRole('combobox', { name: 'Run on' })).toHaveValue('local:mac');
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveValue(
    JSON.stringify(['saved', 'agent', 1]),
  );
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath('local-restored-disabled.png'),
    fullPage: true,
  });
  expect(fixture.requests).toEqual([]);
  expect(fixture.forbidden).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('Local first command: metadata failure stays blocked and Retry restores the bound controls', async ({
  page,
}, testInfo) => {
  const fixture = await offline(page);
  let recovered = false;
  await page.route(`**/api/sessions/${sessionId}/meta`, (route) =>
    recovered
      ? route.fallback()
      : route.fulfill({ status: 503, json: { error: 'Metadata unavailable' } }),
  );
  if (testInfo.project.name.startsWith('mobile'))
    await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`/chat/${sessionId}`);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Conversation settings are unavailable' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Run on' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry conversation settings' }).focus();
  await expect(page.getByRole('button', { name: 'Retry conversation settings' })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('local-metadata-error.png'), fullPage: true });
  recovered = true;
  await page.getByRole('button', { name: 'Retry conversation settings' }).press('Enter');
  await expect(page.getByText('Run on: Local · first command only')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath('local-metadata-recovered.png'),
    fullPage: true,
  });
  expect(fixture.requests).toEqual([]);
  expect(fixture.forbidden).toEqual([]);
  expect(fixture.errors).toEqual([]);
});
