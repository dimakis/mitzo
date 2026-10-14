import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { multiRuntimeInventoryFixture } from '../../frontend/src/test-utils/multi-runtime-inventory-fixture';

test.use({ baseURL: 'https://mitzo-ui.test' });

async function offlinePicker(
  page: Page,
  appearance: 'light' | 'dark',
  options: {
    inventory?: ReturnType<typeof multiRuntimeInventoryFixture>;
    getFixtures?: Record<string, unknown>;
  } = {},
) {
  const inventory = options.inventory ?? multiRuntimeInventoryFixture();
  const forbidden: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: appearance });
  await page.addInitScript((theme) => {
    localStorage.setItem('mitzo:transport', 'sse');
    localStorage.setItem('mitzo-workspace-controls-expanded', '1');
    localStorage.setItem('mitzo-theme', theme);
    localStorage.setItem('mitzo-accent', 'mint');
    localStorage.setItem('mitzo-font', 'georgia');
    class OfflineEventSource extends EventTarget {
      readyState = 1;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) {
        super();
        if (url.includes('/api/chat/events'))
          setTimeout(
            () =>
              this.dispatchEvent(
                new MessageEvent('welcome', {
                  data: JSON.stringify({ connectionId: 'runtime-picker-offline' }),
                }),
              ),
            0,
          );
      }
      close() {
        this.readyState = 2;
      }
    }
    window.EventSource = OfflineEventSource as unknown as typeof EventSource;
  }, appearance);
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') {
      forbidden.push(url.href);
      return route.abort();
    }
    if (url.pathname.startsWith('/api/')) {
      if (route.request().method() !== 'GET') {
        if (
          ![
            '/api/chat/probe',
            '/api/chat/session-event-applied',
            '/api/chat/reconnect-snapshot-applied',
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
        '/api/chat/runtime/capabilities': inventory,
        '/api/agent-library': { drafts: [], versions: inventory.agentProfiles },
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
        ...options.getFixtures,
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
  return { forbidden, errors };
}

/** Fixture-only Google enrollment; no production catalogue or provider is consulted. */
function mixedGoogleInventory() {
  const inventory = multiRuntimeInventoryFixture();
  const account = {
    accountId: 'google',
    provider: 'google-vertex' as const,
    profileRevision: 'google-r1',
  };
  const models = [{ id: 'gemini-fixture', label: 'Gemini fixture', reasoningEfforts: ['low'] }];
  inventory.accounts.push({
    account,
    label: 'Google Vertex billing',
    models,
    modelDiscovery: { source: 'configured', stale: false },
  });
  inventory.targets.push({
    targetId: 'gemini',
    targetRevision: 'gemini-r1',
    label: 'Local Gemini',
    location: 'local',
    harness: 'gemini',
  });
  inventory.routes.push({
    account,
    targetId: 'gemini',
    location: 'local',
    harness: 'gemini',
    modes: ['agent'],
    models,
  });
  return inventory;
}

async function narrowMobileEvidence(
  page: Page,
  testInfo: TestInfo,
  stem: string,
  selection: {
    accountId: string;
    model: string;
    thinking: string;
    draft: string;
    environment: string;
  },
) {
  if (!testInfo.project.name.startsWith('mobile')) return;
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
    '20px',
  );
  await page.getByRole('combobox', { name: 'Model', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: /^Workspace controls/ })).toBeInViewport();
  await expect(page.getByRole('textbox', { name: 'Message Mitzo' })).toBeInViewport();
  await expect(page.getByRole('combobox', { name: 'Account', exact: true })).toHaveValue(
    selection.accountId,
  );
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
    selection.model,
  );
  await expect(page.getByRole('combobox', { name: 'Thinking', exact: true })).toHaveValue(
    selection.thinking,
  );
  await expect(page.getByRole('combobox', { name: 'Run on', exact: true })).toHaveValue(
    selection.environment,
  );
  await expect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue(selection.draft);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`${stem}-320.png`), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
}

