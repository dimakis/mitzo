import { afterAll, afterEach, expect, it as platformTest, vi } from 'vitest';
import request from 'supertest';
import { randomUUID, createHash } from 'node:crypto';
import { access, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Response } from 'express';
import type { ownedOrdinaryRuntimeFixture } from './fixtures/owned-ordinary-workspace-runtime.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';
import type { SessionSseRegistry } from '../session-sse-registry.js';
import type { ConnectionRegistry } from '@mitzo/harness';

// CT09 requires the real macOS process-isolation owner used by the artifact helper.
// Required macOS CI runs it completely; Linux separately proves fail-closed refusal.
const it = platformTest.runIf(process.platform === 'darwin');

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

it('CT09: actual canonical non-Git advisor-to-worker journey retains file bytes, review and verified completion', async () => {
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
    await import('./fixtures/owned-ordinary-workspace-runtime.js');
  f = await ownedOrdinaryRuntimeFixture(cleanup, {
    chatRoute: true,
    separateConfiguredWorkspace: true,
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
  const role = async (kind: 'advisor' | 'lead') => {
    const reviewed = await api.reviewRoleContext({
      itemId: 'studio',
      role: kind,
      ...(kind === 'advisor' ? { advisorPurpose: 'child' as const } : {}),
      sourceSnapshotIds: [],
      artifactRefs: [material],
    });
    const input = {
      version: 2 as const,
      requestId: randomUUID(),
      itemId: 'studio',
      role: kind,
      expectedRevision: reviewed.selection.brief.revision,
      expectedAssignmentRevision: kind === 'lead' ? 0 : null,
      settings,
      contextSelection: reviewed.selection,
    };
    const body = { version: 2 as const, input, presentationRef: reviewed.presentationRef };
    const receipt = await api.setupReviewedOrdinaryRole(body);
    expect(await api.setupReviewedOrdinaryRole(body)).toEqual(receipt);
    return receipt.work.links.find((link) => link.role === kind)!.conversation.conversationId;
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
      text: 'Perform only the reviewed work and retain a report.',
      intent: 'Explicit reviewed command',
    },
  });
  const before = chat.eventStore.listSessions().length;
  const advisorId = await role('advisor');
  expect(chat.eventStore.listSessions()).toHaveLength(before + 1);
  expect(nativeSessions).toHaveLength(0);
  const sequence = chat.eventStore.append(advisorId, 'user_message', {
    messageId: 'reviewed',
    text: 'Retain this reviewed acoustic plan; execution is a separate decision.',
  });
  const revision = (await api.read('studio')).revision;
  const draft = {
    requestId: randomUUID(),
    operation: 'child' as const,
    itemId: 'studio',
    advisorConversationId: advisorId,
    expectedRevision: revision,
    parentId: 'studio',
    expectedParentRevision: revision,
    proposed: {
      name: 'Reviewed recording plan',
      desiredOutcome: 'Record clearly',
      type: 'work_item' as const,
      category: 'Music',
    },
    selection: {
      requestId: randomUUID(),
      expectedMembershipRevision: 0,
      sourceConversationId: advisorId,
      mode: 'selected' as const,
      boundary: { sequence, messageId: 'reviewed' },
      messageIds: ['reviewed'],
      artifacts: [material],
      purpose: 'Retain reviewed plan',
      joiningBrief: '',
    },
  };
  const preview = await api.previewAdvisorDraft(draft);
  const saved = await api.saveAdvisorDraft({ ...draft, previewSha256: preview.sha256 });
  expect(await api.saveAdvisorDraft({ ...draft, previewSha256: preview.sha256 })).toEqual(saved);
  const childId = saved.work.itemId;
  expect(saved.work.sources).toHaveLength(1);
  const originalSource = saved.work.sources[0];
  expect(originalSource).toMatchObject({
    itemId: childId,
    source: { namespace: 'mitzo', conversationId: advisorId },
    selection: {
      kind: 'selected',
      messageIds: ['reviewed'],
      blockIds: [],
      throughSequence: sequence,
    },
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
    expect(retainedSource.packet.context.messages).toHaveLength(1);
    expect(retainedSource.packet.context.messages[0]).toMatchObject({
      conversationId: advisorId,
      messageId: 'reviewed',
      sequence,
      author: 'operator',
      blocks: [
        { content: 'Retain this reviewed acoustic plan; execution is a separate decision.' },
      ],
    });
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
  const leadId = await role('lead');
  const leadCommand = command(leadId);
  expect(await ordinary.firstCommand(leadCommand)).toMatchObject({
    state: 'consumed',
    dispatched: true,
  });
  const leadClientId = chat.registry.findBySessionId(leadId)!.clientId;
  const { TaskOrchestrator } = await import('../task-orchestrator.js');
  const getClientId = vi.fn(() => {
    throw Error('Legacy scheduler must not select a worker');
  });
  const orchestrator = new TaskOrchestrator({
    store: application.taskStore,
    getClientId,
    setTaskContext: vi.fn(),
    clearTaskContext: vi.fn(),
    broadcastStatus: vi.fn(),
    broadcastTasks: vi.fn(),
  });
  application.setOrchestrator(orchestrator);
  const input = {
    requestId: randomUUID(),
    childItemId: childId,
    mode: 'start',
    predecessorAttemptId: null,
    sourceSnapshotIds: saved.work.sources.map((s) => s.snapshotId),
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
  expect(nativeSessions).toHaveLength(1);
  expect(chat.eventStore.getOrdinaryInitialCommandId(workerId)).toBeUndefined();
  expect(new Set([advisorId, leadId, workerId]).size).toBe(3);
  const directories = [advisorId, leadId, workerId].map(
    (id) => chat.eventStore.getSession(id)!.cwd!,
  );
  expect(new Set(directories).size).toBe(3);
  for (const id of [advisorId, leadId, workerId]) {
    const session = chat.eventStore.getSession(id)!;
    expect(session.repositoryWorkspaceId).toBeUndefined();
    expect(session.ordinaryWorkspaceId).toBeTruthy();
    expect(session.cwd!.startsWith(f.taskRoot + '/')).toBe(true);
  }
  const { resolveTelosWorkRoleContext } = await import('../telos-work-role-context.js');
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
  const workerCommand = command(workerId);
  expect(await ordinary.firstCommand(workerCommand)).toMatchObject({
    state: 'consumed',
    dispatched: true,
  });
  const worker = chat.registry.findBySessionId(workerId)!;
  const workerNative = nativeSessions[1];
  const workerTurnStarts = () =>
    workerNative.rpc.request.mock.calls.filter(([method]) => method === 'turn/start').length;
  expect(workerTurnStarts()).toBe(1);
  expect(worker.session.taskContext?.currentTaskId).toBe(taskId);
  expect(nativeSessions).toHaveLength(2);
  const directory = chat.eventStore.getSession(workerId)!.cwd!;
  const inode = (await stat(directory)).ino;
  const report = 'Recorded the first session and retained its notes.';
  await writeFile(join(directory, 'recording-report.md'), report);
  const file = await request(application.app)
    .get('/api/files/read')
    .set('Authorization', 'Bearer ' + f.token)
    .query({ sessionId: workerId, path: 'recording-report.md' });
  expect(file.status).toBe(200);
  expect(file.body.content).toBe(report);
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
  const nativeTool = async (name: string, args: object) => {
    const definition = workerNative.tools.find((tool) => tool.description.startsWith(name + ':'));
    expect(
      definition,
      'Actual task MCP definition must be registered with the provider',
    ).toBeTruthy();
    const before = streamMessages.length;
    const pending = workerNative.lifecycle.onRequest(
      'item/tool/call',
      {
        threadId: workerNative.threadId,
        turnId: workerNative.turnId,
        callId: randomUUID(),
        tool: definition!.name,
        arguments: args,
      },
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
    const { resolvePending } = await import('@mitzo/harness');
    expect(resolvePending(permission.permId as string, 'once', undefined, workerId)).toBe(true);
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
  const { TelosItemStore } = await import('../telos-item-store.js');
  const items = new TelosItemStore(canonical.dbPath);
  cleanup.push(() => items.close());
  expect(items.read(childId).status).toBe('active');
  // Fake operator explicitly reads/verifies retained bytes before approving.
  expect(canonical.artifacts.read(output.id, output.revision).bytes.toString()).toBe(report);
  const approved = await request(application.app)
    .post('/api/tasks/' + taskId + '/approve')
    .set('Authorization', 'Bearer ' + f.token)
    .send({});
  expect(approved.status).toBe(200);
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
  const transport = worker.session.transport;
  expect(chat.detachChatIfCurrentTransport(worker.clientId, transport)).toBe(true);
  expect(chat.reattachChat(worker.clientId, { send: vi.fn(), isOpen: () => true })).toBe(true);
  const turnsBeforeReplay = workerTurnStarts();
  expect(turnsBeforeReplay).toBe(1);
  expect(await ordinary.firstCommand(workerCommand)).toMatchObject({
    state: 'consumed',
    dispatched: false,
  });
  expect(nativeSessions).toHaveLength(2);
  expect(workerTurnStarts()).toBe(turnsBeforeReplay);
  for (const id of [leadId, workerId])
    chat.stopOrdinaryChat(chat.registry.findBySessionId(id)!.clientId);
  await vi.waitFor(() => {
    expect(chat.registry.findBySessionId(workerId)).toBeNull();
    expect(chat.registry.findBySessionId(leadId)).toBeNull();
  });
  expect(f.legacyLookup).not.toHaveBeenCalled();
  f.reopenWorkspaceOwner();
  services.workspace = f.workspaces;
  expect(f.workspaces.getOrdinaryWorkspace(workerCommand.workspace.workspaceId).state).toBe(
    'claimed',
  );
  expect(chat.eventStore.getSession(workerId)?.ordinaryWorkspaceId).toBe(
    workerCommand.workspace.workspaceId,
  );
  expect((await stat(directory)).ino).toBe(inode);
  expect(await readFile(join(directory, 'recording-report.md'), 'utf8')).toBe(report);
  expect(application.taskStore.getTree()).toHaveLength(1);
  const { TaskStore } = await import('../task-store.js');
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
  for (const dir of [...directories, f.configuredWorkspace])
    await expect(access(join(dir, '.git'))).rejects.toThrow();
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(f.legacyLookup).not.toHaveBeenCalled();
  expect(getClientId).not.toHaveBeenCalled();
}, 60_000);
