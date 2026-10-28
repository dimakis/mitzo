import { navigateToReviewedRoleSetup } from './joined-role-setup-ready';
import { waitForPreparedConversation } from './joined-conversation-ready';
import { afterAll, afterEach, expect, it as platformTest, vi } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { installPrivateCanonicalReadCli } from './joined-canonical-cli';
import {
  installJoinedChatTransport,
  createJoinedFrontend,
  createJoinedBrowser,
} from './joined-browser-target';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Response } from 'express';
import type { ownedOrdinaryRuntimeFixture } from '../../../../server/__tests__/fixtures/owned-ordinary-workspace-runtime.js';
import type { CodexLifecycleTransport } from '../../../../server/codex-app-server-client.js';
import type { SessionSseRegistry } from '../../../../server/session-sse-registry.js';
import type { ConnectionRegistry } from '@mitzo/harness';

// CT09 requires the real macOS process-isolation owner used by the artifact helper.
// Required macOS CI runs it completely; Linux separately proves fail-closed refusal.
const it = platformTest;

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
vi.mock('../../../../server/auto-rename.js', () => ({
  shouldAutoRename: () => {
    throw Error('No automatic model naming');
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

// CT09 composes the actual application owners. Only native provider RPCs and
// unrelated notification/naming integrations are fake; no model is invoked.
const cleanup: Array<() => void | Promise<void>> = [];
let f: Awaited<ReturnType<typeof ownedOrdinaryRuntimeFixture>>;
let application: typeof import('../../../../server/app.js');
let chat: typeof import('../../../../server/chat.js');
let auth: typeof import('../../../../server/auth.js');
let transportAuth: typeof import('../../../../server/transport-auth-ownership.js');
let streams: SessionSseRegistry;
let activeBrowser: Awaited<ReturnType<typeof createJoinedBrowser>> | undefined;
const browserNetwork: unknown[] = [];
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
  if (chat && f) {
    for (const row of chat.eventStore.listSessions()) {
      const owned = chat.registry.findBySessionId(row.sessionId);
      if (owned) chat.stopOrdinaryChat(owned.clientId);
    }
    auth.revokeAuthSession(f.auth);
    await vi.waitFor(() => expect(chat.registry.getActiveSessions()).toHaveLength(0));
    streams?.remove(f.operatorConnectionId);
    transportAuth.releaseTransportConnection(f.operatorConnectionId, f.auth.id);
    chat.eventStore.close();
    application.taskStore.close();
  }
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('CT18 actual browser: consumed first-command response loss, document reload and explicit exact recovery preserve native turn, draft and context', async () => {
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
  vi.stubEnv('TELOS_DB_PATH', canonical.dbPath);
  const mgmtCli = await installPrivateCanonicalReadCli(f.configuredWorkspace, canonical.dbPath);
  if (process.env.S9_JOINED_SCREENSHOT_DIR)
    await writeFile(
      join(process.env.S9_JOINED_SCREENSHOT_DIR, 'mgmt-cli-pins.json'),
      JSON.stringify(mgmtCli, null, 2),
    );
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
  cleanup.push(() => front.close());
  const browser = await createJoinedBrowser(front.origin, f.token);
  cleanup.push(async () => {
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
  });
  activeBrowser = browser;
  const page = browser.page;
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
          return rawRpc(method);
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
        request: vi.fn((method: string) => rawRpc(method)),
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

  const http = async (url: string, init?: RequestInit) => {
    const call =
      init?.method === 'POST'
        ? request(application.app).post(url)
        : request(application.app).get(url);
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
  const material = {
    artifactId: canonical.material.id,
    revision: canonical.material.revision,
    sha256: canonical.material.sha256,
  };
  canonical.work.execute(
    {
      operation: 'classify',
      itemId: 'studio',
      requestId: randomUUID(),
      expectedRevision: canonical.work.read('studio', canonical.actor).revision,
      kind: 'outcome',
    },
    canonical.actor,
  );
  chat.eventStore.upsertSession({
    ...canonical.events.getSession('planning')!,
    accountBinding: f.binding,
  });
  const seedRoleDraft = async (draftId: string, search: string) => {
    const browserInventory = await (await http('/api/chat/runtime/capabilities')).json();
    await page.addInitScript(
      ({ draftId, search, first }) => {
        localStorage.setItem('mitzo:transport', 'sse');
        if (localStorage.getItem('mitzo-chat-draft:' + draftId)) return;
        localStorage.setItem(
          'mitzo-chat-draft:' + draftId,
          JSON.stringify({
            version: 1,
            id: draftId,
            text: '',
            images: [],
            contextBlocks: [],
            updatedAt: Date.now(),
            settings: {
              selection: {
                accountId: 'ordinary-personal',
                model: 'fixture-model',
                reasoningEffort: 'low',
              },
              runtimeSelection: {
                version: 1,
                account: {
                  accountId: 'ordinary-personal',
                  model: 'fixture-model',
                  reasoningEffort: 'low',
                },
                accountReference: first.runtime.account,
                agentProfile: first.selection.agent,
                execution: { location: 'local', targetId: first.runtime.targetId },
                capabilityRevision: first.capabilityRevision,
              },
              mode: 'agent',
              isolation: true,
              search,
              summary: null,
            },
          }),
        );
      },
      {
        draftId,
        search,
        first: { ...f.first.request, capabilityRevision: browserInventory.capabilityRevision },
      },
    );
  };
  chat.eventStore.listSessions();
  // Fixture origin/material is adopted through the actual source HTTP owners.
  const originSequence = chat.eventStore.append('planning', 'user_message', {
    messageId: 'origin-plan',
    text: 'Retain the acoustic panel layout and independently review the recording.',
  });
  const originSelection = {
    requestId: randomUUID(),
    expectedMembershipRevision: 0,
    sourceConversationId: 'planning',
    mode: 'selected' as const,
    boundary: { sequence: originSequence, messageId: 'origin-plan' },
    messageIds: ['origin-plan'],
    artifacts: [material],
    purpose: 'Reviewed original acoustic plan',
    joiningBrief: '',
  };
  const originPreview = await api.previewSource({ itemId: 'studio', selection: originSelection });
  await api.adoptSource({
    itemId: 'studio',
    selection: originSelection,
    requestId: randomUUID(),
    expectedRevision: originPreview.packet.workRevision,
    previewSha256: originPreview.sha256,
  });
  const advisorSearch =
    'telosRoleItem=studio&telosRole=advisor&telosRoleMode=additional&telosAdvisor=child&agentProfile=ordinary-worker&profileRevision=1';
  await seedRoleDraft('s9-joined-advisor', advisorSearch);
  await navigateToReviewedRoleSetup(
    page,
    front.origin + '/chat?draft=s9-joined-advisor&' + advisorSearch,
  );
  await browserExpect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeEnabled();
  expect(nativeSessions).toHaveLength(0);
  await Promise.all([
    page
      .waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/telos/work/roles/ordinary/setup-reviewed',
        { timeout: 10000 },
      )
      .then((response) => expect(response.status()).toBe(200)),
    page.getByRole('button', { name: 'Start chat', exact: true }).click(),
  ]);
  await vi.waitFor(async () =>
    expect((await api.read('studio')).links.find((l) => l.role === 'advisor')).toBeTruthy(),
  );
  const advisorId = (await api.read('studio')).links.find((l) => l.role === 'advisor')!.conversation
    .conversationId;
  await browserExpect(page).toHaveURL(new RegExp('/chat/' + advisorId));
  const pinnedSources = (await api.read('studio')).sources;
  const { resolveTelosWorkRoleContext } =
    await import('../../../../server/telos-work-role-context.js');
  const contextBefore = resolveTelosWorkRoleContext(chat.eventStore, advisorId, f.binding);
  expect(contextBefore!.artifacts).toContainEqual(material);
  const originalSource = await api.readSource('studio', pinnedSources[0].snapshotId);
  const requests: Array<Record<string, unknown>> = [];
  const committedReceipts: unknown[] = [];
  await page.route('**/api/ordinary/workspaces/commands/first', async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      // Forward to the actual owned API. Drop only its response after commit.
      const response = await route.fetch();
      committedReceipts.push(await response.json());
      await route.abort('failed');
    } else await route.continue();
  });
  // Preserve the manual exact-replay branch when both delivery observations
  // lose their responses. The actual receipt owner still runs and proves no dispatch.
  const lostReceiptReads: Array<{ status: number; body: Record<string, unknown> }> = [];
  await page.route('**/api/ordinary/workspaces/commands/first/receipt', async (route) => {
    if (route.request().postDataJSON().clientMsgId !== requests[0]?.clientMsgId) {
      await route.continue();
      return;
    }
    const actual = await route.fetch();
    lostReceiptReads.push({ status: actual.status(), body: await actual.json() });
    await route.abort('failed');
  });
  const originalPrompt = 'Inspect only the reviewed acoustic plan; retain the exact source.';
  const composer = page.getByRole('textbox', { name: 'Message Mitzo' });
  await waitForPreparedConversation(page, browserNetwork, advisorId);
  await composer.fill(originalPrompt);
  await browserExpect(
    page.getByRole('button', { name: 'Send message', exact: true }),
  ).toBeEnabled();
  await Promise.all([
    page.waitForEvent('requestfailed', {
      predicate: (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/ordinary/workspaces/commands/first',
      timeout: 10000,
    }),
    page.getByRole('button', { name: 'Send message', exact: true }).click(),
  ]);
  await vi.waitFor(() => expect(committedReceipts).toHaveLength(1));
  const command = requests[0];
  expect(committedReceipts[0]).toMatchObject({
    clientMsgId: String(command.clientMsgId),
    sessionId: advisorId,
    state: 'consumed',
    dispatched: true,
  });
  await vi.waitFor(() => expect(nativeSessions).toHaveLength(1));
  const nativeOwner = nativeSessions[0];
  const turns = () =>
    nativeOwner.rpc.request.mock.calls.filter(([method]) => method === 'turn/start').length;
  await vi.waitFor(() => expect(turns()).toBe(1));
  expect(chat.eventStore.getOrdinaryLocalCommandAdmission(String(command.clientMsgId))?.state).toBe(
    'consumed',
  );
  const clientId = chat.registry.findBySessionId(advisorId)!.clientId;
  const workspace = chat.eventStore.getSession(advisorId)!.ordinaryWorkspaceId!;
  const directory = chat.eventStore.getSession(advisorId)!.cwd!;
  const inode = (await stat(directory)).ino;
  const savedEntries = () =>
    page.evaluate(() =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith('mitzo-local-first-command-outbox:'))
        .map((key) => JSON.parse(localStorage.getItem(key)!)),
    );
  await vi.waitFor(async () =>
    expect(
      (await savedEntries()).find(
        (entry) => entry.body?.clientMsgId === String(command.clientMsgId),
      ),
    ).toMatchObject({ uncertain: true, body: command }),
  );
  const laterDraft = 'Keep this newer unsent continuation after recovery.';
  await composer.fill(laterDraft);
  const reply = 'The exact reviewed source remains retained.';
  nativeOwner.lifecycle.onNotification('item/agentMessage/delta', {
    threadId: nativeOwner.threadId,
    turnId: nativeOwner.turnId,
    itemId: 'recovery-reply',
    delta: reply,
  });
  nativeOwner.lifecycle.onNotification('item/completed', {
    threadId: nativeOwner.threadId,
    turnId: nativeOwner.turnId,
    item: { type: 'agentMessage', id: 'recovery-reply', text: reply },
  });
  nativeOwner.lifecycle.onNotification('turn/completed', {
    threadId: nativeOwner.threadId,
    turn: { id: nativeOwner.turnId, status: 'completed' },
  });
  await browserExpect(page.getByText(reply, { exact: true })).toBeVisible();
  await page.reload();
  await browserExpect(composer).toHaveValue(laterDraft);
  await vi.waitFor(() => expect(chat.registry.isAttached(clientId)).toBe(true));
  expect(chat.registry.findBySessionId(advisorId)?.clientId).toBe(clientId);
  expect(requests).toHaveLength(1);
  expect(nativeSessions).toHaveLength(1);
  expect(turns()).toBe(1);
  await browserExpect(page.getByText(reply, { exact: true })).toBeVisible();
  await vi.waitFor(
    () =>
      expect(
        lostReceiptReads.some(
          (read) =>
            read.status === 202 &&
            read.body.clientMsgId === requests[0].clientMsgId &&
            read.body.sessionId === requests[0].sessionId &&
            read.body.state === 'consumed' &&
            read.body.dispatched === false,
        ),
      ).toBe(true),
    { timeout: 10000 },
  );
  const settings = page.getByRole('button', { name: /^Workspace controls/ });
  if ((await settings.getAttribute('aria-expanded')) === 'true') await settings.click();
  const recover = page.getByRole('button', { name: 'Retry', exact: true });
  await browserExpect(recover).toBeEnabled();
  const [recovered] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/api/ordinary/workspaces/commands/first'),
      { timeout: 10000 },
    ),
    recover.click(),
  ]);
  const retryReceipt = await recovered.json();
  expect(recovered.status()).toBe(202);
  expect(retryReceipt).toMatchObject({
    clientMsgId: String(command.clientMsgId),
    sessionId: advisorId,
    state: 'consumed',
    dispatched: false,
  });
  expect(requests).toEqual([command, command]);
  await browserExpect(recover).toHaveCount(0);
  if ((await settings.getAttribute('aria-expanded')) === 'true') await settings.click();
  await browserExpect(composer).toHaveValue(laterDraft);
  expect(nativeSessions).toHaveLength(1);
  expect(turns()).toBe(1);
  expect(chat.eventStore.getSession(advisorId)?.ordinaryWorkspaceId).toBe(workspace);
  expect((await stat(directory)).ino).toBe(inode);
  expect((await api.read('studio')).sources).toEqual(pinnedSources);
  expect(await api.readSource('studio', pinnedSources[0].snapshotId)).toEqual(originalSource);
  expect(resolveTelosWorkRoleContext(chat.eventStore, advisorId, f.binding)).toEqual(contextBefore);
  expect(canonical.artifacts.read(material.artifactId, material.revision).bytes.toString()).toBe(
    'The reviewed panel layout.',
  );
  expect(
    chat.eventStore
      .getSessionEvents(advisorId)
      .filter(
        (event) =>
          event.type === 'user_message' &&
          (event.payload as { text?: string }).text === originalPrompt,
      ),
  ).toHaveLength(1);
  expect(application.taskStore.getTree()).toHaveLength(0);
  expect(chat.eventStore.getOrdinaryInitialCommandId(f.first.receipt.sessionId)).toBeUndefined();
  expect(f.legacyLookup).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(pageErrors).toEqual([]);
  if (process.env.S9_JOINED_SCREENSHOT_DIR)
    await writeFile(
      join(process.env.S9_JOINED_SCREENSHOT_DIR, 'recovery-proof.json'),
      JSON.stringify(
        {
          requests,
          committedReceipts,
          retryReceipt,
          nativeLaunches: nativeSessions.length,
          nativeTurns: turns(),
          originalClientId: clientId,
          workspaceId: workspace,
          directoryInode: inode,
          originalSources: pinnedSources,
          originalContext: contextBefore,
          laterDraft,
          noApiFulfilment: true,
          droppedOnlyRealCommittedResponse: true,
        },
        null,
        2,
      ),
    );
}, 120_000);
