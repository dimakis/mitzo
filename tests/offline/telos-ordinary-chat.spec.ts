import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { localInventoryFixture } from '../../frontend/src/test-utils/local-inventory-fixture';
import { OrdinaryWorkspaceFirstCommandSchema } from '../../packages/protocol/src/ordinary-workspace-public';
import { sha256Hex } from '../../frontend/src/lib/browser-crypto';
import { settingsHome, settingRow, openChatSetting } from '../support/chat-settings';
test.use({ baseURL: 'https://mitzo-ui.test' });
const compiled = build({
  entryPoints: [resolve('tests/fixtures/telos-ordinary-chat.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/telos-ordinary-chat.js',
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
for (const theme of ['dark', 'light'] as const)
  test(`ordinary bound first command survives reload and explicit recovery before continuation (${theme})`, async ({
    page,
  }, info) => {
    const files = (await compiled).outputFiles,
      inventory = localInventoryFixture();
    const requests: {
        path: string;
        body: ReturnType<typeof OrdinaryWorkspaceFirstCommandSchema.parse>;
      }[] = [],
      forbidden: string[] = [],
      errors: string[] = [];
    inventory.agentProfiles[0].definition.name = 'People-work helper';
    inventory.agentProfiles[0].contentHash = sha256Hex(
      JSON.stringify(inventory.agentProfiles[0].definition),
    );
    let accepted = false;
    let releaseRecovery!: () => void;
    const recoveryReceipt = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 900,
    });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
    await page.addInitScript(() => {
      localStorage.setItem('mitzo:transport', 'sse');
      class OfflineEvents extends EventTarget {
        readyState = 1;
        onmessage: ((event: MessageEvent) => void) | null = null;
        constructor(url: string) {
          super();
          if (url.includes('/api/chat/events')) {
            (window as unknown as Record<string, unknown>).ordinaryEvents = this;
            setTimeout(
              () =>
                this.dispatchEvent(
                  new MessageEvent('welcome', {
                    data: JSON.stringify({ connectionId: 'ordinary-offline-sse' }),
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
      window.EventSource = OfflineEvents as unknown as typeof EventSource;
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url()),
        path = url.pathname,
        method = route.request().method();
      if (url.origin !== 'https://mitzo-ui.test') {
        forbidden.push(url.href);
        return route.abort();
      }
      const file = files.find(
        (file) => path === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (/^\/[a-z0-9-]+\.(png|svg)$/.test(path))
        return route.fulfill({
          body: await readFile(resolve('frontend/public', path.slice(1))),
          contentType: path.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        });
      if (path === '/api/telos/work/links') {
        expect(route.request().method()).toBe('POST');
        const body = route.request().postDataJSON();
        expect(['ordinary-bound', 'other-chat']).toContain(body.conversationId);
        expect(body).toEqual({ namespace: 'mitzo', conversationId: body.conversationId });
        return route.fulfill({ json: [] });
      }
      if (path === '/api/chat/runtime/capabilities') return route.fulfill({ json: inventory });
      if (path.startsWith('/api/ordinary/workspaces/commands/')) {
        const body = OrdinaryWorkspaceFirstCommandSchema.parse(route.request().postDataJSON());
        expect(route.request().headers()['x-connection-id']).toBe('ordinary-offline-sse');
        expect(body.sessionId).toBe('ordinary-bound');
        expect(body.workspace.workspaceId).toBe('11111111-1111-4111-8111-111111111111');
        requests.push({ path, body });
        if (requests.length === 1)
          return route.fulfill({ status: 503, json: { error: 'Acknowledgement unavailable' } });
        if (requests.length === 2) await recoveryReceipt;
        accepted = true;
        return route.fulfill({
          status: 202,
          json: {
            ok: true,
            sessionId: body.sessionId,
            clientMsgId: body.clientMsgId,
            dispatched: true,
            state: 'consumed',
          },
        });
      }
      if (path === '/api/sessions/ordinary-bound/meta')
        return route.fulfill({
          json: {
            sessionId: 'ordinary-bound',
            sessionType: 'chat',
            isHidden: false,
            mode: 'agent',
            ordinaryWorkspaceId: '11111111-1111-4111-8111-111111111111',
            runtimeCommandScope: accepted ? 'conversation' : 'prepared-first-command',
            runtimeBinding: {
              version: 2,
              account: inventory.accounts[0].account,
              harness: { implementation: 'codex' },
              execution: { location: 'local', targetId: 'mac', targetRevision: 'target-r1' },
            },
            agentProfile: inventory.agentProfiles[0],
            accountBinding: {
              ...inventory.accounts[0].account,
              accountLabel: 'Personal ChatGPT',
              model: 'luna-fixture',
            },
            modelSelection: {
              model: 'luna-fixture',
              reasoningEffort: 'low',
              models: inventory.accounts[0].models,
            },
          },
        });
      if (path === '/api/sessions/other-chat/meta')
        return route.fulfill({
          json: { sessionId: 'other-chat', sessionType: 'chat', isHidden: false, mode: 'agent' },
        });
      if (path.endsWith('/messages'))
        return route.fulfill({ json: { messages: [], current: null, currents: [] } });
      if (path.endsWith('/symposium/status'))
        return route.fulfill({
          json: { sessionId: path.split('/')[3], config: null, seats: [], deliveries: [] },
        });
      if (path === '/api/chat/suspend') {
        expect(route.request().postDataJSON()).toMatchObject({ type: 'session_suspend' });
        return route.fulfill({ json: { ok: true } });
      }
      if (path.startsWith('/api/')) {
        if (
          method !== 'GET' &&
          ![
            '/api/chat/switch',
            '/api/chat/reconnect',
            '/api/chat/session-event-applied',
            '/api/chat/reconnect-snapshot-applied',
            '/api/chat/probe',
            '/api/telemetry/v1/traces',
          ].includes(path)
        )
          forbidden.push(path);
        const data: Record<string, unknown> = {
          '/api/auth/check': { authenticated: true },
          '/api/config': { quickActions: [], contextBlocks: {} },
          '/api/accounts': [],
          '/api/agent-library': { drafts: [], versions: inventory.agentProfiles },
          '/api/service-health': { services: [], checkedAt: 0 },
          '/api/home/preferences': {
            revision: 1,
            names: { briefing: 'Jeeves', terminal: 'Minion' },
            pins: [],
          },
          '/api/sessions': { sessions: [], hasMore: false },
          '/api/tasks/loop': { state: 'idle' },
        };
        return route.fulfill({ json: method === 'GET' ? (data[path] ?? []) : { ok: true } });
      }
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'light' ? 'teal' : 'mint'}" data-font="${theme === 'light' ? 'georgia' : 'system'}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:100%;margin:0}html{font-size:${theme === 'light' ? '160%' : '100%'}}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
      });
    });
    await page.goto('/chat/ordinary-bound');
    expect(await page.evaluate(() => window.innerWidth)).toBe(
      info.project.name.startsWith('mobile') ? 320 : 1280,
    );
    const composer = page.getByRole('textbox', { name: 'Message Mitzo' }),
      send = page.getByRole('button', { name: 'Send message', exact: true });
    await expect(composer).toHaveValue('Write the recording plan.');
    await expect(send).toBeEnabled();
    expect(requests).toHaveLength(0);
    const agents = page.locator('.conversation-agents-entry .conversation-participants-trigger');
    await expect(agents).toHaveAccessibleName('Agents, People-work helper');
    const geometry = await agents.evaluate((button) => {
      const label = button.querySelector(':scope > span')!;
      const chevron = button.querySelector(':scope > svg:last-of-type')!;
      const text = document.createRange();
      text.selectNodeContents(label);
      let paintRight = text.getBoundingClientRect().right;
      // Range geometry includes clipped text. Intersect its horizontal paint
      // with actual clipping ancestors rather than assuming ellipsis is present.
      for (let node: Element | null = label; node && node !== button; node = node.parentElement) {
        if (['hidden', 'clip', 'scroll', 'auto'].includes(getComputedStyle(node).overflowX))
          paintRight = Math.min(paintRight, node.getBoundingClientRect().right);
      }
      return {
        labelRight: label.getBoundingClientRect().right,
        paintRight,
        chevronLeft: chevron.getBoundingClientRect().left,
        chevronWidth: chevron.getBoundingClientRect().width,
        height: button.getBoundingClientRect().height,
      };
    });
    expect(geometry.labelRight).toBeLessThanOrEqual(geometry.chevronLeft);
    expect(geometry.paintRight).toBeLessThanOrEqual(geometry.chevronLeft);
    expect(geometry.chevronWidth).toBeGreaterThanOrEqual(16);
    expect(geometry.height).toBeGreaterThanOrEqual(44);
    await agents.focus();
    await expect(agents).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Close Agents', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close Agents', exact: true }).click();
    await expect(agents).toBeFocused();
    await settingsHome(page);
    await expect(settingRow(page, 'Account')).toHaveAttribute('data-value', 'personal');
    await expect(settingRow(page, 'Model')).toHaveAttribute('data-value', 'luna-fixture');
    await expect(settingRow(page, 'Thinking level')).toHaveAttribute('data-readonly', 'true');
    await expect(settingRow(page, 'Account')).toHaveAccessibleName('Account, Personal ChatGPT');
    const panelBounds = await page
      .getByRole('region', { name: 'Agent settings', exact: true })
      .boundingBox();
    expect(panelBounds).not.toBeNull();
    expect(panelBounds!.x).toBeGreaterThanOrEqual(0);
    expect(panelBounds!.x + panelBounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(panelBounds!.y).toBeGreaterThanOrEqual(0);
    expect(panelBounds!.y + panelBounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await expect(composer).toBeInViewport();
    await page.screenshot({
      path: info.outputPath(`role-ordinary-chat-settings-${theme}.png`),
      fullPage: true,
    });
    await page.getByRole('button', { name: /^Workspace controls/ }).click();
    await send.click();
    await expect.poll(() => requests.length).toBe(1);
    await composer.fill('Newer unsent continuation draft.');
    await page.reload();
    await expect(composer).toHaveValue('Newer unsent continuation draft.');
    expect(requests).toHaveLength(1);
    await openChatSetting(page, 'more');
    const recover = page.getByRole('button', {
      name: 'Recover original Local command',
      exact: true,
    });
    await expect(recover).toBeEnabled();
    await page.evaluate(() => window.dispatchEvent(new Event('mitzo:auth-lost')));
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as {
              __mitzoStore: { getState(): { getTransportConnectionId(): string | null } };
            }
          ).__mitzoStore
            .getState()
            .getTransportConnectionId(),
        ),
      )
      .toBeNull();
    // This isolated route omits ProtectedRoute's login navigation. The real
    // transport owner still refuses recovery while authentication is absent.
    if (await recover.isEnabled()) await recover.click();
    expect(requests).toHaveLength(1);
    await page.evaluate(() => window.dispatchEvent(new Event('mitzo:auth-restored')));
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as {
              __mitzoStore: { getState(): { getTransportConnectionId(): string | null } };
            }
          ).__mitzoStore
            .getState()
            .getTransportConnectionId(),
        ),
      )
      .toBe('ordinary-offline-sse');
    await expect(recover).toBeEnabled();
    expect(requests).toHaveLength(1);
    await recover.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]).toEqual(requests[0]);
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('fixture-navigate', { detail: '/chat/other-chat' })),
    );
    await expect(page).toHaveURL(/other-chat$/);
    await expect(composer).toHaveValue('');
    await composer.fill('Keep the other chat draft.');
    releaseRecovery();
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __mitzoStore: { getState(): { localCommand: { state: string } } };
              }
            ).__mitzoStore.getState().localCommand.state,
        ),
      )
      .toBe('consumed');
    await expect(page).toHaveURL(/other-chat$/);
    await expect(composer).toHaveValue('Keep the other chat draft.');
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('fixture-navigate', { detail: '/chat/ordinary-bound' })),
    );
    await expect(composer).toHaveValue('Newer unsent continuation draft.');
    await expect(
      page.getByRole('button', { name: /^Workspace controls/ }),
    ).toHaveAccessibleDescription('Conversation');
    const controls = page.getByRole('button', { name: /^Workspace controls/ });
    if ((await controls.getAttribute('aria-expanded')) === 'true') await controls.click();
    await send.click();
    await expect.poll(() => requests.length).toBe(3);
    expect(requests[2].path).toBe('/api/ordinary/workspaces/commands/continue');
    expect(requests[2].body.clientMsgId).not.toBe(requests[0].body.clientMsgId);
    expect(requests[2].body.payload.text).toBe('Newer unsent continuation draft.');
    await expect(composer).toHaveValue('');
    await page.screenshot({
      path: info.outputPath(`role-ordinary-chat-composer-${theme}.png`),
      fullPage: true,
    });
    expect(errors).toEqual([]);
    expect(forbidden).toEqual([]);
  });
