import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import {
  DEFAULT_MITZO_PROFILE_ID,
  DEFAULT_MITZO_PROFILE_REVISION,
  defaultMitzoProfileDefinition,
  PROFILE_BUILDER_ID,
  PROFILE_BUILDER_REVISION,
  profileBuilderDefinition,
} from '../../packages/protocol/src/index';
import { sha256Hex } from '../../frontend/src/lib/browser-crypto';
import { multiRuntimeInventoryFixture } from '../../frontend/src/test-utils/multi-runtime-inventory-fixture';
import { chooseSetting, openChatSetting, settingsHome } from '../support/chat-settings';

test.use({ baseURL: 'https://mitzo-ui.test' });
for (const appearance of ['dark', 'light'] as const)
  test(`Builtin agents stay selectable with an empty Library on Host Mac (${appearance})`, async ({
    page,
  }, testInfo) => {
    const inventory = multiRuntimeInventoryFixture({ nativeLocalApi: true });
    const builtins = [
      [DEFAULT_MITZO_PROFILE_ID, DEFAULT_MITZO_PROFILE_REVISION, defaultMitzoProfileDefinition],
      [PROFILE_BUILDER_ID, PROFILE_BUILDER_REVISION, profileBuilderDefinition],
    ] as const;
    inventory.agentProfiles = builtins.map(([profileId, revision, definition]) => ({
      kind: 'builtin' as const,
      profileId,
      revision,
      definition,
      contentHash: sha256Hex(JSON.stringify(definition)),
    }));
    const forbidden: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize(
      testInfo.project.name.startsWith('desktop')
        ? { width: 1280, height: 850 }
        : { width: 320, height: 760 },
    );
    await page.emulateMedia({ colorScheme: appearance, reducedMotion: 'reduce' });
    await page.addInitScript((theme) => {
      localStorage.setItem('mitzo:transport', 'sse');
      localStorage.setItem('mitzo-theme', theme);
      localStorage.setItem('mitzo-accent', theme === 'dark' ? 'mint' : 'teal');
      localStorage.setItem('mitzo-font', theme === 'dark' ? 'georgia' : 'system');
      class OfflineEventSource extends EventTarget {
        readyState = 1;
        onmessage: null | ((event: MessageEvent) => void) = null;
        constructor(url: string) {
          super();
          if (url.includes('/api/chat/events'))
            setTimeout(
              () =>
                this.dispatchEvent(
                  new MessageEvent('welcome', {
                    data: JSON.stringify({ connectionId: 'builtin-agent-offline' }),
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
              '/api/chat/unwatch',
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
          '/api/agent-library': { drafts: [], versions: [] },
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
    await page.goto('/chat');
    await openChatSetting(page, 'agent');
    const agent = page.getByRole('combobox', { name: 'Agent', exact: true });
    await expect(agent).toHaveValue(
      JSON.stringify(['builtin', DEFAULT_MITZO_PROFILE_ID, DEFAULT_MITZO_PROFILE_REVISION]),
    );
    await agent.selectOption(
      JSON.stringify(['builtin', PROFILE_BUILDER_ID, PROFILE_BUILDER_REVISION]),
    );
    await expect(page).toHaveURL(/agentProfileKind=builtin/);
    await expect(agent).toHaveValue(
      JSON.stringify(['builtin', PROFILE_BUILDER_ID, PROFILE_BUILDER_REVISION]),
    );
    await expect(agent.getByRole('option', { name: /Unavailable/ })).toHaveCount(0);
    await page.reload();
    await openChatSetting(page, 'execution');
    await page.getByRole('button', { name: 'Local Mac', exact: true }).click();
    await chooseSetting(page, 'Account', 'api');
    await chooseSetting(page, 'Model', 'local-model');
    await chooseSetting(page, 'Thinking level', 'low');
    await openChatSetting(page, 'agent');
    await expect(agent).toHaveValue(
      JSON.stringify(['builtin', PROFILE_BUILDER_ID, PROFILE_BUILDER_REVISION]),
    );
    await expect(agent.getByRole('option', { name: /Unavailable/ })).toHaveCount(0);
    await expect(page.getByText(/selected agent.*unavailable/i)).toHaveCount(0);
    await agent.focus();
    await expect(agent).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath(`local-builtin-agents-${appearance}.png`),
      fullPage: true,
    });
    await settingsHome(page);
    await expect(page.locator('[data-quick-setting="agent"]')).toContainText('Agent Builder');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(forbidden).toEqual([]);
    expect(errors).toEqual([]);
  });
