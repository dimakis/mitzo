import { afterAll, afterEach, expect, vi } from 'vitest';
import type { BrowserContextOptions } from '@playwright/test';
import { installPrivateCanonicalReadCli } from './joined-canonical-cli';
import {
  installJoinedChatTransport,
  createJoinedFrontend,
  createJoinedBrowser,
} from './joined-browser-target';
import request from 'supertest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Response } from 'express';
import type { ownedOrdinaryRuntimeFixture } from '../../../../server/__tests__/fixtures/owned-ordinary-workspace-runtime.js';
import type { CodexLifecycleTransport } from '../../../../server/codex-app-server-client.js';
import type { SessionSseRegistry } from '../../../../server/session-sse-registry.js';
import type { ConnectionRegistry } from '@mitzo/harness';

const services = vi.hoisted(() => ({ workspace: undefined as unknown }));
vi.mock('../../../../server/repository-workspace-runtime.js', async (original) => ({
  ...(await original<object>()),
  getOrdinaryWorkspaces: () => services.workspace,
}));
vi.mock('../../../../server/internal-token.js', () => ({
  INTERNAL_TOKEN: 'synthetic-only-ordinary-native-token',
  isValidInternalToken: (value: unknown) => value === 'synthetic-only-ordinary-native-token',
  createSignalCallbackToken: vi.fn(() => 'synthetic-callback'),
  revokeSignalCallbackToken: vi.fn(),
  isValidSignalCallbackToken: () => false,
}));
// Source-mode MCP children run from a deliberately empty non-Git task cwd.
// Resolve the test loader absolutely; preserve the real bundled MCP source,
// stdio transport, tool registration and callback implementation.
vi.mock('../../../../server/mcp-entrypoint.js', async (original) => {
  const actual = await original<typeof import('../../../../server/mcp-entrypoint.js')>();
  const { createRequire } = await import('node:module');
  const loader = createRequire(import.meta.url).resolve('tsx');
  return {
    ...actual,
    resolveBundledMcpEntrypoint: (url: string, name: string) => {
      const entry = actual.resolveBundledMcpEntrypoint(url, name);
      return {
        command: process.execPath,
        args: entry.args.map((arg) => (arg === 'tsx' ? loader : arg)),
      };
    },
  };
});
vi.mock('../../../../server/mcp-config.js', () => ({
  loadMcpServers: () => ({}),
  getMcpConfigPaths: () => [],
  loadFromFile: () => ({}),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('No SDK or real model execution');
  },
}));
vi.mock('../../../../server/auto-rename.js', async (original) => ({
  ...(await original<typeof import('../../../../server/auto-rename.js')>()),
  generateSessionName: async () => {
    throw Error('No automatic model naming');
  },
  createAnthropicClient: () => {
    throw Error('No automatic model naming client');
  },
}));
vi.mock('../../../../server/notify.js', () => ({
  sendTurnCompleteNotification: vi.fn(async () => {}),
}));
vi.mock('../../../../server/pushover.js', () => ({
  sendTurnCompleteNotification: vi.fn(async () => {}),
}));
vi.mock('../../../../server/goal-client.js', () => ({
  createGoal: vi.fn(async () => null),
  reportUsage: vi.fn(async () => {}),
  deriveGoalTitle: () => 'Offline',
}));
vi.mock('../../../../server/account-session-name.js', () => ({
  accountSessionName: vi.fn(async () => {
    throw Error('No model-backed session naming');
  }),
}));

