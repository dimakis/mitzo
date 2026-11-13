import { afterAll, afterEach, expect, it as platformTest, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Response } from 'express';
import type { ownedOrdinaryRuntimeFixture } from './fixtures/owned-ordinary-workspace-runtime.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';
import type { SessionSseRegistry } from '../session-sse-registry.js';
import type { ConnectionRegistry } from '@mitzo/harness';
import { prepareNativeProviderToolCall } from './fixtures/native-provider-tool-call.js';
import { reviewArtifactThenCompleteMilestoneAndOutcome } from './fixtures/canonical-review-completion.js';

// CT12 uses the qualified macOS native runtime owner.
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

// CT12 composes the actual application owners. Only native provider RPCs and
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

it('CT12: signed V2 coordinator and feature handovers preserve scoped acknowledgements across restart', async () => {
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
    // Canonical progress tools require an explicit published selection. Keep
    // the same reviewed selection through lead handover and worker allocation.
    tools: [
      'TelosWorkControl',
      'TelosStartSlice',
      'TelosGetItem',
      'TelosUpdateItem',
      'TaskArtifact',
      'TaskComplete',
    ].map((name) => ({ id: `mitzo:${name}`, version: 1 })),
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
    return new Response(
      Buffer.isBuffer(response.body)
        ? new Uint8Array(response.body)
        : JSON.stringify(response.body),
      {
        status: response.status,
        headers: { 'Content-Type': response.headers['content-type'] ?? 'application/json' },
      },
    );
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
  chat.eventStore.upsertSession({
    ...canonical.events.getSession('planning')!,
    accountBinding: f.binding,
  });
  const classify = (itemId: string, kind: 'coordinator' | 'outcome' | 'work_item') =>
    canonical.work.execute(
      {
        operation: 'classify',
        itemId,
        kind,
        requestId: randomUUID(),
        expectedRevision: canonical.work.read(itemId, canonical.actor).revision,
      },
      canonical.actor,
    );
  classify('studio', 'coordinator');
  for (const id of ['priority', 'target', 'unrelated']) {
    canonical.db
      .prepare(
        `INSERT INTO items
      (id,summary,profile,parent_id,first_seen,last_seen,created_at,updated_at)
      VALUES(?,?,'manual',?,?,?,?,?)`,
      )
      .run(
        id,
        id,
        id === 'unrelated' ? null : 'studio',
        canonical.stamp,
        canonical.stamp,
        canonical.stamp,
        canonical.stamp,
      );
    classify(id, 'outcome');
  }
  const plans = new Map(
    ['priority', 'target'].map((id) => {
      const artifact = canonical.artifacts.save({
        itemId: id,
        filename: `${id}-plan.md`,
        title: `${id} reviewed plan`,
        bytes: Buffer.from(`Deliver only the ${id} feature's reviewed result.`),
        sessionId: 'planning',
      });
      canonical.db
        .prepare(
          `INSERT INTO items
      (id,summary,profile,parent_id,first_seen,last_seen,created_at,updated_at)
      VALUES(?,?,'manual',?,?,?,?,?)`,
        )
        .run(
          `${id}-slice`,
          `${id} delivery slice`,
          id,
          canonical.stamp,
          canonical.stamp,
          canonical.stamp,
          canonical.stamp,
        );
      classify(`${id}-slice`, 'work_item');
      return [
        id,
        { artifactId: artifact.id, revision: artifact.revision, sha256: artifact.sha256 },
      ] as const;
    }),
  );
  const role = async (itemId: string, expectedAssignmentRevision: number | null) => {
    const previous = await api.read(itemId);
    const reviewed = await api.reviewRoleContext({
      itemId,
      role: 'lead',
      sourceSnapshotIds: [],
      artifactRefs: plans.has(itemId) ? [plans.get(itemId)!] : [],
    });
    const body = {
      version: 2 as const,
      presentationRef: reviewed.presentationRef,
      input: {
        version: 2 as const,
        requestId: randomUUID(),
        itemId,
        role: 'lead' as const,
        expectedRevision: reviewed.selection.brief.revision,
        expectedAssignmentRevision,
        settings,
        contextSelection: reviewed.selection,
      },
    };
    const receipt = await api.setupReviewedOrdinaryRole(body);
    const link = receipt.work.links.find(
      (link) =>
        !previous.links.some(
          (old) => old.conversation.conversationId === link.conversation.conversationId,
        ),
    )!;
    expect(link).toBeDefined();
    const id = link.conversation.conversationId;
    const before = chat.eventStore.listSessions().length;
    expect(await api.setupReviewedOrdinaryRole(body)).toEqual(receipt);
    expect(chat.eventStore.listSessions()).toHaveLength(before);
    expect(chat.eventStore.getOrdinaryInitialCommandId(id)).toBeUndefined();
    return { body, receipt, id };
  };
  const command = (sessionId: string) => ({
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
      text: 'Coordinate only the reviewed attached work.',
      intent: 'Explicit coordinator command',
    },
  });
  const start = async (sessionId: string, expectedTool = 'TelosWorkControl') => {
    const before = nativeSessions.length;
    expect(await ordinary.firstCommand(command(sessionId))).toMatchObject({
      state: 'consumed',
      dispatched: true,
    });
    expect(nativeSessions).toHaveLength(before + 1);
    const current = nativeSessions.at(-1)!;
    expect(
      current.rpc.request.mock.calls.filter(([method]) => method === 'turn/start'),
    ).toHaveLength(1);
    expect(current.tools.some((tool) => tool.name === expectedTool)).toBe(true);
    return current;
  };
  const invokeNative = async (
    native: (typeof nativeSessions)[number],
    sessionId: string,
    name: string,
    input: Record<string, unknown>,
  ) => {
    const prepared = await prepareNativeProviderToolCall(native, name, input);
    const before = streamMessages.length;
    const pending = native.lifecycle.onRequest(
      'item/tool/call',
      prepared.request,
      new AbortController().signal,
    ) as Promise<{ success: boolean; contentItems: Array<{ type: string; text: string }> }>;
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
    const { resolvePending } = await import('@mitzo/harness');
    expect(resolvePending(permission.permId as string, 'once', undefined, sessionId)).toBe(true);
    return {
      conversationId: sessionId,
      threadId: native.threadId,
      turnId: native.turnId,
      callId: prepared.request.callId,
      result: await pending,
    };
  };
  const nativeTool = async (
    native: (typeof nativeSessions)[number],
    sessionId: string,
    command: object,
  ) => (await invokeNative(native, sessionId, 'TelosWorkControl', { command })).result;
  const first = await role('studio', 0);
  const target = await role('target', 0);
  const priority = await role('priority', 0);
  expect(nativeSessions).toHaveLength(0);
  expect(first.receipt.work.assignments[0]).toMatchObject({ role: 'lead', revision: 1 });
  const { resolveTelosWorkRoleContext } = await import('../telos-work-role-context.js');
  const firstSession = chat.eventStore.getSession(first.id)!;
  expect(
    resolveTelosWorkRoleContext(chat.eventStore, first.id, firstSession.accountBinding!),
  ).toMatchObject({ itemKind: 'coordinator', role: 'lead' });
  const firstNative = await start(first.id);
  const additional = await role('studio', null);
  expect(additional.receipt.work.assignments).toEqual(first.receipt.work.assignments);
  const additionalNative = await start(additional.id);
  const targetNative = await start(target.id);
  const priorityNative = await start(priority.id);
  const { TaskOrchestrator } = await import('../task-orchestrator.js');
  application.setOrchestrator(
    new TaskOrchestrator({
      store: application.taskStore,
      getClientId: () => {
        throw Error('Legacy scheduler must not select a worker');
      },
      setTaskContext: () => {
        throw Error('Legacy scheduler must not supply task authority');
      },
      clearTaskContext: vi.fn(),
      broadcastStatus: vi.fn(),
      broadcastTasks: vi.fn(),
    }),
  );
  const { adoptReviewedSource } = await import('./fixtures/reviewed-source-adoption.js');
  const deliveries = [];
  for (const [featureId, lead, leadNative] of [
    ['priority', priority, priorityNative],
    ['target', target, targetNative],
  ] as const) {
    const source = await adoptReviewedSource({
      api,
      events: chat.eventStore,
      registry: chat.registry,
      app: application.app,
      operatorId: f.auth.id,
      assertOperatorCurrent() {
        if (!auth.isAuthSessionCurrent(f.auth)) throw Error('Planning operator retired');
      },
      itemId: `${featureId}-slice`,
      sourceSessionId: 'planning',
      messageId: `${featureId}-discussion`,
      text: `Retain the reviewed ${featureId} plan for only its dedicated worker.`,
      artifacts: [plans.get(featureId)!],
    });
    const input = {
      requestId: randomUUID(),
      childItemId: `${featureId}-slice`,
      mode: 'start',
      predecessorAttemptId: null,
      sourceSnapshotIds: [source.featureSource.sourceSnapshotId],
      artifactRefs: [plans.get(featureId)!],
    };
    const allocated = await invokeNative(leadNative, lead.id, 'TelosStartSlice', input);
    expect(allocated.result.success, JSON.stringify(allocated.result)).toBe(true);
    const receipt = JSON.parse(allocated.result.contentItems.map((part) => part.text).join(''));
    expect(receipt).toMatchObject({
      execution: 'not_started',
      attempt: { state: 'chat_ready', childItemId: input.childItemId, leadConversationId: lead.id },
    });
    const workerId: string = receipt.workerConversationId;
    const taskId: string = receipt.attempt.executionTaskId;
    expect(chat.eventStore.getOrdinaryInitialCommandId(workerId)).toBeUndefined();
    const before = nativeSessions.length;
    const replay = await invokeNative(leadNative, lead.id, 'TelosStartSlice', input);
    expect(JSON.parse(replay.result.contentItems.map((part) => part.text).join(''))).toEqual(
      receipt,
    );
    expect(nativeSessions).toHaveLength(before);
    const workerNative = await start(workerId, 'InvokeIntegrationTool');
    const workerContext = resolveTelosWorkRoleContext(
      chat.eventStore,
      workerId,
      chat.eventStore.getSession(workerId)!.accountBinding!,
    );
    const reviewedSource = await api.readSource(
      input.childItemId,
      source.featureSource.sourceSnapshotId,
    );
    expect(workerContext).toMatchObject({
      role: 'worker',
      itemId: input.childItemId,
      leadConversationId: lead.id,
      artifacts: [plans.get(featureId)!],
      sources: [reviewedSource.snapshot],
    });
    expect(reviewedSource.packet).toEqual(source.sourcePreview.preview.packet);
    const executionBinding = application.taskStore.getTelosExecutionBinding(taskId);
    expect(executionBinding).toMatchObject({
      childItemId: input.childItemId,
      leadConversationId: lead.id,
      workerConversationId: workerId,
      attemptId: receipt.attempt.attemptId,
    });
    deliveries.push({
      featureId,
      lead,
      leadNative,
      workerId,
      workerNative,
      taskId,
      input,
      receipt,
      source,
      reviewedSource,
      workerContext,
      executionBinding,
    });
  }
  // Both separately admitted workers remain in flight when coordination changes.
  // A dispatch hold does not turn already-running work into a completed result.
  expect(new Set(deliveries.map((delivery) => delivery.workerId)).size).toBe(2);
  expect(new Set(deliveries.map((delivery) => delivery.taskId)).size).toBe(2);
  expect(
    new Set([priority.id, target.id, ...deliveries.map((delivery) => delivery.workerId)]).size,
  ).toBe(4);
  expect(
    new Set(
      [priority.id, target.id, ...deliveries.map((delivery) => delivery.workerId)].map(
        (id) => chat.eventStore.getSession(id)!.cwd,
      ),
    ).size,
  ).toBe(4);
  for (const delivery of deliveries) {
    expect(application.taskStore.get(delivery.taskId)?.status).not.toBe('pending_review');
    expect(application.taskStore.get(delivery.taskId)?.status).not.toBe('done');
  }
  const hold = {
    operation: 'request',
    requestId: randomUUID(),
    coordinatorItemId: 'studio',
    priorityItemId: 'priority',
    targetItemIds: ['target'],
    scope: 'new_worker_dispatch',
  };
  const denied = await nativeTool(additionalNative, additional.id, hold);
  expect(denied.success).toBe(false);
  expect((await api.read('studio')).assignments).toEqual(first.receipt.work.assignments);
  const created = await nativeTool(firstNative, first.id, hold);
  expect(created.success, JSON.stringify(created)).toBe(true);
  const control = JSON.parse(created.contentItems[0].text);
  expect(control).toMatchObject({
    coordinatorConversationId: first.id,
    stage: 'requested',
    targets: [{ itemId: 'target', leadConversationId: target.id, stage: 'requested' }],
  });
  expect(() => canonical.work.assertControlAction('target', 'new_worker_dispatch')).toThrow(
    /hold/i,
  );
  expect(() =>
    canonical.work.assertControlAction('unrelated', 'new_worker_dispatch'),
  ).not.toThrow();

  const acknowledge = {
    operation: 'acknowledge',
    requestId: randomUUID(),
    controlId: control.controlId,
    itemId: 'target',
    assignmentRevision: 1,
  };
  const acknowledged = await nativeTool(targetNative, target.id, acknowledge);
  expect(acknowledged.success, JSON.stringify(acknowledged)).toBe(true);
  expect(JSON.parse(acknowledged.contentItems[0].text)).toMatchObject({
    stage: 'acknowledged',
    targets: [{ itemId: 'target', leadConversationId: target.id, stage: 'acknowledged' }],
  });
  // A reviewed replacement gets its own chat. The original acknowledgement
  // remains history, but cannot stand in for the new lead's receipt or application.
  const targetReplacement = await role('target', 1);
  expect(targetReplacement.id).not.toBe(target.id);
  const targetReplacementNative = await start(targetReplacement.id);
  canonical.restartOwners();
  expect(await api.setupReviewedOrdinaryRole(target.body)).toEqual(target.receipt);
  expect((await api.read('target')).assignments).toEqual(
    targetReplacement.receipt.work.assignments,
  );
  const readControl = async () => {
    const view = await api.control({ operation: 'read', controlId: control.controlId });
    if (Array.isArray(view)) throw Error('Expected one selected control');
    return view;
  };
  const reassigned = await readControl();
  expect(reassigned).toMatchObject({
    stage: 'requested',
    targets: [
      {
        itemId: 'target',
        leadConversationId: targetReplacement.id,
        assignmentRevision: 2,
        stage: 'requested',
      },
    ],
  });
  expect(reassigned.history).toContainEqual(
    expect.objectContaining({
      conversationId: target.id,
      assignmentRevision: 1,
      stage: 'acknowledged',
    }),
  );
  expect((await nativeTool(targetNative, target.id, acknowledge)).success).toBe(false);
  expect(
    (
      await nativeTool(targetReplacementNative, targetReplacement.id, {
        ...acknowledge,
        requestId: randomUUID(),
      })
    ).success,
  ).toBe(false);
  const currentAcknowledgement = {
    ...acknowledge,
    requestId: randomUUID(),
    assignmentRevision: 2,
  };
  const currentReceipt = await nativeTool(
    targetReplacementNative,
    targetReplacement.id,
    currentAcknowledgement,
  );
  expect(currentReceipt.success, JSON.stringify(currentReceipt)).toBe(true);
  const acknowledgedCurrent = await readControl();
  expect(acknowledgedCurrent.stage).toBe('acknowledged');
  expect(acknowledgedCurrent.history).toHaveLength(2);
  expect(acknowledgedCurrent.history.every((entry) => entry.stage === 'acknowledged')).toBe(true);
  canonical.restartOwners();
  expect(
    (await nativeTool(targetReplacementNative, targetReplacement.id, currentAcknowledgement))
      .success,
  ).toBe(true);
  expect(await readControl()).toEqual(acknowledgedCurrent);

  const replacement = await role('studio', 1);
  expect(replacement.receipt.work.assignments[0]).toMatchObject({
    role: 'lead',
    revision: 2,
    conversation: { conversationId: replacement.id },
  });
  const replacementNative = await start(replacement.id);
  canonical.restartOwners();
  expect(await api.setupReviewedOrdinaryRole(first.body)).toEqual(first.receipt);
  expect((await api.read('studio')).assignments).toEqual(replacement.receipt.work.assignments);
  expect(
    (await nativeTool(firstNative, first.id, { ...hold, requestId: randomUUID() })).success,
  ).toBe(false);
  const release = { operation: 'release', requestId: randomUUID(), controlId: control.controlId };
  expect((await nativeTool(firstNative, first.id, release)).success).toBe(false);
  expect(
    (await nativeTool(additionalNative, additional.id, { ...release, requestId: randomUUID() }))
      .success,
  ).toBe(false);
  const released = await nativeTool(replacementNative, replacement.id, {
    ...release,
    requestId: randomUUID(),
  });
  expect(released.success, JSON.stringify(released)).toBe(true);
  expect(JSON.parse(released.contentItems[0].text).stage).toBe('released');
  expect(() => canonical.work.assertControlAction('target', 'new_worker_dispatch')).not.toThrow();
  const reports = [];
  for (const delivery of deliveries) {
    const { workerId, workerNative, taskId, featureId } = delivery;
    const report = `Reviewed result from only the ${featureId} worker.`;
    const worker = chat.registry.findBySessionId(workerId)!;
    await writeFile(join(chat.eventStore.getSession(workerId)!.cwd!, 'report.md'), report);
    const saved = await http('/api/internal/telos/artifacts/save', {
      method: 'POST',
      headers: {
        'x-internal-token': 'synthetic-only-ordinary-native-token',
        'x-client-id': worker.clientId,
      },
      body: JSON.stringify({
        requestId: `${featureId}-worker-output`,
        itemId: delivery.input.childItemId,
        filename: 'report.md',
        title: `${featureId} retained result`,
        path: 'report.md',
      }),
    });
    const artifact = (await saved.json()).artifact;
    expect(canonical.artifacts.read(artifact.id, artifact.revision).bytes.toString()).toBe(report);
    const referenced = await invokeNative(workerNative, workerId, 'mcp__task-board__TaskArtifact', {
      key: 'report',
      value: `artifact:${artifact.id}@${artifact.revision}`,
    });
    expect(referenced.result.success, JSON.stringify(referenced.result)).toBe(true);
    const completed = await invokeNative(workerNative, workerId, 'mcp__task-board__TaskComplete', {
      summary: `${featureId} result retained; awaiting explicit review.`,
    });
    expect(completed.result.success, JSON.stringify(completed.result)).toBe(true);
    expect(application.taskStore.get(taskId)?.status).toBe('pending_review');
    expect((await api.readRecord(featureId)).status).toBe('active');
    reports.push({ delivery, artifact, bytes: Buffer.from(report) });
  }
  expect(new Set(reports.map(({ artifact }) => artifact.id)).size).toBe(2);
  const evidence: Array<{ stage: string; facts: Record<string, unknown> }> = [];
  for (const [index, { delivery, artifact, bytes }] of reports.entries()) {
    const currentLead = delivery.featureId === 'target' ? targetReplacement : priority;
    const currentNative =
      delivery.featureId === 'target' ? targetReplacementNative : priorityNative;
    await reviewArtifactThenCompleteMilestoneAndOutcome(
      {
        http,
        native: (name, input) =>
          invokeNative(currentNative, currentLead.id, name, input as Record<string, unknown>),
        reload: async () => {
          canonical.restartOwners();
        },
        recoveryKind: 'canonical-fixture-owner-reopen',
        record: async (stage, facts) => {
          evidence.push({ stage, facts });
        },
      },
      {
        leadConversationId: currentLead.id,
        taskId: delivery.taskId,
        milestoneId: delivery.input.childItemId,
        outcomeId: delivery.featureId,
        artifact: { ...artifact, bytes },
        criteriaEvidence: `Verified the separate ${delivery.featureId} worker result through the retained byte reader`,
      },
    );
    expect((await api.readRecord('studio')).status).toBe('active');
    if (index === 0) {
      expect((await api.readRecord('priority')).status).toBe('completed');
      expect((await api.readRecord('target')).status).toBe('active');
      expect(application.taskStore.get(deliveries[1].taskId)?.status).toBe('pending_review');
    }
  }
  const coordinatorRead = await invokeNative(replacementNative, replacement.id, 'TelosGetItem', {
    itemId: 'studio',
  });
  expect(coordinatorRead.result.success, JSON.stringify(coordinatorRead.result)).toBe(true);
  const coordinatorRecord = JSON.parse(
    coordinatorRead.result.contentItems.map((part) => part.text).join(''),
  ).item;
  expect(coordinatorRecord.children).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'priority', status: 'completed' }),
      expect.objectContaining({ id: 'target', status: 'completed' }),
    ]),
  );
  const finish = {
    itemId: 'studio',
    requestId: randomUUID(),
    expectedRevision: coordinatorRecord.revision,
    status: 'completed',
    note: 'Verified both separately reviewed feature deliveries and retained coordination/handover evidence. This offline fixture does not represent publication or deployment.',
  };
  const finished = await invokeNative(replacementNative, replacement.id, 'TelosUpdateItem', finish);
  expect(finished.result.success, JSON.stringify(finished.result)).toBe(true);
  canonical.restartOwners();
  const finishReplay = await invokeNative(
    replacementNative,
    replacement.id,
    'TelosUpdateItem',
    finish,
  );
  expect(finishReplay.result).toEqual(finished.result);
  expect((await api.readRecord('studio')).status).toBe('completed');
  expect(
    evidence.filter(
      (entry) =>
        entry.stage === 'explicit-operator-retained-artifact-byte-read-before-task-approval',
    ),
  ).toHaveLength(2);
  for (const { delivery, artifact, bytes } of reports) {
    expect(canonical.artifacts.read(artifact.id, artifact.revision).bytes).toEqual(bytes);
    const work = await api.read(delivery.input.childItemId);
    expect(work.attempts).toHaveLength(1);
    expect(work.attempts[0]).toMatchObject(delivery.receipt.attempt);
    expect(
      resolveTelosWorkRoleContext(
        chat.eventStore,
        delivery.workerId,
        chat.eventStore.getSession(delivery.workerId)!.accountBinding!,
      ),
    ).toEqual(delivery.workerContext);
    expect(application.taskStore.getTelosExecutionBinding(delivery.taskId)).toEqual(
      delivery.executionBinding,
    );
    expect(
      await api.readSource(
        delivery.input.childItemId,
        delivery.source.featureSource.sourceSnapshotId,
      ),
    ).toEqual(delivery.reviewedSource);
    expect(
      await api.approveSourcePermission(
        delivery.source.sourcePermissionId,
        delivery.source.sourceApprovalInput,
      ),
    ).toEqual(delivery.source.featureSource);
    expect(application.taskStore.get(delivery.taskId)?.status).toBe('done');
    expect(
      delivery.workerNative.rpc.request.mock.calls.filter(([method]) => method === 'turn/start'),
    ).toHaveLength(1);
  }
  expect((await readControl()).stage).toBe('released');
  expect(chat.eventStore.getSession(first.id)).toMatchObject({
    sessionId: firstSession.sessionId,
    accountBinding: firstSession.accountBinding,
    agentProfile: firstSession.agentProfile,
    ordinaryWorkspaceId: firstSession.ordinaryWorkspaceId,
    cwd: firstSession.cwd,
  });
  expect(
    resolveTelosWorkRoleContext(chat.eventStore, first.id, firstSession.accountBinding!),
  ).toEqual(first.body.input.contextSelection);
  for (const id of [first.id, additional.id, replacement.id, target.id, targetReplacement.id]) {
    const session = chat.eventStore.getSession(id)!;
    expect(session.repositoryWorkspaceId).toBeUndefined();
    expect(session.ordinaryWorkspaceId).toBeTruthy();
    await expect(access(join(session.cwd!, '.git'))).rejects.toThrow();
  }
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(f.legacyLookup).not.toHaveBeenCalled();
}, 120_000);
