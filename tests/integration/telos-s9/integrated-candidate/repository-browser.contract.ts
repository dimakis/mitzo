import { prepareNativeProviderToolCall } from '../../../../server/__tests__/fixtures/native-provider-tool-call.js';
import { afterAll, afterEach, expect, it as platformTest, vi } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { installPrivateCanonicalReadCli } from './joined-canonical-cli';
import { createJoinedRepositoryEffects } from './joined-repository-source';
import type { GithubRepositoryCommand } from '../../../../server/github-repository-source.js';
import {
  installJoinedChatTransport,
  createJoinedFrontend,
  createJoinedBrowser,
} from './joined-browser-target';
import request from 'supertest';
import { randomUUID, createHash } from 'node:crypto';
import { access, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Response } from 'express';
import type { ownedOrdinaryRuntimeFixture } from '../../../../server/__tests__/fixtures/owned-ordinary-workspace-runtime.js';
import type { CodexLifecycleTransport } from '../../../../server/codex-app-server-client.js';
import type { SessionSseRegistry } from '../../../../server/session-sse-registry.js';
import type { ConnectionRegistry } from '@mitzo/harness';

// CT09 requires the real macOS process-isolation owner used by the artifact helper.
// Required macOS CI runs it completely; Linux separately proves fail-closed refusal.
const it = platformTest;

