import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { localInventoryFixture } from '../../frontend/src/test-utils/local-inventory-fixture';
import { OrdinaryRuntimeFirstCommandSchema } from '../../packages/protocol/src/local-codex-first-command';
import { settingsHome, openChatSetting } from '../support/chat-settings';

test.use({ baseURL: 'https://mitzo-ui.test' });
for (const [theme, accent, font] of [
  ['dark', 'mint', 'georgia'],
  ['light', 'teal', 'system'],
] as const) {
  test(`saved briefing uses reviewed runtime and owned receipt (${theme})`, async ({
    page,
  }, testInfo) => {
    const source = {
      kind: 'briefing' as const,
      date: '2026-10-09',
      revision: 'a'.repeat(64),
      content: 'Exact original offline briefing',
    };
    const inventory = { ...localInventoryFixture(), defaultLocalRepository: true };
    const account = { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' };
    const draft = {
      version: 1,
      id: 'owned-offline-briefing',
      text: 'Discuss this original briefing',
      images: [],
      contextBlocks: [],
      updatedAt: 1,
      settings: {
        selection: account,
        mode: 'agent',
        isolation: true,
        search: '',
        summary: null,
        runtimeSelection: {
          version: 1,
          account,
          accountReference: inventory.accounts[0].account,
          agentProfile: { profileId: 'agent', revision: 1 },
          execution: { location: 'local', targetId: 'mac' },
          capabilityRevision: 'caps-r1',
        },
        launch: {
          prompt: 'Discuss this original briefing',
          context: 'Morning briefing',
          accountSelection: account,
          sourceSnapshots: [source],
          briefing: { date: source.date, revision: source.revision },
        },
      },
    };
    const requests: unknown[] = [];
    const registrations: unknown[] = [];
    const forbidden: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(
      ({ draft, theme, accent, font }) => {
        localStorage.setItem('mitzo:transport', 'sse');
        localStorage.setItem('mitzo-theme', theme);
        localStorage.setItem('mitzo-accent', accent);
        localStorage.setItem('mitzo-font', font);
        if (!sessionStorage.getItem('briefing-seeded')) {
          localStorage.setItem('mitzo-chat-draft:' + draft.id, JSON.stringify(draft));
          sessionStorage.setItem('briefing-seeded', '1');
        }
        class OfflineSource extends EventTarget {
          readyState = 1;
          onmessage: ((event: MessageEvent) => void) | null = null;
          constructor(url: string) {
            super();
            if (url.includes('/api/chat/events'))
              setTimeout(
                () =>
                  this.dispatchEvent(
                    new MessageEvent('welcome', {
                      data: JSON.stringify({ connectionId: 'briefing-offline-sse' }),
                    }),
                  ),
                0,
              );
          }
          close() {
            this.readyState = 2;
          }
        }
        window.EventSource = OfflineSource as unknown as typeof EventSource;
      },
      { draft, theme, accent, font },
    );
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      if (url.hostname !== 'mitzo-ui.test') {
        forbidden.push(url.href);
        return route.abort();
      }
      if (url.pathname.endsWith('/capabilities')) return route.fulfill({ json: inventory });
      if (url.pathname === '/api/chat/local-codex/send') {
        const request = OrdinaryRuntimeFirstCommandSchema.parse(route.request().postDataJSON());
        requests.push(request);
        expect(request.payload).toEqual({ text: draft.text, sourceSnapshots: [source] });
        expect(request.runtime.account).toEqual(inventory.accounts[0].account);
        expect(request.selection.model).toBe(account.model);
        expect(route.request().headers()['x-connection-id']).toBe('briefing-offline-sse');
        return route.fulfill({
          status: 202,
          json: {
            ok: true,
            clientMsgId: request.clientMsgId,
            sessionId: 'briefing-owned-session',
            state: 'consumed',
            dispatched: true,
          },
        });
      }
      if (url.pathname === '/api/home/briefing-chats') {
        if (method === 'POST') {
          const body = route.request().postDataJSON();
          registrations.push(body);
          return route.fulfill({ json: { ...body, createdAt: '2026-10-23T10:00:00Z' } });
        }
        return route.fulfill({
          json: registrations.map((binding) => ({
            ...(binding as object),
            createdAt: '2026-10-23T10:00:00Z',
          })),
        });
      }
      if (
        url.pathname === '/api/chat/send' ||
        (url.pathname === '/api/sessions' && method === 'POST')
      ) {
        forbidden.push(url.pathname);
        return route.fulfill({ status: 409, json: { error: 'Unselected dispatch forbidden' } });
      }
      if (url.pathname === '/api/sessions/briefing-owned-session/meta')
        return route.fulfill({
          json: {
            sessionId: 'briefing-owned-session',
            sessionType: 'chat',
            mode: 'agent',
            isHidden: false,
            runtimeBinding: {
              version: 2,
              account: inventory.accounts[0].account,
              harness: { implementation: 'codex' },
              execution: { location: 'local', targetId: 'mac', targetRevision: 'target-r1' },
            },
            runtimeCommandScope: 'first-command-only',
            repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
            agentProfile: inventory.agentProfiles[0],
            accountBinding: {
              ...inventory.accounts[0].account,
              accountLabel: 'Personal ChatGPT',
              model: account.model,
            },
            modelSelection: {
              model: account.model,
              reasoningEffort: 'low',
              models: inventory.accounts[0].models,
            },
          },
        });
      if (url.pathname.startsWith('/api/')) {
        if (method !== 'GET') {
          if (
            ![
              '/api/chat/switch',
              '/api/chat/reconnect',
              '/api/chat/probe',
              '/api/chat/session-event-applied',
              '/api/chat/reconnect-snapshot-applied',
              '/api/telos/work/links',
              '/api/telemetry/v1/traces',
            ].includes(url.pathname)
          )
            forbidden.push(url.pathname);
          return route.fulfill({ json: { ok: true } });
        }
        const fixtures: Record<string, unknown> = {
          '/api/auth/check': { authenticated: true },
          '/api/config': { quickActions: [], contextBlocks: {} },
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
        return await route.fulfill({
          body: await readFile(resolve('frontend/dist', asset)),
          contentType: types[extname(asset)] ?? 'text/html',
        });
      } catch {
        return route.fulfill({ status: 404, body: 'Offline asset unavailable' });
      }
    });
    await page.goto('/chat?draft=' + draft.id);
    await expect(
      page.getByRole('button', { name: 'Send launch prompt', exact: true }),
    ).toBeEnabled();
    await settingsHome(page);
    const rows = page.locator('[data-quick-setting]:visible');
    await expect(rows).toContainText([
      'Account',
      'Model',
      'Thinking',
      'Agent',
      'Run on',
      'Repository',
    ]);
    await openChatSetting(page, 'execution');
    await expect(page.getByRole('button', { name: 'Local Mac', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.screenshot({
      path: testInfo.outputPath(`briefing-execution-${theme}.png`),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Agent settings', exact: true })).toBeHidden();
    await page.getByRole('button', { name: 'Send launch prompt', exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    await expect.poll(() => registrations.length).toBe(1);
    expect(registrations[0]).toEqual({
      date: source.date,
      revision: source.revision,
      sessionId: 'briefing-owned-session',
      accountId: account.accountId,
      model: account.model,
    });
    await expect
      .poll(() => page.evaluate((id) => localStorage.getItem('mitzo-chat-draft:' + id), draft.id))
      .toBeNull();
    await page.screenshot({
      path: testInfo.outputPath(`briefing-assigned-${theme}.png`),
      animations: 'disabled',
    });
    expect(forbidden).toEqual([]);
    expect(errors).toEqual([]);
  });
}