for (const appearance of ['light', 'dark'] as const) {
  test(`A prepared checkout retains its identity when the first-message model changes (${appearance})`, async ({
    page,
  }, testInfo) => {
    const inventory = multiRuntimeInventoryFixture();
    inventory.accounts[0].models.push({
      id: 'supported-next',
      label: 'Supported next',
      reasoningEfforts: ['low', 'high'],
    });
    const workspaceId = '00000000-0000-4000-8000-000000000100';
    const draftId = `prepared-model-${appearance}`;
    const image = {
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4V0AAAAASUVORK5CYII=',
      preview:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4V0AAAAASUVORK5CYII=',
      mediaType: 'image/png',
    };
    const selection = { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'high' };
    const intent = {
      version: 1,
      account: selection,
      accountReference: inventory.accounts[0].account,
      agentProfile: { profileId: 'agent', revision: 1 },
      execution: { location: 'local', targetId: 'mac' },
      capabilityRevision: inventory.capabilityRevision,
    };
    const fixture = await offlinePicker(page, appearance, {
      inventory,
      getFixtures: {
        '/api/repository-workspaces/catalog': { available: true, repositories: [] },
        [`/api/repository-workspaces/${workspaceId}`]: {
          id: workspaceId,
          repository: 'fixture/repository',
          baseBranch: 'main',
          baseOid: 'a'.repeat(40),
          featureBranch: `mitzo/repo-${workspaceId}`,
          state: 'ready',
          ordinaryRuntime: {
            version: 2,
            account: inventory.accounts[0].account,
            harness: { implementation: 'codex' },
            execution: { location: 'local', targetId: 'mac', targetRevision: 'target-r1' },
          },
        },
      },
    });
    await page.addInitScript(
      ({ draftId, workspaceId, selection, intent, image }) => {
        localStorage.setItem(
          `mitzo-chat-draft:${draftId}`,
          JSON.stringify({
            version: 1,
            id: draftId,
            text: 'Keep this prepared development draft',
            images: [image],
            contextBlocks: [],
            updatedAt: Date.now(),
            settings: {
              selection,
              runtimeSelection: intent,
              retainRuntimeIntent: true,
              repositoryWorkspaceId: workspaceId,
              mode: 'agent',
              isolation: true,
              search: 'agentProfile=agent&profileRevision=1',
              summary: null,
            },
          }),
        );
      },
      { draftId, workspaceId, selection, intent, image },
    );
    if (testInfo.project.name.startsWith('mobile'))
      await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/chat?draft=${draftId}&agentProfile=agent&profileRevision=1`);
    await page.addStyleTag({ content: 'html { font-size: 20px; }' });
    const account = page.getByRole('combobox', { name: 'Account', exact: true });
    const model = page.getByRole('combobox', { name: 'Model', exact: true });
    const thinking = page.getByRole('combobox', { name: 'Thinking', exact: true });
    const environment = page.getByRole('combobox', { name: 'Run on', exact: true });
    const composer = page.getByRole('textbox', { name: 'Message Mitzo' });
    await expect(account).toHaveValue('personal');
    await expect(account).toBeDisabled();
    await expect(environment).toHaveValue('local');
    await expect(environment).toBeDisabled();
    await expect(model).toBeEnabled();
    await model.selectOption('supported-next');
    await expect(model).toHaveValue('supported-next');
    await expect(model).toBeEnabled();
    await expect(thinking).toHaveValue('high');
    await expect(composer).toHaveValue('Keep this prepared development draft');
    await expect(page.getByText('fixture/repository', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await expect
      .poll(() =>
        page.evaluate(
          (draftId) => JSON.parse(localStorage.getItem(`mitzo-chat-draft:${draftId}`)!),
          draftId,
        ),
      )
      .toMatchObject({
        text: 'Keep this prepared development draft',
        images: [image],
        contextBlocks: [],
        settings: {
          repositoryWorkspaceId: workspaceId,
          runtimeSelection: {
            account: { accountId: 'personal', model: 'supported-next', reasoningEffort: 'high' },
            accountReference: inventory.accounts[0].account,
            execution: { location: 'local', targetId: 'mac' },
          },
        },
      });
    await model.scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: /^Workspace controls/ })).toBeInViewport();
    await expect(composer).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`local-multi-runtime-prepared-model-${appearance}.png`),
      fullPage: true,
    });
    await narrowMobileEvidence(page, testInfo, `local-multi-runtime-prepared-model-${appearance}`, {
      accountId: 'personal',
      model: 'supported-next',
      thinking: 'high',
      environment: 'local',
      draft: 'Keep this prepared development draft',
    });
    await expect(account).toBeDisabled();
    await expect(environment).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await expect
      .poll(() =>
        page.evaluate(
          (draftId) => JSON.parse(localStorage.getItem(`mitzo-chat-draft:${draftId}`)!),
          draftId,
        ),
      )
      .toMatchObject({
        text: 'Keep this prepared development draft',
        images: [image],
        settings: {
          repositoryWorkspaceId: workspaceId,
          runtimeSelection: { accountReference: inventory.accounts[0].account },
        },
      });
    expect(fixture.forbidden).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });

  test(`Account and environment retain exact route, invalid choices and draft (${appearance})`, async ({
    page,
  }, testInfo) => {
    const fixture = await offlinePicker(page, appearance, { inventory: mixedGoogleInventory() });
    if (testInfo.project.name.startsWith('mobile'))
      await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/chat?agentProfile=agent&profileRevision=1');
    // Exercise larger text without changing the application's shared token palette.
    await page.addStyleTag({ content: 'html { font-size: 20px; }' });
    const account = page.getByRole('combobox', { name: 'Account', exact: true });
    const model = page.getByRole('combobox', { name: 'Model', exact: true });
    const thinking = page.getByRole('combobox', { name: 'Thinking', exact: true });
    const environment = page.getByRole('combobox', { name: 'Run on', exact: true });
    const composer = page.getByRole('textbox', { name: 'Message Mitzo' });
    await expect(environment).toHaveValue('openshell');
    await expect(environment.locator('option')).toHaveText(['OpenShell', 'Local Mac']);
    await account.selectOption('api');
    await model.selectOption('shell-model');
    await thinking.selectOption('high');
    await composer.fill('Keep this development draft across environments');
    await expect(page.getByText('Runs with Codex', { exact: true })).toBeVisible();
    await expect(model.locator('option[value="local-model"]')).toHaveCount(0);

    await environment.selectOption('local');
    await expect(page.getByText('Runs with Mitzo Responses', { exact: true })).toBeVisible();
    await expect(account).toHaveValue('api');
    await expect(model).toHaveValue('shell-model');
    await expect(thinking).toHaveValue('high');
    await expect(model.locator('option[value="shell-model"]')).toHaveAttribute('disabled', '');
    await expect(model.locator('option[value="shell-model"]')).toHaveText(
      'Unavailable model: shell-model',
    );
    await expect(model.locator('option[value="local-model"]')).toHaveCount(1);
    await expect(composer).toHaveValue('Keep this development draft across environments');
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await environment.focus();
    await expect(environment).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath(`local-multi-runtime-responses-${appearance}.png`),
      fullPage: true,
    });
    await narrowMobileEvidence(page, testInfo, `local-multi-runtime-responses-${appearance}`, {
      accountId: 'api',
      model: 'shell-model',
      thinking: 'high',
      environment: 'local',
      draft: 'Keep this development draft across environments',
    });
    await expect(model.locator('option[value="shell-model"]')).toHaveAttribute('disabled', '');
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();

    // Replacement is explicit; it must not discard an unsupported thinking choice.
    await model.selectOption('local-model');
    await expect(thinking).toHaveValue('high');
    await expect(thinking.locator('option[value="high"]')).toHaveAttribute('disabled', '');
    await expect(thinking.locator('option[value="high"]')).toHaveText('Unavailable thinking: high');
    await thinking.selectOption('low');
    await account.selectOption('vertex');
    await expect(page.getByText('Runs with Claude', { exact: true })).toBeVisible();
    await expect(model).toHaveValue('local-model');
    await expect(model.locator('option[value="claude-model"]')).toHaveCount(1);
    await model.selectOption('claude-model');
    await expect(thinking).toHaveValue('low');
    await thinking.selectOption('high');
    await environment.selectOption('openshell');
    await expect(account).toHaveValue('vertex');
    await expect(environment).toHaveValue('openshell');
    await expect(model).toHaveValue('claude-model');
    await expect(thinking).toHaveValue('high');
    await expect(page.getByText(/^Runs with /)).toHaveCount(0);
    await expect(model.locator('option[value="shell-model"]')).toHaveCount(0);
    await expect(composer).toHaveValue('Keep this development draft across environments');
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const drafts = Object.keys(localStorage)
            .filter((key) => key.startsWith('mitzo-chat-draft:'))
            .map((key) => JSON.parse(localStorage.getItem(key)!));
          return drafts.find(
            (draft) => draft.text === 'Keep this development draft across environments',
          )?.settings.runtimeSelection;
        }),
      )
      .toMatchObject({
        accountReference: {
          accountId: 'vertex',
          provider: 'anthropic-vertex',
          profileRevision: 'vertex-r1',
        },
        account: { accountId: 'vertex', model: 'claude-model', reasoningEffort: 'high' },
        execution: { location: 'openshell', targetId: null },
      });
    await page.getByRole('button', { name: 'Refresh execution choices' }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: /^Workspace controls/ })).toBeInViewport();
    await expect(composer).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`local-multi-runtime-unavailable-${appearance}.png`),
      fullPage: true,
    });
    await narrowMobileEvidence(page, testInfo, `local-multi-runtime-unavailable-${appearance}`, {
      accountId: 'vertex',
      model: 'claude-model',
      thinking: 'high',
      environment: 'openshell',
      draft: 'Keep this development draft across environments',
    });
    // Keep the existing Vertex identity proof above before choosing another account.
    await account.selectOption('google');
    await expect(account).toHaveValue('google');
    await expect(model).toHaveValue('claude-model');
    await expect(thinking).toHaveValue('high');
    await expect(page.getByText(/^Runs with /)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await environment.selectOption('local');
    await expect(environment.locator('option')).toHaveText(['OpenShell', 'Local Mac']);
    await expect(page.getByText('Runs with Gemini', { exact: true })).toBeVisible();
    await expect(account).toHaveValue('google');
    await expect(model).toHaveValue('claude-model');
    await expect(model.locator('option[value="claude-model"]')).toHaveAttribute('disabled', '');
    await expect(model.locator('option[value="claude-model"]')).toHaveText(
      'Unavailable model: claude-model',
    );
    await expect(model.locator('option[value="gemini-fixture"]')).toHaveCount(1);
    await expect(model.locator('option[value="shell-model"]')).toHaveCount(0);
    await expect(composer).toHaveValue('Keep this development draft across environments');
    await model.selectOption('gemini-fixture');
    await expect(thinking).toHaveValue('high');
    await expect(thinking.locator('option[value="high"]')).toHaveAttribute('disabled', '');
    await thinking.selectOption('low');
    await expect
      .poll(() =>
        page.evaluate(() => {
          const drafts = Object.keys(localStorage)
            .filter((key) => key.startsWith('mitzo-chat-draft:'))
            .map((key) => JSON.parse(localStorage.getItem(key)!));
          return drafts.find(
            (draft) => draft.text === 'Keep this development draft across environments',
          )?.settings.runtimeSelection;
        }),
      )
      .toMatchObject({
        accountReference: {
          accountId: 'google',
          provider: 'google-vertex',
          profileRevision: 'google-r1',
        },
        account: { accountId: 'google', model: 'gemini-fixture', reasoningEffort: 'low' },
        execution: { location: 'local', targetId: 'gemini' },
      });
    await model.scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: /^Workspace controls/ })).toBeInViewport();
    await expect(composer).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`local-multi-runtime-gemini-${appearance}.png`),
      fullPage: true,
    });
    await narrowMobileEvidence(page, testInfo, `local-multi-runtime-gemini-${appearance}`, {
      accountId: 'google',
      model: 'gemini-fixture',
      thinking: 'low',
      environment: 'local',
      draft: 'Keep this development draft across environments',
    });
    await environment.selectOption('openshell');
    await expect(account).toHaveValue('google');
    await expect(model).toHaveValue('gemini-fixture');
    await expect(thinking).toHaveValue('low');
    await expect(page.getByText(/^Runs with /)).toHaveCount(0);
    await expect(model.locator('option[value="shell-model"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const drafts = Object.keys(localStorage)
            .filter((key) => key.startsWith('mitzo-chat-draft:'))
            .map((key) => JSON.parse(localStorage.getItem(key)!));
          return drafts.find(
            (draft) => draft.text === 'Keep this development draft across environments',
          )?.settings.runtimeSelection;
        }),
      )
      .toMatchObject({
        accountReference: {
          accountId: 'google',
          provider: 'google-vertex',
          profileRevision: 'google-r1',
        },
        account: { accountId: 'google', model: 'gemini-fixture', reasoningEffort: 'low' },
        execution: { location: 'openshell', targetId: null },
      });
    await page.getByRole('button', { name: 'Refresh execution choices' }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: /^Workspace controls/ })).toBeInViewport();
    await expect(composer).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`local-multi-runtime-gemini-unavailable-${appearance}.png`),
      fullPage: true,
    });
    await narrowMobileEvidence(
      page,
      testInfo,
      `local-multi-runtime-gemini-unavailable-${appearance}`,
      {
        accountId: 'google',
        model: 'gemini-fixture',
        thinking: 'low',
        environment: 'openshell',
        draft: 'Keep this development draft across environments',
      },
    );
    expect(fixture.forbidden).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}
