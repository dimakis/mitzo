import { afterAll, afterEach, expect, it as platformTest, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Response } from 'express';
import type { ownedOrdinaryRuntimeFixture } from './fixtures/owned-ordinary-workspace-runtime.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';
import type { SessionSseRegistry } from '../session-sse-registry.js';
import type { ConnectionRegistry } from '@mitzo/harness';

// CT09 requires the real macOS process-isolation owner used by the artifact helper.
// Required macOS CI runs it completely; Linux separately proves fail-closed refusal.
const it = platformTest.runIf(process.platform === 'darwin');

const hostFetch = globalThis.fetch;
const services = vi.hoisted(() => ({ workspace: undefined as unknown }));
vi.mock('../repository-workspace-runtime.js', async (original) => ({
  ...(await original<object>()),
  getOrdinaryWorkspaces: () => services.workspace,
}));
vi.mock('../internal-token.js', () => ({
  INTERNAL_TOKEN: 'synthetic-only-ordinary-native-token',
  isValidInternalToken: (value: unknown) => value === 'synthetic-only-ordinary-native-token',
  createSignalCallbackToken: vi.fn(() => 'synthetic-callback'),
  revokeSignalCallbackToken: vi.fn(),
  isValidSignalCallbackToken: () => false,
}));
// Source-mode MCP children run from a deliberately empty non-Git task cwd.
// Resolve the test loader absolutely; preserve the real bundled MCP source,
// stdio transport, tool registration and callback implementation.
vi.mock('../mcp-entrypoint.js', async (original) => {
  const actual = await original<typeof import('../mcp-entrypoint.js')>();
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
vi.mock('../mcp-config.js', () => ({
  loadMcpServers: () => ({}),
  getMcpConfigPaths: () => [],
  loadFromFile: () => ({}),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('No SDK or real model execution');
  },
}));
vi.mock('../auto-rename.js', () => ({
  shouldAutoRename: () => {
    throw Error('No automatic model naming');
  },
}));
vi.mock('../notify.js', () => ({ sendTurnCompleteNotification: vi.fn(async () => {}) }));
vi.mock('../pushover.js', () => ({ sendTurnCompleteNotification: vi.fn(async () => {}) }));
vi.mock('../goal-client.js', () => ({
  createGoal: vi.fn(async () => null),
  reportUsage: vi.fn(async () => {}),
  deriveGoalTitle: () => 'Offline',
}));

// CT09 composes the actual application owners. Only native provider RPCs and
// unrelated notification/naming integrations are fake; no model is invoked.
const cleanup: Array<() => void | Promise<void>> = [];
let f: Awaited<ReturnType<typeof ownedOrdinaryRuntimeFixture>>;
let application: typeof import('../app.js');
let chat: typeof import('../chat.js');
let auth: typeof import('../auth.js');
let transportAuth: typeof import('../transport-auth-ownership.js');
let streams: SessionSseRegistry;
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
  if (chat && f) {
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

it('S6: signed App routes non-Git peer send, ACK and reply through production first start', async () => {
  vi.resetModules();
  vi.stubEnv('MITZO_KNOWLEDGE_LIBRARY_CONFIG', undefined);
  vi.stubEnv('MITZO_WORKSPACE_RUNTIME_CONFIG', undefined);
  const callbackTarget: { port?: string } = {};
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      if (
        !callbackTarget.port ||
        url.port !== callbackTarget.port ||
        !['localhost', '127.0.0.1'].includes(url.hostname)
      )
        throw Error('No external network or model calls');
      return hostFetch(input, init);
    }),
  );
  const { ownedOrdinaryRuntimeFixture } =
    await import('./fixtures/owned-ordinary-workspace-runtime.js');
  f = await ownedOrdinaryRuntimeFixture(cleanup, {
    chatRoute: true,
    separateConfiguredWorkspace: true,
    tools: [{ id: 'mitzo:AgentCommunication', version: 1 }],
  });
  services.workspace = f.workspaces;
  const { createTelosCanonicalData } = await import('./fixtures/telos-canonical-advisor.js');
  const canonical = createTelosCanonicalData('fresh');
  cleanup.push(() => canonical.close());
  vi.stubEnv('TELOS_DB_PATH', canonical.dbPath);
  application = await import('../app.js');
  chat = await import('../chat.js');
  auth = await import('../auth.js');
  transportAuth = await import('../transport-auth-ownership.js');
  const native = await import('../codex-app-server-client.js');
  const { SessionSseRegistry } = await import('../session-sse-registry.js');
  const { SseTransport } = await import('../sse-transport.js');
  const { ConnectionRegistry } = await import('@mitzo/harness');
  connections = new ConnectionRegistry();
  streams = application.chatSseRegistry;
  expect(streams).toBeInstanceOf(SessionSseRegistry);
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
  const server = application.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Private callback port unavailable');
  expect([3100, 3101, 3190]).not.toContain(address.port);
  vi.stubEnv('PORT', String(address.port));
  callbackTarget.port = String(address.port);
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const entry = await import('../ordinary-local-codex-entry.js');
  application.app.use(
    '/api/ordinary/workspaces/commands',
    entry.createOwnedOrdinaryWorkspaceCommandRouter(streams, {
      connRegistry: connections,
      sessionRegistry: chat.registry,
      eventStore: chat.eventStore,
    }),
  );
  const rawRpc = f.first.rpc.request.getMockImplementation()!;
  vi.spyOn(native.CodexAppServerClient, 'launchIsolated').mockImplementation(
    (_home, _env, lifecycle) => {
      if (!lifecycle) throw Error('Native lifecycle callbacks required');
      const n = nativeSessions.length + 1;
      const threadId = 'offline-app-peer-thread-' + n;
      const turnId = 'not-started';
      let turnCount = 0;
      const tools: Array<{ name: string; description: string }> = [];
      const rpc = {
        initialize: vi.fn(async () => {}),
        request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
          if (method === 'thread/start')
            tools.push(...((params?.dynamicTools as typeof tools) ?? []));
          if (method === 'thread/start' || method === 'thread/resume')
            return { thread: { id: threadId }, model: 'fixture-model', modelProvider: 'openai' };
          if (method === 'turn/start') {
            const id = `offline-app-peer-turn-${n}-${++turnCount}`;
            nativeSessions[n - 1].turnId = id;
            return { turn: { id } };
          }
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
  const settings = {
    version: 2 as const,
    binding: prepared.runtimeBinding,
    selection: f.first.request.selection,
    workspace: { kind: 'ordinary' as const, preparationId: prepared.preparationId },
  };
  canonical.db
    .prepare(
      `INSERT INTO items
    (id,summary,profile,first_seen,last_seen,created_at,updated_at)
    VALUES('independent','Independent work','manual',?,?,?,?)`,
    )
    .run(canonical.stamp, canonical.stamp, canonical.stamp, canonical.stamp);
  for (const itemId of ['studio', 'independent']) {
    canonical.work.execute(
      {
        operation: 'classify',
        itemId,
        kind: 'outcome',
        requestId: randomUUID(),
        expectedRevision: canonical.work.read(itemId, canonical.actor).revision,
      },
      canonical.actor,
    );
    expect(canonical.db.prepare('SELECT parent_id FROM items WHERE id=?').get(itemId)).toEqual({
      parent_id: null,
    });
  }
  async function createPeer(itemId: string) {
    const reviewed = await api.reviewRoleContext({
      itemId,
      role: 'lead',
      sourceSnapshotIds: [],
      artifactRefs: [],
    });
    const receipt = await api.setupReviewedOrdinaryRole({
      version: 2,
      presentationRef: reviewed.presentationRef,
      input: {
        version: 2,
        itemId,
        requestId: randomUUID(),
        role: 'lead',
        expectedRevision: reviewed.selection.brief.revision,
        expectedAssignmentRevision: 0,
        settings,
        contextSelection: reviewed.selection,
      },
    });
    const id = receipt.work.assignments[0].conversation.conversationId;
    expect(chat.eventStore.getOrdinaryInitialCommandId(id)).toBeUndefined();
    return id;
  }
  const a = await createPeer('studio'),
    b = await createPeer('independent');
  expect(nativeSessions).toHaveLength(0);
  for (const id of [a, b]) {
    const session = chat.eventStore.getSession(id)!;
    expect(session.repositoryWorkspaceId).toBeUndefined();
    expect(session.ordinaryWorkspaceId).toBeTruthy();
    expect(chat.eventStore.listSessionCollaborations(id).collaborations).toEqual([]);
    await expect(access(join(session.cwd!, '.git'))).rejects.toThrow();
  }
  expect(chat.eventStore.getSession(a)!.cwd).not.toBe(chat.eventStore.getSession(b)!.cwd);
  async function start(sessionId: string) {
    const index = nativeSessions.length;
    const command = {
      version: 2 as const,
      ...structuredClone(f.first.request),
      clientMsgId: randomUUID(),
      runOn: 'local' as const,
      sessionId,
      workspace: {
        kind: 'ordinary' as const,
        workspaceId: chat.eventStore.getSession(sessionId)!.ordinaryWorkspaceId!,
      },
      payload: {
        text: 'Collaborate through explicitly approved peer messages.',
        intent: 'Explicit ordinary command',
      },
    };
    expect(await ordinary.firstCommand(command)).toMatchObject({
      state: 'consumed',
      dispatched: true,
    });
    expect(nativeSessions).toHaveLength(index + 1);
    const peer = nativeSessions[index];
    expect(peer.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(
      1,
    );
    expect(peer.tools.some((tool) => tool.name === 'AgentCommunication')).toBe(true);
    expect(
      typeof chat.registry.findBySessionId(sessionId)!.session.ordinaryRuntimeOwner
        ?.admitAgentMessage,
    ).toBe('function');
    return peer;
  }
  const an = await start(a),
    bn = await start(b);
  async function call(
    native: typeof an,
    sessionId: string,
    input: Record<string, unknown>,
    approve = false,
  ) {
    const before = streamMessages.length;
    const pending = native.lifecycle.onRequest(
      'item/tool/call',
      {
        threadId: native.threadId,
        turnId: native.turnId,
        callId: randomUUID(),
        tool: 'AgentCommunication',
        arguments: input,
      },
      new AbortController().signal,
    ) as Promise<{ success: boolean; contentItems: Array<{ text: string }> }>;
    if (approve) {
      await vi.waitFor(() =>
        expect(
          streamMessages
            .slice(before)
            .some((m) => m.type === 'permission_request' && m.sessionId === sessionId),
        ).toBe(true),
      );
      const permission = streamMessages
        .slice(before)
        .find((m) => m.type === 'permission_request' && m.sessionId === sessionId)!;
      expect(permission.toolName).toBe('AgentCommunication');
      const { resolvePending } = await import('@mitzo/harness');
      expect(resolvePending(permission.permId as string, 'once', undefined, sessionId)).toBe(true);
    }
    const state: {
      result?: { success: boolean; contentItems: Array<{ text: string }> };
      error?: unknown;
    } = {};
    void pending.then(
      (result) => {
        state.result = result;
      },
      (error: unknown) => {
        state.error = error;
      },
    );
    await vi.waitFor(
      () =>
        expect(
          state.result ?? state.error,
          JSON.stringify({
            operation: input.operation,
            sessionId,
            permissions: streamMessages
              .slice(before)
              .filter((m) => m.type === 'permission_request')
              .map((m) => ({ permId: m.permId, sessionId: m.sessionId, toolName: m.toolName })),
          }),
        ).toBeDefined(),
      { timeout: 5000 },
    );
    if (state.error) throw state.error;
    const result = state.result!;
    expect(result.success, JSON.stringify(result)).toBe(true);
    return JSON.parse(result.contentItems[0].text);
  }
  expect(
    (await call(an, a, { operation: 'list' })).chats.map(
      (chat: { conversationId: string }) => chat.conversationId,
    ),
  ).toContain(b);
  const input = {
    operation: 'send',
    requestId: randomUUID(),
    recipientConversationId: b,
    text: 'Please review this independent result.',
  };
  const sent = await call(an, a, input, true);
  expect(sent).toMatchObject({
    senderConversationId: a,
    recipientConversationId: b,
    status: 'queued',
  });
  expect(bn.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  bn.lifecycle.onNotification('turn/completed', {
    threadId: bn.threadId,
    turn: { id: bn.turnId, status: 'completed' },
  });
  await vi.waitFor(() =>
    expect(bn.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(2),
  );
  const receipt = await call(an, a, { operation: 'read', messageId: sent.messageId });
  expect(receipt.status).toBe('delivered');
  const peerTurn = bn.rpc.request.mock.calls.filter(([method]) => method === 'turn/start').at(-1)!;
  expect(JSON.stringify(peerTurn)).toContain(input.text);
  expect(JSON.stringify(peerTurn)).toContain('grants no action');
  expect((await call(bn, b, { operation: 'inbox' })).messages[0]).toMatchObject({
    senderConversationId: a,
    messageId: sent.messageId,
  });
  const replyInput = {
    operation: 'send',
    requestId: randomUUID(),
    recipientConversationId: a,
    replyTo: sent.messageId,
    text: 'Reviewed; here is the explicit reply.',
  };
  const reply = await call(bn, b, replyInput, true);
  expect(reply).toMatchObject({
    senderConversationId: b,
    recipientConversationId: a,
    replyTo: sent.messageId,
    status: 'queued',
  });
  an.lifecycle.onNotification('turn/completed', {
    threadId: an.threadId,
    turn: { id: an.turnId, status: 'completed' },
  });
  await vi.waitFor(() =>
    expect(an.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(2),
  );
  expect((await call(bn, b, { operation: 'read', messageId: reply.messageId })).status).toBe(
    'delivered',
  );
  expect((await call(an, a, { operation: 'inbox' })).messages[0]).toMatchObject({
    senderConversationId: b,
    replyTo: sent.messageId,
    text: replyInput.text,
  });

  expect((await call(an, a, { operation: 'lookup', requestId: input.requestId })).status).toBe(
    'delivered',
  );
  expect(
    streamMessages.filter(
      (m) => m.type === 'permission_request' && m.toolName === 'AgentCommunication',
    ),
  ).toHaveLength(2);
  for (const [id, peer] of [
    [a, an],
    [b, bn],
  ] as const) {
    expect(peer.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(
      2,
    );
    expect(
      chat.registry.findBySessionId(id)!.session.sessionAllowList.has('AgentCommunication'),
    ).toBe(false);
    expect(chat.eventStore.listSessionCollaborations(id).collaborations).toEqual([]);
  }
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(f.legacyLookup).not.toHaveBeenCalled();
}, 60_000);