// CT09 composes the actual application owners. Only native provider RPCs and
// unrelated notification/naming integrations are fake; no model is invoked.
const cleanup: Array<() => void | Promise<void>> = [];
let closeActiveBrowser: (() => Promise<void>) | undefined;
let closeActiveFrontend: (() => Promise<void>) | undefined;
let drainPrivateCommands: (() => Promise<void>) | undefined;
let f: Awaited<ReturnType<typeof ownedOrdinaryRuntimeFixture>>;
let application: typeof import('../../../../server/app.js');
let chat: typeof import('../../../../server/chat.js');
let auth: typeof import('../../../../server/auth.js');
let transportAuth: typeof import('../../../../server/transport-auth-ownership.js');
let streams: SessionSseRegistry;
let activeBrowser: Awaited<ReturnType<typeof createJoinedBrowser>> | undefined;
const browserNetwork: Array<{ path: string; status: number; body: string }> = [];
let connections: ConnectionRegistry;
const streamMessages: Record<string, unknown>[] = [];
const nativeSessions: Array<{
  lifecycle: CodexLifecycleTransport;
  rpc: typeof f.first.rpc;
  threadId: string;
  turnId: string;
  tools: Array<{ name: string; description: string }>;
}> = [];
const startup = await vi.hoisted(async () => {
  const fs = await import('node:fs'),
    os = await import('node:os'),
    path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-journey-startup-')));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', path.join(root, 'private'));
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER', undefined);
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_OWNER', undefined);
  return { remove: () => fs.rmSync(root, { recursive: true, force: true }) };
});
afterAll(() => startup.remove());
afterEach(async () => {
  if (activeBrowser && process.env.S9_JOINED_SCREENSHOT_DIR) {
    await activeBrowser.page
      .screenshot({
        path: join(process.env.S9_JOINED_SCREENSHOT_DIR, 'failure-before-auth-teardown.png'),
        fullPage: true,
      })
      .catch(() => {});
    await writeFile(
      join(process.env.S9_JOINED_SCREENSHOT_DIR, 'page-before-auth-teardown.txt'),
      await activeBrowser.page
        .locator('body')
        .innerText()
        .catch(() => ''),
    );
    await writeFile(
      join(process.env.S9_JOINED_SCREENSHOT_DIR, 'browser-network.json'),
      JSON.stringify(browserNetwork, null, 2),
    );
  }
  await closeActiveBrowser?.();
  if (chat && f) {
    for (const row of chat.eventStore.listSessions()) {
      const owned = chat.registry.findBySessionId(row.sessionId);
      if (owned) chat.stopOrdinaryChat(owned.clientId);
    }
    auth.revokeAuthSession(f.auth);
    await vi.waitFor(() => expect(chat.registry.getActiveSessions()).toHaveLength(0));
    streams?.remove(f.operatorConnectionId);
    transportAuth.releaseTransportConnection(f.operatorConnectionId, f.auth.id);
    await closeActiveFrontend?.();
    await drainPrivateCommands?.();
    chat.eventStore.close();
    application.taskStore.close();
  }
  for (const close of cleanup.splice(0).reverse()) await close();
  closeActiveBrowser = undefined;
  closeActiveFrontend = undefined;
  drainPrivateCommands = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Shared S9 bootstrap for further actual application cases. Earlier frozen
 * journey/recovery files remain unchanged so their source-pinned receipts stay
 * independently reproducible. One private app/browser owner per test.
 */
export async function createJoinedOrdinaryApplication(
  browserOptions: BrowserContextOptions = {},
  initializeSynthetic?: (data: {
    runtime: typeof f;
    canonical: ReturnType<
      (typeof import('../../../../server/__tests__/fixtures/telos-canonical-advisor.js'))['createTelosCanonicalData']
    >;
  }) => void,
  externalModelList?: (params?: Record<string, unknown>) => unknown | Promise<unknown>,
) {
  vi.resetModules();
  vi.stubEnv('MITZO_KNOWLEDGE_LIBRARY_CONFIG', undefined);
  vi.stubEnv('MITZO_WORKSPACE_RUNTIME_CONFIG', undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No external network or model calls');
    }),
  );
  const { ownedOrdinaryRuntimeFixture } =
    await import('../../../../server/__tests__/fixtures/owned-ordinary-workspace-runtime.js');
  f = await ownedOrdinaryRuntimeFixture(cleanup, {
    chatRoute: true,
    separateConfiguredWorkspace: true,
  });
  services.workspace = f.workspaces;
  const { createTelosCanonicalData } =
    await import('../../../../server/__tests__/fixtures/telos-canonical-advisor.js');
  const canonical = createTelosCanonicalData('fresh');
  cleanup.push(() => canonical.close());
  // Optional dedicated acceptance data, before App imports/owns these files.
  initializeSynthetic?.({ runtime: f, canonical });
  vi.stubEnv('TELOS_DB_PATH', canonical.dbPath);
  const mgmtCli = await installPrivateCanonicalReadCli(f.configuredWorkspace, canonical.dbPath);
  if (process.env.S9_JOINED_SCREENSHOT_DIR)
    await writeFile(
      join(process.env.S9_JOINED_SCREENSHOT_DIR, 'mgmt-cli-pins.json'),
      JSON.stringify(mgmtCli, null, 2),
    );
  const { observePrivateCanonicalCommands } = await import('./observe-private-command-lifecycle');
  drainPrivateCommands = observePrivateCanonicalCommands({
    scriptPath: join(f.configuredWorkspace, 'command_center', 'todo_api.py'),
    databasePath: canonical.dbPath,
    evidenceDirectory: process.env.S9_JOINED_SCREENSHOT_DIR,
  });
  cleanup.push(drainPrivateCommands);
  application = await import('../../../../server/app.js');
  chat = await import('../../../../server/chat.js');
  auth = await import('../../../../server/auth.js');
  transportAuth = await import('../../../../server/transport-auth-ownership.js');
  const native = await import('../../../../server/codex-app-server-client.js');
  const { SessionSseRegistry } = await import('../../../../server/session-sse-registry.js');
  const { SseTransport } = await import('../../../../server/sse-transport.js');
  connections = await installJoinedChatTransport(
    application.app,
    chat,
    application.chatSseRegistry,
  );
  streams = application.chatSseRegistry;
  expect(streams).toBeInstanceOf(SessionSseRegistry);
  const originalSendTo = streams.sendTo.bind(streams);
  vi.spyOn(streams, 'sendTo').mockImplementation((id, message) => {
    streamMessages.push(message);
    return originalSendTo(id, message);
  });
  streams.add(
    f.operatorConnectionId,
    {
      write: vi.fn((frame: string) => {
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (data) streamMessages.push(JSON.parse(data.slice(6)));
        return true;
      }),
      end: vi.fn(),
      writableEnded: false,
    } as unknown as Response,
    f.auth.id,
  );
  connections.register(f.operatorConnectionId, new SseTransport(f.operatorConnectionId, streams));
  transportAuth.claimTransportConnection(f.operatorConnectionId, f.auth.id);
  chat.setConnectionRegistry(connections);
  application.setTaskBroadcast((event) => {
    connections.broadcastAll(event);
    application.sseRegistry.broadcast('task_state', event);
  });
  const front = await createJoinedFrontend(application.app, f.root);
  vi.stubEnv('PORT', String(front.port));
  let frontendClosed = false;
  closeActiveFrontend = async () => {
    if (frontendClosed) return;
    await front.close();
    frontendClosed = true;
  };
  cleanup.push(closeActiveFrontend);
  const browser = await createJoinedBrowser(front.origin, f.token, browserOptions);
  let browserClosed = false;
  closeActiveBrowser = async () => {
    if (browserClosed) return;
    if (process.env.S9_JOINED_SCREENSHOT_DIR) {
      await browser.page
        .screenshot({
          path: join(process.env.S9_JOINED_SCREENSHOT_DIR, 'last-page.png'),
          fullPage: true,
        })
        .catch(() => {});
      await writeFile(
        join(process.env.S9_JOINED_SCREENSHOT_DIR, 'last-page.txt'),
        await browser.page
          .locator('body')
          .innerText()
          .catch(() => ''),
      );
    }
    await browser.browser.close();
    browserClosed = true;
  };
  cleanup.push(closeActiveBrowser);
  activeBrowser = browser;
  const page = browser.page;
  await page.addInitScript(() => localStorage.setItem('mitzo:transport', 'sse'));
  page.on('response', async (response) => {
    if (response.url().includes('/api/'))
      browserNetwork.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
        body: await response.text().catch(() => '<stream>'),
      });
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const rawRpc = f.first.rpc.request.getMockImplementation()!;
  // Optional external model-list stimulus only. Actual profile/catalog/cache,
  // runtime selection, admission and allocator owners remain unchanged.
  const metadata = (method: string, params?: Record<string, unknown>): Promise<unknown> =>
    method === 'model/list' && externalModelList
      ? Promise.resolve().then(() => externalModelList(params))
      : rawRpc(method);
  vi.spyOn(native.CodexAppServerClient, 'launchIsolated').mockImplementation(
    (_home, _env, lifecycle) => {
      if (!lifecycle) throw Error('Native lifecycle callbacks required');
      const n = nativeSessions.length + 1;
      const threadId = 'offline-journey-thread-' + n,
        turnId = 'offline-journey-turn-' + n;
      const tools: Array<{ name: string; description: string }> = [];
      const rpc = {
        initialize: vi.fn(async () => {}),
        request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
          if (method === 'thread/start')
            tools.push(...((params?.dynamicTools as typeof tools) ?? []));
          if (method === 'thread/start' || method === 'thread/resume')
            return { thread: { id: threadId }, model: 'fixture-model', modelProvider: 'openai' };
          if (method === 'turn/start') return { turn: { id: turnId } };
          if (method === 'turn/interrupt') return {};
          return metadata(method, params);
        }),
        notify: vi.fn(),
        respond: vi.fn(),
        close: vi.fn(() => lifecycle.onClose?.(Error('Offline native closed'))),
      } as unknown as typeof f.first.rpc;
      nativeSessions.push({ lifecycle, rpc, threadId, turnId, tools });
      return rpc as unknown as ReturnType<typeof native.CodexAppServerClient.launchIsolated>;
    },
  );
  // Model discovery is an external provider RPC too. Keep the actual catalog,
  // cache and profile identity owners, using the fixture's deterministic replies.
  vi.spyOn(native.CodexAppServerClient, 'launchPreflight').mockImplementation(
    () =>
      ({
        initialize: vi.fn(async () => {}),
        request: vi.fn((method: string, params?: Record<string, unknown>) =>
          metadata(method, params),
        ),
        notify: vi.fn(),
        close: vi.fn(),
      }) as unknown as ReturnType<typeof native.CodexAppServerClient.launchPreflight>,
  );
  const { loadAccountProfiles } = await import('../../../../server/account-profiles.js');
  await loadAccountProfiles().refresh(true);
  for (const port of ['launch', 'launchOpenShell'] as const)
    vi.spyOn(native.CodexAppServerClient, port).mockImplementation(() => {
      throw Error('Alternate native process forbidden');
    });

  // Supertest(app) binds a wildcard socket but connects to IPv4. macOS can
  // permit a competing IPv4 listener at that port (see loopback-test-server).
  // Reuse the same explicitly owned loopback server as the actual browser.
  const privateAddress = front.server.address();
  if (
    !privateAddress ||
    typeof privateAddress === 'string' ||
    privateAddress.address !== '127.0.0.1' ||
    privateAddress.port !== front.port
  )
    throw Error('The private application IPv4 listener must own API requests');
  const apiTransportTarget = {
    address: privateAddress.address,
    port: privateAddress.port,
    kind: 'owned-private-loopback',
  };
  if (process.env.S9_JOINED_SCREENSHOT_DIR)
    await writeFile(
      join(process.env.S9_JOINED_SCREENSHOT_DIR, 'app-http-target.json'),
      JSON.stringify(apiTransportTarget, null, 2),
    );
  const http = async (url: string, init?: RequestInit) => {
    const call =
      init?.method === 'POST' ? request(front.server).post(url) : request(front.server).get(url);
    call.set('Authorization', 'Bearer ' + f.token).set('X-Connection-Id', f.operatorConnectionId);
    for (const [key, value] of new Headers(init?.headers)) call.set(key, value);
    if (init?.body) call.send(JSON.parse(String(init.body)));
    const response = await call;
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(400);
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const { OrdinaryWorkspaceApiClient, TelosWorkApiClient } = await import('@mitzo/client');
  const ordinary = new OrdinaryWorkspaceApiClient(http),
    api = new TelosWorkApiClient(http);
  const prepared = await ordinary.prepare({
    version: 1,
    model: f.binding.model,
    runOn: 'local',
    runtime: {
      account: f.first.request.runtime.account,
      harness: f.first.request.runtime.harness,
      targetId: f.first.request.runtime.targetId,
    },
  });
  expect(prepared.capabilities).toEqual([
    'ordinary_conversation',
    'writable_files',
    'retained_artifacts',
    'task_execution',
  ]);
  return {
    f,
    canonical,
    application,
    chat,
    auth,
    transportAuth,
    streams,
    connections,
    browser,
    front,
    page,
    api,
    ordinary,
    prepared,
    http,
    apiTransportTarget,
    nativeSessions,
    streamMessages,
    browserNetwork,
    pageErrors,
    cleanup,
  };
}