const services = vi.hoisted(() => ({
  workspace: undefined as unknown,
  repositoryRun: undefined as unknown as GithubRepositoryCommand,
}));
vi.mock('../../../../server/github-repository-source.js', async (original) => {
  const actual = await original<typeof import('../../../../server/github-repository-source.js')>();
  return {
    ...actual,
    inspectGithubRepositorySource: (selected: string, signal: AbortSignal) =>
      actual.inspectGithubRepositorySource(selected, signal, services.repositoryRun),
    prepareGithubRepositorySource: (
      input: Parameters<typeof actual.prepareGithubRepositorySource>[0],
      directory: string,
      branch: string,
      signal: AbortSignal,
    ) =>
      actual.prepareGithubRepositorySource(
        input,
        directory,
        branch,
        signal,
        services.repositoryRun,
      ),
  };
});
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
vi.mock('../../../../server/account-session-name.js', () => ({
  accountSessionName: vi.fn(async () => {
    throw Error('No model-backed session naming');
  }),
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
  firstTurnStarted: Promise<void>;
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

it('CT06/17/18 repository counterpart: actual advisor, lead and worker pages retain source, independent checkouts, output and review', async () => {
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
  vi.stubEnv('MITZO_REPOSITORY_WORKSPACES_ENABLED', '1');
  const repositoryEffects = await createJoinedRepositoryEffects(f.root, f.binding.accountId);
  services.repositoryRun = repositoryEffects.run;
  cleanup.push(() => repositoryEffects.close());
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
  application.setConnectionsRuntime(repositoryEffects.runtime);
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
      let markFirstTurnStarted!: () => void;
      const firstTurnStarted = new Promise<void>((resolve) => {
        markFirstTurnStarted = resolve;
      });
      const rpc = {
        initialize: vi.fn(async () => {}),
        request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
          if (method === 'thread/start')
            tools.push(...((params?.dynamicTools as typeof tools) ?? []));
          if (method === 'thread/start' || method === 'thread/resume')
            return { thread: { id: threadId }, model: 'fixture-model', modelProvider: 'openai' };
          if (method === 'turn/start') {
            markFirstTurnStarted();
            return { turn: { id: turnId } };
          }
          if (method === 'turn/interrupt') return {};
          return rawRpc(method);
        }),
        notify: vi.fn(),
        respond: vi.fn(),
        close: vi.fn(() => lifecycle.onClose?.(Error('Offline native closed'))),
      } as unknown as typeof f.first.rpc;
      nativeSessions.push({ lifecycle, rpc, threadId, turnId, tools, firstTurnStarted });
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
  const { TelosWorkApiClient } = await import('@mitzo/client');
  const api = new TelosWorkApiClient(http);
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
    const sourcePreview = await (
      await http('/api/repository-workspaces/preview', {
        method: 'POST',
        body: JSON.stringify({
          accountId: f.binding.accountId,
          model: f.binding.model,
          connectionId: repositoryEffects.connectionId,
          repository: 'example/acceptance',
          ordinaryRuntime: {
            runOn: 'local',
            runtime: {
              account: f.first.request.runtime.account,
              harness: f.first.request.runtime.harness,
              targetId: f.first.request.runtime.targetId,
            },
          },
        }),
      })
    ).json();
    const repository = await (
      await http('/api/repository-workspaces/' + sourcePreview.id + '/prepare', {
        method: 'POST',
        body: JSON.stringify({ accountId: f.binding.accountId, model: f.binding.model }),
      })
    ).json();
    expect(repository).toMatchObject({
      state: 'ready',
      repository: 'example/acceptance',
      baseOid: repositoryEffects.baseOid,
    });
    await page.addInitScript(
      ({ draftId, search, first, repositoryId }) => {
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
              repositoryWorkspaceId: repositoryId,
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
        repositoryId: repository.id,
        first: { ...f.first.request, capabilityRevision: browserInventory.capabilityRevision },
      },
    );
  };
  const before = chat.eventStore.listSessions().length;
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
  await page.goto(front.origin + '/chat?draft=s9-joined-advisor&' + advisorSearch);
  await browserExpect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeEnabled();
  expect(nativeSessions).toHaveLength(0);
  await Promise.all([
    page
      .waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/telos/work/roles/setup-reviewed',
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
  const advisorPrompt = 'Please retain the acoustic plan and create the reviewed recording slice.';
  await page.getByRole('textbox', { name: 'Message Mitzo' }).fill(advisorPrompt);
  const preparedAdvisor = chat.eventStore.getOrdinarySessionPreparationForConversation(advisorId);
  expect(preparedAdvisor).toBeTruthy();
  expect(preparedAdvisor!.settings).toHaveProperty('repositoryWorkspaceId');
  const repositoryId = (preparedAdvisor!.settings as { repositoryWorkspaceId: string })
    .repositoryWorkspaceId;
  const repositoryRuntime = await import('../../../../server/repository-workspace-runtime.js');
  const preparedRepository = repositoryRuntime.getRepositoryWorkspaces(true).get(repositoryId);
  expect(preparedRepository.baseOid).toBe(repositoryEffects.baseOid);
  expect(chat.eventStore.getOrdinaryInitialCommandId(advisorId)).toBeUndefined();
  expect(nativeSessions).toHaveLength(0);
  if (process.env.S9_JOINED_SCREENSHOT_DIR)
    await writeFile(
      join(process.env.S9_JOINED_SCREENSHOT_DIR, 'repository-before-first-send.json'),
      JSON.stringify(
        {
          source: 'Exact execution and production source retained in source-proof.json',
          metadata: await (await http('/api/sessions/' + advisorId + '/meta')).json(),
          retainedPreparation: preparedAdvisor,
          repository: preparedRepository,
          actualSourceCommit: repositoryEffects.baseOid,
          nativeLaunches: nativeSessions.length,
          externalCalls: repositoryEffects.externalCalls,
        },
        null,
        2,
      ),
    );
  await browserExpect(
    page.getByRole('button', { name: 'Send message', exact: true }),
  ).toBeEnabled();
  const [advisorSend] = await Promise.all([
    page.waitForRequest(
      (r) => r.method() === 'POST' && r.url().endsWith('/api/chat/local-codex/send'),
      { timeout: 10000 },
    ),
    page.getByRole('button', { name: 'Send message', exact: true }).click(),
  ]);
  expect(await (await advisorSend.response())!.json()).toMatchObject({
    state: 'consumed',
    dispatched: true,
  });
  expect(chat.eventStore.listSessions()).toHaveLength(before + 1);
  await vi.waitFor(() => expect(nativeSessions).toHaveLength(1));
  const advisorNative = nativeSessions[0];
  // A simulated provider may produce this turn's output only after turn/start.
  await vi.waitFor(
    () =>
      expect(
        advisorNative.rpc.request.mock.calls.filter(([method]) => method === 'turn/start'),
      ).toHaveLength(1),
    { timeout: 10000 },
  );
  const advisorReply = 'Retain this reviewed acoustic plan; execution is a separate decision.';
  advisorNative.lifecycle.onNotification('item/agentMessage/delta', {
    threadId: advisorNative.threadId,
    turnId: advisorNative.turnId,
    itemId: 'advisor-review',
    delta: advisorReply,
  });
  advisorNative.lifecycle.onNotification('item/completed', {
    threadId: advisorNative.threadId,
    turnId: advisorNative.turnId,
    item: { type: 'agentMessage', id: 'advisor-review', text: advisorReply },
  });
  advisorNative.lifecycle.onNotification('turn/completed', {
    threadId: advisorNative.threadId,
    turn: { id: advisorNative.turnId, status: 'completed' },
  });
  await browserExpect(
    page.getByRole('button', { name: 'Suggest a draft', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Suggest a draft', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Reviewed recording plan');
  await page.getByRole('textbox', { name: 'Desired outcome', exact: true }).fill('Record clearly');
  await page.getByRole('textbox', { name: 'Category', exact: true }).fill('Music');
  const [previewResponse, saveResponse] = await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/api/telos/work/advisor/preview'),
      { timeout: 10000 },
    ),
    page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/api/telos/work/advisor/save'),
      { timeout: 10000 },
    ),
    page.getByRole('button', { name: 'Save child draft', exact: true }).click(),
  ]);
  expect(previewResponse.status()).toBe(200);
  expect(saveResponse.status()).toBe(200);
  const draft = previewResponse.request().postDataJSON();
  const preview = await previewResponse.json();
  const saved = await saveResponse.json();
  const savedRequest = saveResponse.request().postDataJSON();
  expect(savedRequest).toEqual({ ...draft, previewSha256: preview.sha256 });
  expect(await api.saveAdvisorDraft(savedRequest)).toEqual(saved);
  const childId = saved.work.itemId;
  expect(saved.work.sources).toHaveLength(1);
  const originalSource = saved.work.sources[0];
  expect(originalSource).toMatchObject({
    itemId: childId,
    source: { namespace: 'mitzo', conversationId: advisorId },
    selection: { kind: 'selected', throughSequence: draft.selection.boundary.sequence },
  });
  expect(originalSource.artifacts).toContainEqual(material);
  const assertOriginalSource = async () => {
    expect((await api.read(childId)).sources).toEqual([originalSource]);
    const retainedSource = await api.readSource(childId, originalSource.snapshotId);
    expect(retainedSource.snapshot).toEqual(originalSource);
    expect(retainedSource.packet).toEqual(preview.packet);
    expect(retainedSource.packet.selection).toEqual(draft.selection);
    expect(retainedSource.packet.context.sourceConversationId).toBe(advisorId);
    expect(retainedSource.packet.context.boundary).toEqual(draft.selection.boundary);
    expect(
      retainedSource.packet.context.messages.every(
        (m: { conversationId: string }) => m.conversationId === advisorId,
      ),
    ).toBe(true);
    const narrative = retainedSource.packet.context.messages.flatMap(
      (m: { blocks: Array<{ content: string }> }) => m.blocks.map((b) => b.content),
    );
    expect(narrative).toContain(advisorPrompt);
    expect(narrative).toContain(advisorReply);
    expect(createHash('sha256').update(JSON.stringify(retainedSource.packet)).digest('hex')).toBe(
      preview.sha256,
    );
    const originalMaterial = retainedSource.packet.context.artifacts.find(
      (pin) => pin.artifactId === material.artifactId,
    )!;
    expect(originalMaterial).toMatchObject(material);
    const retainedMaterial = canonical.artifacts.read(material.artifactId, material.revision);
    expect(retainedMaterial.sha256).toBe(material.sha256);
    expect(retainedMaterial.bytes.toString()).toBe('The reviewed panel layout.');
    expect(Buffer.from(originalMaterial.contentBase64!, 'base64')).toEqual(retainedMaterial.bytes);
    expect(createHash('sha256').update(retainedMaterial.bytes).digest('hex')).toBe(material.sha256);
  };
  await assertOriginalSource();

  expect(
    canonical.db.prepare('SELECT first_seen,last_seen FROM items WHERE id=?').get(childId),
  ).toEqual({ first_seen: expect.any(String), last_seen: expect.any(String) });
  expect(
    canonical.db.prepare('SELECT old_status,new_status FROM history WHERE item_id=?').all(childId),
  ).toEqual([{ old_status: null, new_status: 'active' }]);
  const draftId = 's9-joined-lead';
  const search = `telosRoleItem=studio&telosRole=lead&telosRoleMode=assign&agentProfile=ordinary-worker&profileRevision=1`;
  await seedRoleDraft(draftId, search);
  await page.goto(front.origin + '/chat?draft=' + draftId + '&' + search);
  await browserExpect(page.getByRole('region', { name: 'Work conversation setup' })).toBeVisible();
  await browserExpect(
    page.getByRole('button', { name: 'Assign lead & open chat', exact: true }),
  ).toBeEnabled();
  expect(nativeSessions).toHaveLength(1);
  await Promise.all([
    page
      .waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/telos/work/roles/setup-reviewed',
        { timeout: 10000 },
      )
      .then((response) => expect(response.status()).toBe(200)),
    page.getByRole('button', { name: 'Assign lead & open chat', exact: true }).click(),
  ]);
  await vi.waitFor(async () =>
    expect(
      (await api.read('studio')).assignments.find((a) => a.role === 'lead')?.conversation
        .conversationId,
    ).toBeTruthy(),
  );
  const leadId = (await api.read('studio')).assignments.find((a) => a.role === 'lead')!.conversation
    .conversationId;
  await browserExpect(page).toHaveURL(new RegExp('/chat/' + leadId));
  await browserExpect(page.getByRole('textbox', { name: 'Message Mitzo' })).toBeVisible();
  expect(nativeSessions).toHaveLength(1);
  await page
    .getByRole('textbox', { name: 'Message Mitzo' })
    .fill('Perform only the reviewed work and retain a report.');
  await browserExpect(
    page.getByRole('button', { name: 'Send message', exact: true }),
  ).toBeEnabled();
  const [firstBrowserSend] = await Promise.all([
    page.waitForRequest(
      (r) => r.method() === 'POST' && r.url().includes('/api/chat/local-codex/send'),
      { timeout: 10000 },
    ),
    page.getByRole('button', { name: 'Send message', exact: true }).click(),
  ]);
  const leadCommand = firstBrowserSend.postDataJSON();
  const leadResponse = await firstBrowserSend.response();
  expect(leadResponse).toBeTruthy();
  const leadReceipt = await leadResponse!.json();
  expect(leadReceipt).toMatchObject({
    state: 'consumed',
    dispatched: true,
    sessionId: leadId,
    clientMsgId: leadCommand.clientMsgId,
  });
  await vi.waitFor(() => expect(nativeSessions).toHaveLength(2));
  // Prepared repository V1 keeps its session in local delivery metadata and
  // the durable reservation, rather than adding a field to the wire body.
  expect(chat.eventStore.getOrdinaryInitialCommandId(leadId)).toBe(leadCommand.clientMsgId);
  expect(chat.eventStore.getSession(leadId)?.repositoryWorkspaceId).toBe(
    leadCommand.repositoryWorkspaceId,
  );
  await vi.waitFor(() =>
    expect(
      nativeSessions[1].rpc.request.mock.calls.filter(([m]) => m === 'turn/start'),
    ).toHaveLength(1),
  );
  if (process.env.S9_JOINED_SCREENSHOT_DIR)
    await page.screenshot({
      path: join(process.env.S9_JOINED_SCREENSHOT_DIR, 'lead-native-start.png'),
      fullPage: true,
    });
  const leadClientId = chat.registry.findBySessionId(leadId)!.clientId;
  const { TaskOrchestrator } = await import('../../../../server/task-orchestrator.js');
  const getClientId = vi.fn(() => {
    throw Error('Legacy scheduler must not select a worker');
  });
  const orchestrator = new TaskOrchestrator({
    store: application.taskStore,
    getClientId,
    setTaskContext: vi.fn(),
    clearTaskContext: vi.fn(),
    broadcastStatus: vi.fn(),
    broadcastTasks: () => {
      const event = { type: 'task_state', tasks: application.taskStore.getTree() };
      connections.broadcastAll(event);
      application.sseRegistry.broadcast('task_state', event);
    },
  });
  application.setOrchestrator(orchestrator);
  const input = {
    requestId: randomUUID(),
    childItemId: childId,
    mode: 'start',
    predecessorAttemptId: null,
    sourceSnapshotIds: saved.work.sources.map((s: { snapshotId: string }) => s.snapshotId),
    artifactRefs: [material],
  };
  const internal = (clientId: string, path: string, body: object) =>
    http(path, {
      method: 'POST',
      headers: {
        'x-internal-token': 'synthetic-only-ordinary-native-token',
        'x-client-id': clientId,
      },
      body: JSON.stringify(body),
    });
  const delegate = () =>
    internal(leadClientId, '/api/internal/telos/work/delegate', {
      clientId: leadClientId,
      sessionId: leadId,
      input,
    });
  const allocation = await delegate();
  expect(allocation.status).toBe(200);
  const receipt = await allocation.json();
  expect(receipt.execution).toBe('not_started');
  expect(receipt.attempt.state).toBe('chat_ready');
  const workerId = receipt.workerConversationId as string,
    taskId = receipt.attempt.executionTaskId as string;
  expect(await (await delegate()).json()).toEqual(receipt);
  expect(
    await Promise.all([delegate(), delegate()]).then(async (rs) =>
      Promise.all(rs.map((r) => r.json())),
    ),
  ).toEqual([receipt, receipt]);
  expect(application.taskStore.getTree()).toHaveLength(1);
  expect(nativeSessions).toHaveLength(2);
  expect(chat.eventStore.getOrdinaryInitialCommandId(workerId)).toBeUndefined();
  expect(new Set([advisorId, leadId, workerId]).size).toBe(3);
  const directories = [advisorId, leadId, workerId].map(
    (id) => chat.eventStore.getSession(id)!.cwd!,
  );
  expect(new Set(directories).size).toBe(3);
  for (const id of [advisorId, leadId, workerId]) {
    const session = chat.eventStore.getSession(id)!;
    expect(session.repositoryWorkspaceId).toBeTruthy();
    expect(session.ordinaryWorkspaceId).toBeUndefined();
    expect(
      session.cwd!.startsWith(join(f.configuredWorkspace, '.claude', 'repository-tasks') + '/'),
    ).toBe(true);
    const { getRepositoryWorkspaces } =
      await import('../../../../server/repository-workspace-runtime.js');
    expect(getRepositoryWorkspaces(true).get(session.repositoryWorkspaceId!)).toMatchObject({
      repository: 'example/acceptance',
      baseOid: repositoryEffects.baseOid,
      state: id === workerId ? 'reserved' : 'claimed',
      conversationId: id,
    });
    if (id === workerId) {
      // Silent setup reserves the exact future task path. Its physical copy is
      // claimed only by the first explicit command, not by reading this page.
      await expect(access(session.cwd!)).rejects.toThrow();
    } else {
      await access(join(session.cwd!, '.git'));
      expect(await readFile(join(session.cwd!, 'task.txt'), 'utf8')).toBe(
        'Accepted synthetic repository source.\n',
      );
    }
  }
  const { resolveTelosWorkRoleContext } =
    await import('../../../../server/telos-work-role-context.js');
  const workerContext = resolveTelosWorkRoleContext(
    chat.eventStore,
    workerId,
    chat.eventStore.getSession(workerId)!.accountBinding!,
  );
  expect(workerContext).toMatchObject({
    itemId: childId,
    role: 'worker',
    leadConversationId: leadId,
  });
  expect(workerContext!.sources).toEqual([originalSource]);
  expect(workerContext!.artifacts).toContainEqual(material);
  await page.goto(front.origin + '/chat/' + workerId);
  await browserExpect(page.getByRole('textbox', { name: 'Message Mitzo' })).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Message Mitzo' })
    .fill('Perform only the reviewed work and retain a report.');
  await browserExpect(
    page.getByRole('button', { name: 'Send message', exact: true }),
  ).toBeEnabled();
  const [workerSend] = await Promise.all([
    page.waitForRequest(
      (r) => r.method() === 'POST' && r.url().endsWith('/api/chat/local-codex/send'),
      { timeout: 10000 },
    ),
    page.getByRole('button', { name: 'Send message', exact: true }).click(),
  ]);
  const workerCommand = workerSend.postDataJSON();
  const workerResponse = await workerSend.response();
  expect(workerResponse).toBeTruthy();
  expect(await workerResponse!.json()).toMatchObject({ state: 'consumed', dispatched: true });
  await vi.waitFor(() => expect(nativeSessions).toHaveLength(3));
  const worker = chat.registry.findBySessionId(workerId)!;
  const workerNative = nativeSessions[2];
  const workerTurnStarts = () =>
    workerNative.rpc.request.mock.calls.filter(([method]) => method === 'turn/start').length;
  // The 202 receipt admits background startup; it does not acknowledge turn/start.
  // Observe the actual RPC inside the existing 120s case budget, without a second
  // implicit 1s deadline or another dispatch. Later checks still forbid replay.
  await workerNative.firstTurnStarted;
  expect(workerTurnStarts()).toBe(1);
  const { getRepositoryWorkspaces } =
    await import('../../../../server/repository-workspace-runtime.js');
  expect(getRepositoryWorkspaces(true).get(workerCommand.repositoryWorkspaceId)).toMatchObject({
    state: 'claimed',
    conversationId: workerId,
    baseOid: repositoryEffects.baseOid,
  });
  for (const directory of directories) {
    await access(join(directory, '.git'));
    expect(await readFile(join(directory, 'task.txt'), 'utf8')).toBe(
      'Accepted synthetic repository source.\n',
    );
  }
  expect(worker.session.taskContext?.currentTaskId).toBe(taskId);
  expect(nativeSessions).toHaveLength(3);
  const directory = chat.eventStore.getSession(workerId)!.cwd!;
  const inode = (await stat(directory)).ino;
  let report = 'Recorded the first session and retained its notes.';
  await writeFile(join(directory, 'recording-report.md'), report);
  const file = await request(application.app)
    .get('/api/files/read')
    .set('Authorization', 'Bearer ' + f.token)
    .query({ sessionId: workerId, path: 'recording-report.md' });
  expect(file.status).toBe(200);
  expect(file.body.content).toBe(report);
  const fileUrl =
    front.origin +
    '/files?' +
    new URLSearchParams({
      sessionId: workerId,
      path: join(directory, 'recording-report.md'),
      from: '/chat/' + workerId,
    });
  await page.goto(fileUrl);
  await browserExpect(page.getByText(report, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  report += '\n\nOperator checked the recording notes.';
  await page.getByRole('textbox', { name: 'Document source' }).fill(report);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await browserExpect(page.locator('.document-editor-status')).toContainText('All changes saved');
  expect(await readFile(join(directory, 'recording-report.md'), 'utf8')).toBe(report);
  if (process.env.S9_JOINED_SCREENSHOT_DIR)
    await page.screenshot({
      path: join(process.env.S9_JOINED_SCREENSHOT_DIR, 'worker-files-saved.png'),
      fullPage: true,
    });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await browserExpect(page).toHaveURL(new RegExp('/chat/' + workerId));
  await browserExpect(page.getByRole('textbox', { name: 'Message Mitzo' })).toBeVisible();
  workerNative.lifecycle.onNotification('item/agentMessage/delta', {
    threadId: workerNative.threadId,
    turnId: workerNative.turnId,
    itemId: 'report',
    delta: 'Saved recording-report.md for review.',
  });
  workerNative.lifecycle.onNotification('item/completed', {
    threadId: workerNative.threadId,
    turnId: workerNative.turnId,
    item: { type: 'agentMessage', id: 'report', text: 'Saved recording-report.md for review.' },
  });
  const outputResponse = await internal(worker.clientId, '/api/internal/telos/artifacts/save', {
    requestId: 'worker-output',
    itemId: childId,
    filename: 'recording-report.md',
    title: 'Reviewed recording report',
    path: 'recording-report.md',
  });
  expect(outputResponse.status).toBe(200);
  const output = (await outputResponse.json()).artifact;
  const retained = canonical.artifacts.read(output.id, output.revision);
  expect(retained.bytes.toString()).toBe(report);
  expect(retained.sha256).toBe(output.sha256);
  const nativeTool = async (name: string, args: Record<string, unknown>) => {
    const prepared = await prepareNativeProviderToolCall(workerNative, name, args);
    expect(
      prepared.contract,
      'Actual task MCP contract must be discovered through the registered provider bridge',
    ).toBeTruthy();
    expect(prepared.contract?.name).toBe(name);
    expect(prepared.request.tool).toBe('InvokeIntegrationTool');
    const before = streamMessages.length;
    const pending = workerNative.lifecycle.onRequest(
      'item/tool/call',
      prepared.request,
      new AbortController().signal,
    ) as Promise<{ success: boolean; contentItems: Array<{ text: string }> }>;
    await vi.waitFor(() =>
      expect(
        streamMessages
          .slice(before)
          .some(
            (message) => message.type === 'permission_request' && message.sessionId === workerId,
          ),
      ).toBe(true),
    );
    const permission = streamMessages
      .slice(before)
      .find((message) => message.type === 'permission_request' && message.sessionId === workerId)!;
    expect(permission.permId).toBeTruthy();
    await browserExpect(
      page.getByRole('button', { name: 'Allow Once', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Allow Once', exact: true }).click();
    return pending;
  };
  const artifactResult = await nativeTool('mcp__task-board__TaskArtifact', {
    key: 'report',
    value: `artifact:${output.id}@${output.revision}`,
  });
  expect(artifactResult.success).toBe(true);
  expect(artifactResult.contentItems.map((item) => item.text).join('')).not.toMatch(/Error:/);
  const completion = await nativeTool('mcp__task-board__TaskComplete', {
    summary: 'Saved report; awaiting explicit verification.',
  });
  expect(completion.success).toBe(true);
  expect(completion.contentItems.map((item) => item.text).join('')).toContain('pending_review');
  expect(application.taskStore.get(taskId)?.status).toBe('pending_review');
  expect(application.taskStore.get(taskId)?.artifacts?.report).toBe(
    `artifact:${output.id}@${output.revision}`,
  );
  const { TelosItemStore } = await import('../../../../server/telos-item-store.js');
  const items = new TelosItemStore(canonical.dbPath);
  cleanup.push(() => items.close());
  expect(items.read(childId).status).toBe('active');
  // Fake operator explicitly reads/verifies retained bytes before approving.
  expect(canonical.artifacts.read(output.id, output.revision).bytes.toString()).toBe(report);
  await page.goto(front.origin + '/tasks?highlight=' + taskId);
  await browserExpect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  if (process.env.S9_JOINED_SCREENSHOT_DIR)
    await page.screenshot({
      path: join(process.env.S9_JOINED_SCREENSHOT_DIR, 'task-pending-review.png'),
      fullPage: true,
    });
  const [approvalResponse] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' && r.url().endsWith('/api/tasks/' + taskId + '/approve'),
      { timeout: 10000 },
    ),
    page.getByRole('button', { name: 'Approve', exact: true }).click(),
  ]);
  expect(approvalResponse.status()).toBe(200);
  expect(application.taskStore.get(taskId)?.status).toBe('done');
  expect(items.read(childId).status).toBe('active');
  const verified = await internal(leadClientId, '/api/internal/telos/items/update', {
    itemId: childId,
    requestId: 'explicit-verified-completion',
    expectedRevision: items.read(childId).revision,
    status: 'completed',
    note: `Verified artifact:${output.id}@${output.revision} SHA-256 ${output.sha256}; approved task ${taskId}.`,
  });
  expect(verified.status).toBe(200);
  expect(items.read(childId).status).toBe('completed');
  expect(items.read('studio').status).toBe('active');
  for (const session of nativeSessions)
    session.lifecycle.onNotification('turn/completed', {
      threadId: session.threadId,
      turn: { id: session.turnId, status: 'completed' },
    });
  // Files and Tasks navigation already detached the real browser transport.
  // Reconnect through the actual page/SSE owner, not a synthetic replacement.
  const workerClientId = worker.clientId;
  const beforeReattachTurns = workerTurnStarts();
  await page.goto(front.origin + '/chat/' + workerId);
  await browserExpect(page.getByRole('textbox', { name: 'Message Mitzo' })).toBeVisible();
  await vi.waitFor(() => expect(chat.registry.isAttached(workerClientId)).toBe(true));
  expect(chat.registry.findBySessionId(workerId)?.clientId).toBe(workerClientId);
  expect(nativeSessions).toHaveLength(3);
  expect(workerTurnStarts()).toBe(beforeReattachTurns);
  const turnsBeforeReplay = workerTurnStarts();
  expect(turnsBeforeReplay).toBe(1);
  expect(
    await (
      await http('/api/chat/local-codex/send', {
        method: 'POST',
        body: JSON.stringify(workerCommand),
      })
    ).json(),
  ).toMatchObject({
    state: 'consumed',
    dispatched: false,
  });
  expect(nativeSessions).toHaveLength(3);
  expect(workerTurnStarts()).toBe(turnsBeforeReplay);
  for (const id of [advisorId, leadId, workerId])
    chat.stopOrdinaryChat(chat.registry.findBySessionId(id)!.clientId);
  await vi.waitFor(() => {
    expect(chat.registry.findBySessionId(workerId)).toBeNull();
    expect(chat.registry.findBySessionId(leadId)).toBeNull();
  });
  expect(f.legacyLookup).not.toHaveBeenCalled();
  const { RepositoryWorkspaces } = await import('../../../../server/repository-workspaces.js');
  const forbiddenReacquisition = async () => {
    throw Error('Reopening retained custody must acquire nothing');
  };
  const reopenedRepository = new RepositoryWorkspaces(join(f.privateRoot, 'repository-sources'), {
    authorize: forbiddenReacquisition,
    inspect: forbiddenReacquisition,
    prepare: forbiddenReacquisition,
    verify: forbiddenReacquisition,
  });
  try {
    expect(reopenedRepository.get(workerCommand.repositoryWorkspaceId)).toMatchObject({
      state: 'claimed',
      conversationId: workerId,
      baseOid: repositoryEffects.baseOid,
    });
    expect(chat.eventStore.getSession(workerId)?.repositoryWorkspaceId).toBe(
      workerCommand.repositoryWorkspaceId,
    );
  } finally {
    reopenedRepository.close();
  }
  expect((await stat(directory)).ino).toBe(inode);
  expect(await readFile(join(directory, 'recording-report.md'), 'utf8')).toBe(report);
  expect(application.taskStore.getTree()).toHaveLength(1);
  const { TaskStore } = await import('../../../../server/task-store.js');
  const reopenedTasks = new TaskStore(join(f.configuredWorkspace, '.mitzo', 'tasks.db'));
  try {
    expect(reopenedTasks.getTree()).toHaveLength(1);
    expect(reopenedTasks.get(taskId)?.status).toBe('done');
    expect(reopenedTasks.getTelosExecutionTaskForConversation(workerId)).toBe(taskId);
  } finally {
    reopenedTasks.close();
  }
  canonical.restartOwners();
  await assertOriginalSource();
  expect(
    resolveTelosWorkRoleContext(
      chat.eventStore,
      workerId,
      chat.eventStore.getSession(workerId)!.accountBinding!,
    ),
  ).toEqual(workerContext);
  expect(canonical.artifacts.read(output.id, output.revision).bytes.toString()).toBe(report);
  expect(items.read(childId).status).toBe('completed');
  expect(chat.eventStore.getOrdinaryInitialCommandId(f.first.receipt.sessionId)).toBeUndefined();
  expect(chat.eventStore.listSessions()).toHaveLength(before + 3);
  for (const dir of directories) await access(join(dir, '.git'));
  await expect(access(join(f.configuredWorkspace, '.git'))).rejects.toThrow();
  expect(
    repositoryEffects.externalCalls.some((call) => call.command === 'remote-source-copy'),
  ).toBe(true);
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(pageErrors).toEqual([]);
  expect(f.legacyLookup).not.toHaveBeenCalled();
  expect(getClientId).not.toHaveBeenCalled();
}, 120_000);
