import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { multiRuntimeInventoryFixture } from '../../frontend/src/test-utils/multi-runtime-inventory-fixture';

test.use({ baseURL: 'https://mitzo-ui.test' });

async function offlinePicker(page: Page, appearance: 'light' | 'dark') {
  const inventory = multiRuntimeInventoryFixture();
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

for (const appearance of ['light', 'dark'] as const) {
  test(`Account and environment retain exact route, invalid choices and draft (${appearance})`, async ({
    page,
  }, testInfo) => {
    const fixture = await offlinePicker(page, appearance);
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
    expect(fixture.forbidden).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}
