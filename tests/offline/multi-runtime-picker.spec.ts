import {
  settingRow,
  chooseSetting,
  openChatSetting,
  settingsHome,
  settingChoices,
} from '../support/chat-settings';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { sha256Hex } from '../../frontend/src/lib/browser-crypto';
import { SymposiumProfileDefinitionSchema } from '../../packages/protocol/src/symposium';
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

async function openAgentSettings(page: Page) {
  const trigger = page.getByRole('button', { name: /^Workspace controls,/ });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  await expect(page.getByRole('region', { name: 'Agent settings', exact: true })).toBeVisible();
  await openChatSetting(page, 'execution');
}

for (const appearance of ['dark', 'light'] as const) {
  test(`Quick settings lazy route: hidden summaries leave layout and keyboard navigation (${appearance})`, async ({
    page,
  }, testInfo) => {
    const fixture = await offlinePicker(page, appearance);
    // CI serves the production Vite app, including route-pages.ts's lazy chat import.
    await page.goto('/chat?agentProfile=agent&profileRevision=1');
    const input = page.getByRole('textbox', { name: 'Message Mitzo' });
    await input.fill('Retain my draft while navigating the lazy-loaded settings');
    await chooseSetting(page, 'Account', 'api');
    await chooseSetting(page, 'Model', 'shell-model');
    const panel = await settingsHome(page);
    await expect(settingRow(page, 'Account')).toBeVisible();
    // Also exercise component CSS arriving after shared workspace CSS when the
    // local offline bundle combines styles instead of loading a route CSS chunk.
    const lateStyles = await page.addStyleTag({
      content: await readFile(resolve('frontend/src/components/QuickChatSettings.css'), 'utf8'),
    });
    await lateStyles.evaluate((style) => document.body.append(style));
    for (const field of [
      'account',
      'model',
      'thinking',
      'agent',
      'execution',
      'repository',
      'more',
      'defaults',
    ]) {
      await openChatSetting(page, field);
      const back = panel.getByRole('button', { name: 'Back to chat settings' });
      await expect(back).toBeFocused();
      await expect(panel.locator('.quick-settings-editor:not([inert])')).toHaveCount(1);
      await expect(panel.locator('.quick-settings-row[hidden]:visible')).toHaveCount(0);
      expect(
        await panel.locator('.quick-settings-row[hidden]').evaluateAll((rows) => {
          const focus = document.activeElement;
          return rows.every((row) => {
            (row as HTMLElement).focus();
            return row.getClientRects().length === 0 && document.activeElement === focus;
          });
        }),
      ).toBe(true);
      if (field === 'account')
        await page.screenshot({
          path: testInfo.outputPath(`quick-sheet-lazy-account-${appearance}.png`),
        });
      await page.keyboard.press('Escape');
      await expect(panel.locator(`[data-quick-setting="${field}"]`)).toBeFocused();
    }
    await expect(input).toHaveValue('Retain my draft while navigating the lazy-loaded settings');
    await page.screenshot({ path: testInfo.outputPath(`quick-sheet-lazy-home-${appearance}.png`) });
    expect(fixture.forbidden).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

test('Runtime defaults: save, fresh New chat without repeated confirmation, clear and retained draft', async ({
  page,
}) => {
  const fixture = await offlinePicker(page, 'dark');
  const resets: unknown[] = [];
  await page.route('**/api/chat/switch', (route) => {
    expect(route.request().method()).toBe('POST');
    const reset = route.request().postDataJSON();
    expect(reset).toEqual({ type: 'switch_session', sessionId: null });
    resets.push(reset);
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/chat?agentProfile=agent&profileRevision=1');
  const input = page.getByRole('textbox', { name: 'Message Mitzo' });
  await input.fill('Keep this original draft and its reviewed settings');
  await chooseSetting(page, 'Account', 'api');
  await chooseSetting(page, 'Model', 'shell-model');
  await chooseSetting(page, 'Thinking', 'high');
  const original = page.url();
  await openChatSetting(page, 'defaults');
  await page.getByRole('button', { name: 'Make default for new chats', exact: true }).click();
  await settingsHome(page);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page
    .getByRole('button', { name: /^New chat$/i })
    .first()
    .click();
  await expect(input).toHaveValue('');
  await settingsHome(page);
  await expect(settingRow(page, 'Account')).toHaveAttribute('data-value', 'api');
  await expect(settingRow(page, 'Account')).not.toContainText('Confirm account');
  await expect(settingRow(page, 'Model')).toHaveAttribute('data-value', 'shell-model');
  await expect(settingRow(page, 'Thinking')).toHaveAttribute('data-value', 'high');
  await input.fill('New draft retains the same account without confirmation');
  await expect(page.getByRole('button', { name: 'Start session', exact: true })).toBeDisabled();
  await expect(page.getByText(/selected account identity is unconfirmed/)).toHaveCount(0);
  await expect(settingRow(page, 'Account')).toHaveAttribute('data-value', 'api');
  await expect(settingRow(page, 'Account')).not.toContainText('Confirm account');
  await expect(settingRow(page, 'Model')).toHaveAttribute('data-value', 'shell-model');
  await expect(settingRow(page, 'Thinking')).toHaveAttribute('data-value', 'high');
  await openChatSetting(page, 'defaults');
  await page.getByRole('button', { name: 'Clear new-chat default', exact: true }).click();
  await settingsHome(page);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page
    .getByRole('button', { name: /^New chat$/i })
    .first()
    .click();
  await settingsHome(page);
  await expect(settingRow(page, 'Account')).toHaveAttribute('data-value', '');
  await page.goto(original);
  await settingsHome(page);
  await expect(input).toHaveValue('Keep this original draft and its reviewed settings');
  await expect(settingRow(page, 'Account')).toHaveAttribute('data-value', 'api');
  await expect(settingRow(page, 'Model')).toHaveAttribute('data-value', 'shell-model');
  await expect(settingRow(page, 'Thinking')).toHaveAttribute('data-value', 'high');
  expect(resets).toHaveLength(2);
  expect(fixture.forbidden).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

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
  await settingsHome(page);
  await settingRow(page, 'Model').scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: /^Workspace controls/ })).toBeInViewport();
  await expect(page.getByRole('textbox', { name: 'Message Mitzo' })).toBeInViewport();
  await expect(settingRow(page, 'Account')).toHaveAttribute('data-value', selection.accountId);
  await expect(settingRow(page, 'Model')).toHaveAttribute('data-value', selection.model);
  await expect(settingRow(page, 'Thinking level')).toHaveAttribute(
    'data-value',
    selection.thinking,
  );
  await openChatSetting(page, 'execution');
  await expect(
    page.getByRole('group', { name: 'Run on', exact: true }).getByRole('button', {
      name: selection.environment === 'local' ? 'Local Mac' : 'OpenShell',
      exact: true,
    }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue(selection.draft);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`${stem}-320.png`), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
}

test('Approved composer clean saved-design reference aligns Agent and Account fields', async ({
  page,
}, testInfo) => {
  const fixture = await offlinePicker(page, 'light');
  const mobile = testInfo.project.name.startsWith('mobile');
  const width = mobile ? 390 : 1280;
  const height = mobile ? 844 : 900;
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => {
    localStorage.setItem('mitzo-accent', 'lavender');
    localStorage.setItem('mitzo-font', 'system');
    localStorage.setItem('mitzo-workspace-controls-expanded', '0');
  });
  await page.goto('/chat?agentProfile=agent&profileRevision=1');
  const workspace = page.getByRole('button', { name: /^Workspace controls/ });
  if ((await workspace.getAttribute('aria-expanded')) === 'true') await workspace.click();
  const input = page.getByRole('textbox', { name: 'Message Mitzo' });
  const draft =
    'Refine the approvals flow in Mitzo. Keep the mobile layout consistent with Connections.';
  await input.fill(draft);
  await openAgentSettings(page);
  const panel = page.getByRole('region', { name: 'Agent settings', exact: true });
  await chooseSetting(page, 'Account', 'api');
  await chooseSetting(page, 'Model', 'shell-model');
  await chooseSetting(page, 'Thinking level', 'high');
  await panel.getByRole('button', { name: 'Done', exact: true }).click();
  await settingsHome(page);
  await expect(panel.getByRole('combobox')).toHaveCount(0);
  const account = settingRow(panel, 'Account');
  const agent = panel.locator('[data-quick-setting="agent"]');
  await expect(account).toHaveAttribute('data-value', 'api');
  await expect(settingRow(panel, 'Model')).toHaveAttribute('data-value', 'shell-model');
  await expect(settingRow(panel, 'Thinking')).toHaveAttribute('data-value', 'high');
  await expect(agent).toContainText('Repository helper');
  const accountBox = (await account.boundingBox())!;
  const agentBox = (await agent.boundingBox())!;
  expect(Math.abs(accountBox.x - agentBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(accountBox.width - agentBox.width)).toBeLessThanOrEqual(1);
  for (const row of await panel.locator('[data-quick-setting]:visible').all())
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(workspace).toHaveAttribute('aria-expanded', 'true');
  await expect(input).toBeInViewport();
  const bounds = (await panel.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`quick-sheet-approved-${width}.png`) });
  await openChatSetting(page, 'execution');
  const runOn = panel.getByRole('group', { name: 'Run on', exact: true });
  await expect(runOn.getByRole('button')).toHaveCount(2);
  await expect(runOn.getByRole('button', { name: 'OpenShell', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const local = runOn.getByRole('button', { name: 'Local Mac', exact: true });
  await local.scrollIntoViewIfNeeded();
  await expect(local).toBeInViewport();
  await expect(panel.getByText('Runs with Codex', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Done', exact: true })).toBeInViewport();
  await expect(input).toHaveValue(draft);
  await expect(input).toBeInViewport();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).first()).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath(`local-approved-agent-settings-clean-${width}-cards.png`),
    fullPage: true,
  });
  expect(fixture.forbidden).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('Approved composer retains a long trusted agent name without horizontal overflow', async ({
  page,
}, testInfo) => {
  const inventory = multiRuntimeInventoryFixture();
  const profile = inventory.agentProfiles[0];
  // The portable name schema requires nonempty trimmed text, with no upper cap.
  // Keep this representative unbroken name valid and rehash its trusted definition.
  const name = 'ArchitecturalReviewAssistant'.repeat(4);
  profile.definition.name = name;
  expect(SymposiumProfileDefinitionSchema.safeParse(profile.definition).success).toBe(true);
  profile.contentHash = sha256Hex(JSON.stringify(profile.definition));
  const fixture = await offlinePicker(page, 'light', { inventory });
  await page.addInitScript(() => {
    localStorage.setItem('mitzo-accent', 'lavender');
    localStorage.setItem('mitzo-font', 'system');
  });
  await page.goto('/chat?agentProfile=agent&profileRevision=1');
  const composer = page.getByRole('textbox', { name: 'Message Mitzo' });
  const draft = 'Keep this draft while the full agent name wraps';
  await composer.fill(draft);
  const trigger = page.getByRole('button', { name: /^Workspace controls,/ });
  await expect(page.locator('.workspace-controls-context > span')).toContainText(name);
  await expect(trigger).toHaveAccessibleName(
    new RegExp(`^Workspace controls, Settings, ${name}(?:,|$)`),
  );
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 740 });
    const geometry = await trigger.evaluate((element) => {
      const summary = element
        .closest('.workspace-controls')!
        .querySelector('.workspace-controls-context')!
        .getBoundingClientRect();
      const owner = element.closest('.workspace-controls')!.getBoundingClientRect();
      const label = element
        .closest('.workspace-controls')!
        .querySelector('.workspace-controls-context > span')!
        .getBoundingClientRect();
      return {
        left: summary.left - owner.left,
        right: owner.right - summary.right,
        labelLeft: label.left - summary.left,
        labelRight: summary.right - label.right,
        overflow: element.scrollWidth > element.clientWidth,
      };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeGreaterThanOrEqual(0);
    expect(geometry.labelLeft).toBeGreaterThanOrEqual(0);
    expect(geometry.labelRight).toBeGreaterThanOrEqual(0);
    expect(geometry.overflow).toBe(false);
    // The desktop route switches to the mobile screen after matchMedia updates.
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await expect(composer).toBeInViewport();
    await expect(composer).toHaveValue(draft);
    await expect(page.getByRole('button', { name: /^Workspace controls/ })).toBeInViewport();
    await expect(
      page.getByRole('link', { name: /^(Back to chats|Chats)$/ }).first(),
    ).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath(`local-approved-agent-settings-long-name-${width}.png`),
      fullPage: true,
    });
  }
  expect(fixture.forbidden).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

for (const appearance of ['light', 'dark'] as const) {
  test(`Approved composer Agent settings structure, dismissal and bounded scrolling (${appearance})`, async ({
    page,
  }, testInfo) => {
    const inventory = multiRuntimeInventoryFixture();
    const draftId = `approved-picker-${appearance}`;
    const image = {
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4V0AAAAASUVORK5CYII=',
      preview:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4V0AAAAASUVORK5CYII=',
      mediaType: 'image/png',
    };
    const account = { accountId: 'api', model: 'shell-model', reasoningEffort: 'high' };
    const intent = {
      version: 1,
      account,
      accountReference: inventory.accounts[1].account,
      agentProfile: { profileId: 'agent', revision: 1 },
      execution: { location: 'openshell', targetId: 'shell' },
      capabilityRevision: inventory.capabilityRevision,
    };
    const fixture = await offlinePicker(page, appearance, { inventory });
    await page.addInitScript(
      ({ draftId, account, intent, image }) => {
        localStorage.setItem(
          `mitzo-chat-draft:${draftId}`,
          JSON.stringify({
            version: 1,
            id: draftId,
            text: 'Retain the approved composer draft',
            images: [image],
            contextBlocks: [],
            updatedAt: Date.now(),
            settings: {
              selection: account,
              runtimeSelection: intent,
              retainRuntimeIntent: true,
              repositoryWorkspaceId: null,
              mode: 'agent',
              isolation: true,
              search: 'agentProfile=agent&profileRevision=1',
              summary: null,
            },
          }),
        );
      },
      { draftId, account, intent, image },
    );
    const mobile = testInfo.project.name.startsWith('mobile');
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/chat?draft=${draftId}&agentProfile=agent&profileRevision=1`);
    await page.addStyleTag({ content: 'html { font-size: 20px; }' });
    const trigger = page.getByRole('button', { name: /^Workspace controls,/ });
    const panel = page.getByRole('region', { name: 'Agent settings', exact: true });
    const composer = page.getByRole('textbox', { name: 'Message Mitzo' });
    await expect(page.getByRole('button', { name: 'Replay Mitzo waterfall' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start session', exact: true })).toBeVisible();
    await expect(trigger).toHaveCount(1);
    // One top summary owns settings; the writing surface has no duplicate picker.
    await expect(page.locator('.workspace-controls-context > span')).toContainText(
      'Repository helper',
    );
    await expect(trigger).toHaveAccessibleName(
      /Workspace controls, Settings, Repository helper, API billing, Shell model, high/,
    );
    await expect(page.locator('.chat-input .agent-settings-picker')).toHaveCount(0);
    await openAgentSettings(page);
    await expect(panel).toHaveCount(1);
    expect(await panel.evaluate((element) => !!element.closest('.workspace-controls'))).toBe(true);
    await settingsHome(page);
    await expect(panel.getByRole('combobox')).toHaveCount(0);
    const rows = panel.locator('[data-quick-setting]:visible');
    const keys = await rows.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-quick-setting')),
    );
    expect(keys.slice(0, 5)).toEqual(['account', 'model', 'thinking', 'agent', 'execution']);
    expect(keys.slice(-2)).toEqual(['more', 'defaults']);
    for (const width of mobile ? [390, 320] : [1280]) {
      await page.setViewportSize({ width, height: mobile ? (width === 320 ? 740 : 844) : 900 });
      await settingsHome(page);
      const modelBox = (await settingRow(panel, 'Model').boundingBox())!;
      const thinkingBox = (await settingRow(panel, 'Thinking').boundingBox())!;
      expect(thinkingBox.y).toBeGreaterThan(modelBox.y);
      expect(Math.abs(thinkingBox.x - modelBox.x)).toBeLessThan(1);
      for (const row of await rows.all())
        expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await expect(panel.getByRole('button', { name: 'Done', exact: true })).toBeInViewport();
      await expect(composer).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: testInfo.outputPath(`quick-sheet-${appearance}-${width}.png`),
      });
      await openChatSetting(page, 'execution');
      const runOn = panel.getByRole('group', { name: 'Run on', exact: true });
      const openshell = runOn.getByRole('button', { name: 'OpenShell', exact: true });
      const local = runOn.getByRole('button', { name: 'Local Mac', exact: true });
      await expect(runOn.getByRole('button')).toHaveCount(2);
      await expect(openshell).toHaveAttribute('aria-pressed', 'true');
      await expect(local).toHaveAttribute('aria-pressed', 'false');
      await expect(openshell).toHaveAccessibleDescription('Run tools in an isolated sandbox.');
      await expect(local).toHaveAccessibleDescription('Run tools on this Mac.');
      await expect(openshell.locator('.openshell-brand')).toHaveCount(1);
      await expect(panel.getByText('Runs with Codex', { exact: true })).toBeVisible();
      await expect(
        panel.getByRole('button', { name: 'Refresh execution choices', exact: true }),
      ).toHaveCount(0);
      await expect(panel.getByRole('button', { name: /^Use these / })).toHaveCount(0);
    }
    await settingsHome(page);
    const thinking = settingRow(panel, 'Thinking level');
    await chooseSetting(page, 'Thinking level', 'low');
    await thinking.focus();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(composer).toHaveValue('Retain the approved composer draft');
    await expect(page.getByRole('button', { name: 'Preview attachment 1' })).toBeVisible();
    await openAgentSettings(page);
    await expect(thinking).toHaveAttribute('data-value', 'low');
    await trigger.click();
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    await openAgentSettings(page);
    await panel.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    await openAgentSettings(page);
    await expect(thinking).toHaveAttribute('data-value', 'low');
    await trigger.click();
    await expect(trigger).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(
          (draftId) => JSON.parse(localStorage.getItem(`mitzo-chat-draft:${draftId}`)!),
          draftId,
        ),
      )
      .toMatchObject({
        text: 'Retain the approved composer draft',
        images: [image],
        settings: {
          runtimeSelection: {
            accountReference: inventory.accounts[1].account,
            account: { accountId: 'api', model: 'shell-model', reasoningEffort: 'low' },
            execution: { location: 'openshell', targetId: 'shell' },
          },
        },
      });
    expect(fixture.forbidden).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });

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
    await openAgentSettings(page);
    const account = settingRow(page, 'Account');
    const model = settingRow(page, 'Model');
    const thinking = settingRow(page, 'Thinking level');
    const environments = page.getByRole('group', { name: 'Run on', exact: true });
    const local = environments.getByRole('button', { name: 'Local Mac', exact: true });
    const openshell = environments.getByRole('button', { name: 'OpenShell', exact: true });
    const composer = page.getByRole('textbox', { name: 'Message Mitzo' });
    await expect(account).toHaveAttribute('data-value', 'personal');
    await expect(account).toHaveAttribute('data-readonly', 'true');
    await expect(local).toHaveAttribute('aria-pressed', 'true');
    await expect(local).toBeDisabled();
    await expect(openshell).toBeDisabled();
    await expect(model).not.toHaveAttribute('data-readonly', 'true');
    await chooseSetting(page, 'Model', 'supported-next');
    await expect(model).toHaveAttribute('data-value', 'supported-next');
    await expect(model).not.toHaveAttribute('data-readonly', 'true');
    await expect(thinking).toHaveAttribute('data-value', 'high');
    await expect(composer).toHaveValue('Keep this prepared development draft');
    await openChatSetting(page, 'repository');
    await expect(
      page
        .getByRole('region', { name: 'Repository for new chat' })
        .getByText('fixture/repository', { exact: true }),
    ).toBeVisible();
    await openChatSetting(page, 'execution');
    await expect(
      page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }),
    ).toBeEnabled();
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
    await settingsHome(page);
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
    if (testInfo.project.name.startsWith('mobile')) {
      await page.setViewportSize({ width: 320, height: 740 });
      await openAgentSettings(page);
      await openChatSetting(page, 'repository');
      const repository = page.getByRole('region', { name: 'Repository for new chat' });
      await repository.scrollIntoViewIfNeeded();
      await expect(repository).toBeInViewport();
      await expect
        .poll(() =>
          page
            .locator('.workspace-controls-content')
            .evaluate((element) => element.scrollHeight > element.clientHeight),
        )
        .toBe(true);
      await page
        .getByRole('button', { name: 'Refresh preparation status', exact: true })
        .scrollIntoViewIfNeeded();
      await expect(
        page.getByRole('button', { name: 'Refresh preparation status', exact: true }),
      ).toBeInViewport();
      await expect(page.getByRole('button', { name: /^Workspace controls/ })).toBeInViewport();
      await expect(composer).toBeInViewport();
      await expect(
        page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }),
      ).toBeInViewport();
      await openAgentSettings(page);
      await expect(model).toHaveAttribute('data-value', 'supported-next');
      await expect(thinking).toHaveAttribute('data-value', 'high');
      await expect(composer).toHaveValue('Keep this prepared development draft');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: testInfo.outputPath(`local-multi-runtime-prepared-scroll-${appearance}-320.png`),
        fullPage: true,
      });
    }
    await openChatSetting(page, 'execution');
    await expect(account).toHaveAttribute('data-readonly', 'true');
    await expect(local).toBeDisabled();
    await expect(openshell).toBeDisabled();
    await expect(
      page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }),
    ).toBeEnabled();
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
    const confirmationDraftId = `account-confirm-${appearance}`;
    await page.addInitScript((id) => {
      const account = { accountId: 'api', model: 'shell-model', reasoningEffort: 'high' };
      localStorage.setItem(
        `mitzo-chat-draft:${id}`,
        JSON.stringify({
          version: 1,
          id,
          text: 'Keep this development draft across environments',
          images: [],
          contextBlocks: [],
          updatedAt: Date.now(),
          settings: {
            selection: account,
            retainRuntimeIntent: true,
            repositoryWorkspaceId: null,
            mode: 'agent',
            isolation: true,
            search: 'agentProfile=agent&profileRevision=1',
            summary: null,
            runtimeSelection: {
              version: 1,
              account,
              accountReference: null,
              agentProfile: { profileId: 'agent', revision: 1 },
              execution: { location: 'openshell', targetId: null },
              capabilityRevision: null,
            },
          },
        }),
      );
    }, confirmationDraftId);
    if (testInfo.project.name.startsWith('mobile'))
      await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/chat?draft=${confirmationDraftId}&agentProfile=agent&profileRevision=1`);
    // Exercise larger text without changing the application's shared token palette.
    await page.addStyleTag({ content: 'html { font-size: 20px; }' });
    await openAgentSettings(page);
    const account = settingRow(page, 'Account');
    const model = settingRow(page, 'Model');
    const thinking = settingRow(page, 'Thinking level');
    const environments = page.getByRole('group', { name: 'Run on', exact: true });
    const local = environments.getByRole('button', { name: 'Local Mac', exact: true });
    const openshell = environments.getByRole('button', { name: 'OpenShell', exact: true });
    const composer = page.getByRole('textbox', { name: 'Message Mitzo' });
    await expect(openshell).toHaveAttribute('aria-pressed', 'true');
    await expect(environments.getByRole('button')).toHaveText([
      /OpenShell.*Run tools in an isolated sandbox\./s,
      /Local Mac.*Run tools on this Mac\./s,
    ]);
    await expect(account).toHaveAttribute('aria-label', 'Account, Confirm account: API billing');
    await expect(
      settingChoices(page, 'Account').locator('[data-setting-value="__mitzo_confirm_account__"]'),
    ).toBeDisabled();
    await expect(account).not.toHaveAttribute('data-value', 'api');
    await expect(model).toHaveAttribute('data-value', 'shell-model');
    await expect(thinking).toHaveAttribute('data-value', 'high');
    await expect(composer).toHaveValue('Keep this development draft across environments');
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            JSON.parse(localStorage.getItem(`mitzo-chat-draft:${id}`)!).settings.runtimeSelection,
          confirmationDraftId,
        ),
      )
      .toMatchObject({
        accountReference: null,
        account: { accountId: 'api', model: 'shell-model', reasoningEffort: 'high' },
      });
    await chooseSetting(page, 'Account', 'api');
    await expect(account).toHaveAttribute('data-value', 'api');
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            JSON.parse(localStorage.getItem(`mitzo-chat-draft:${id}`)!).settings.runtimeSelection,
          confirmationDraftId,
        ),
      )
      .toMatchObject({
        accountReference: { accountId: 'api', provider: 'openai', profileRevision: 'api-r1' },
        account: { accountId: 'api', model: 'shell-model', reasoningEffort: 'high' },
      });
    await chooseSetting(page, 'Model', 'shell-model');
    await chooseSetting(page, 'Thinking level', 'high');
    await composer.fill('Keep this development draft across environments');
    await expect(page.getByText('Runs with Codex', { exact: true })).toBeVisible();
    await expect(
      settingChoices(page, 'Model').locator('[data-setting-value="local-model"]'),
    ).toHaveCount(0);

    await local.click();
    await expect(page.getByText('Runs with Mitzo Responses', { exact: true })).toBeVisible();
    await expect(account).toHaveAttribute('data-value', 'api');
    await expect(model).toHaveAttribute('data-value', 'shell-model');
    await expect(thinking).toHaveAttribute('data-value', 'high');
    await expect(
      settingChoices(page, 'Model').locator('[data-setting-value="shell-model"]'),
    ).toHaveAttribute('disabled', '');
    await expect(
      settingChoices(page, 'Model').locator('[data-setting-value="shell-model"]'),
    ).toHaveText('Unavailable model: shell-model');
    await expect(
      settingChoices(page, 'Model').locator('[data-setting-value="local-model"]'),
    ).toHaveCount(1);
    await expect(composer).toHaveValue('Keep this development draft across environments');
    await expect(
      page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }),
    ).toBeDisabled();
    await local.focus();
    await expect(local).toBeFocused();
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
    await expect(
      settingChoices(page, 'Model').locator('[data-setting-value="shell-model"]'),
    ).toHaveAttribute('disabled', '');
    await expect(
      page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }),
    ).toBeDisabled();

    // Replacement is explicit; it must not discard an unsupported thinking choice.
    await chooseSetting(page, 'Model', 'local-model');
    await expect(thinking).toHaveAttribute('data-value', 'high');
    await expect(
      settingChoices(page, 'Thinking level').locator('[data-setting-value="high"]'),
    ).toHaveAttribute('disabled', '');
    await expect(
      settingChoices(page, 'Thinking level').locator('[data-setting-value="high"]'),
    ).toHaveText('Unavailable thinking level: high');
    await chooseSetting(page, 'Thinking level', 'low');
    await chooseSetting(page, 'Account', 'vertex');
    await expect(page.getByText('Runs with Claude', { exact: true })).toBeVisible();
    await expect(model).toHaveAttribute('data-value', 'local-model');
    await expect(
      settingChoices(page, 'Model').locator('[data-setting-value="claude-model"]'),
    ).toHaveCount(1);
    await chooseSetting(page, 'Model', 'claude-model');
    await expect(thinking).toHaveAttribute('data-value', 'low');
    await chooseSetting(page, 'Thinking level', 'high');
    await openChatSetting(page, 'execution');
    await openshell.click();
    await expect(account).toHaveAttribute('data-value', 'vertex');
    await expect(openshell).toHaveAttribute('aria-pressed', 'true');
    await expect(model).toHaveAttribute('data-value', 'claude-model');
    await expect(thinking).toHaveAttribute('data-value', 'high');
    await expect(page.getByText(/^Runs with /)).toHaveCount(0);
    await expect(
      settingChoices(page, 'Model').locator('[data-setting-value="shell-model"]'),
    ).toHaveCount(0);
    await expect(composer).toHaveValue('Keep this development draft across environments');
    await expect(
      page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }),
    ).toBeDisabled();
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
    await page.getByRole('button', { name: 'Done', exact: true }).scrollIntoViewIfNeeded();
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
    await chooseSetting(page, 'Account', 'google');
    await expect(account).toHaveAttribute('data-value', 'google');
    await expect(model).toHaveAttribute('data-value', 'claude-model');
    await expect(thinking).toHaveAttribute('data-value', 'high');
    await expect(page.getByText(/^Runs with /)).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }),
    ).toBeDisabled();
    await local.click();
    await expect(environments.getByRole('button')).toHaveText([
      /OpenShell.*Run tools in an isolated sandbox\./s,
      /Local Mac.*Run tools on this Mac\./s,
    ]);
    await expect(page.getByText('Runs with Gemini', { exact: true })).toBeVisible();
    await expect(account).toHaveAttribute('data-value', 'google');
    await expect(model).toHaveAttribute('data-value', 'claude-model');
    await expect(
      settingChoices(page, 'Model').locator('[data-setting-value="claude-model"]'),
    ).toHaveAttribute('disabled', '');
    await expect(
      settingChoices(page, 'Model').locator('[data-setting-value="claude-model"]'),
    ).toHaveText('Unavailable model: claude-model');
    await expect(
      settingChoices(page, 'Model').locator('[data-setting-value="gemini-fixture"]'),
    ).toHaveCount(1);
    await expect(
      settingChoices(page, 'Model').locator('[data-setting-value="shell-model"]'),
    ).toHaveCount(0);
    await expect(composer).toHaveValue('Keep this development draft across environments');
    await chooseSetting(page, 'Model', 'gemini-fixture');
    await expect(thinking).toHaveAttribute('data-value', 'high');
    await expect(
      settingChoices(page, 'Thinking level').locator('[data-setting-value="high"]'),
    ).toHaveAttribute('disabled', '');
    await chooseSetting(page, 'Thinking level', 'low');
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
    await settingsHome(page);
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
    await openChatSetting(page, 'execution');
    await openshell.click();
    await expect(account).toHaveAttribute('data-value', 'google');
    await expect(model).toHaveAttribute('data-value', 'gemini-fixture');
    await expect(thinking).toHaveAttribute('data-value', 'low');
    await expect(page.getByText(/^Runs with /)).toHaveCount(0);
    await expect(
      settingChoices(page, 'Model').locator('[data-setting-value="shell-model"]'),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }),
    ).toBeDisabled();
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
    await page.getByRole('button', { name: 'Done', exact: true }).scrollIntoViewIfNeeded();
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
