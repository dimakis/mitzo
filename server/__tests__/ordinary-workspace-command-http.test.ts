import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { access, writeFile, readFile, stat, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Response } from 'express';
import type { ownedOrdinaryRuntimeFixture } from './fixtures/owned-ordinary-workspace-runtime.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';
import type { SessionSseRegistry } from '../session-sse-registry.js';
import type { ConnectionRegistry } from '@mitzo/harness';

const services = vi.hoisted(() => ({ workspace: undefined as unknown }));
vi.mock('../repository-workspace-runtime.js', async (original) => ({
  ...(await original<object>()),
  getOrdinaryWorkspaces: () => services.workspace,
}));
vi.mock('../internal-token.js', () => ({
  INTERNAL_TOKEN: 'synthetic-only-ordinary-native-token',
  isValidInternalToken: () => false,
  createSignalCallbackToken: vi.fn(() => 'synthetic-callback'),
  revokeSignalCallbackToken: vi.fn(),
  isValidSignalCallbackToken: () => false,
}));
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

const cleanup: Array<() => void | Promise<void>> = [];
let f: Awaited<ReturnType<typeof ownedOrdinaryRuntimeFixture>>;
let chat: typeof import('../chat.js');
let entry: typeof import('../ordinary-local-codex-entry.js');
let native: typeof import('../codex-app-server-client.js');
let auth: typeof import('../auth.js');
let transportAuth: typeof import('../transport-auth-ownership.js');
let streams: SessionSseRegistry;
let connections: ConnectionRegistry;
let lifecycle: CodexLifecycleTransport | undefined;
let nativeClosed = false;
let turnSequence = 0;
let api: import('@mitzo/client').OrdinaryWorkspaceApiClient;
let app: express.Express;
const startup = await vi.hoisted(async () => {
  const fs = await import('node:fs'),
    os = await import('node:os'),
    path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-command-startup-')));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', path.join(root, 'private'));
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER', undefined);
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_OWNER', undefined);
  return { root, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
});
const interruptedDelegationCase =
  'refuses an incomplete V2 delegation before role retention through actual ordinary HTTP, including workspace owner reopen';
beforeEach(async ({ task }) => {
  vi.resetModules();
  nativeClosed = false;
  lifecycle = undefined;
  turnSequence = 0;
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
    ...(task.name === interruptedDelegationCase ? { delegationAttemptId: randomUUID() } : {}),
  });
  services.workspace = f.workspaces;
  chat = await import('../chat.js');
  native = await import('../codex-app-server-client.js');
  auth = await import('../auth.js');
  // The real chat EventStore is independently opened onto the same private database.
  expect(chat.eventStore.getSession(f.first.receipt.sessionId)?.ordinaryWorkspaceId).toBe(
    f.first.reserved.id,
  );
  transportAuth = await import('../transport-auth-ownership.js');
  const raw = f.first.rpc.request.getMockImplementation()!;
  f.first.rpc.request.mockImplementation(async (method: string) => {
    if (method === 'thread/start')
      return {
        thread: { id: 'offline-ordinary-thread' },
        model: 'fixture-model',
        modelProvider: 'openai',
      } as never;
    if (method === 'thread/resume')
      return {
        thread: { id: 'offline-ordinary-thread' },
        model: 'fixture-model',
        modelProvider: 'openai',
      } as never;
    if (method === 'turn/start')
      return { turn: { id: 'offline-ordinary-turn-' + ++turnSequence } } as never;
    if (method === 'turn/interrupt') return {} as never;
    return raw(method);
  });
  f.first.rpc.close.mockImplementation(() => {
    if (nativeClosed) return;
    nativeClosed = true;
    lifecycle?.onClose?.(Error('Offline native closed'));
  });
  vi.spyOn(native.CodexAppServerClient, 'launchIsolated').mockImplementation(
    (_home, _env, callbacks) => {
      lifecycle = callbacks;
      expect(
        chat.eventStore.getLatestOrdinaryCommandAdmission(f.first.receipt.sessionId)?.state,
      ).toBe('uncertain');
      return f.first.rpc as unknown as ReturnType<
        typeof native.CodexAppServerClient.launchIsolated
      >;
    },
  );
  for (const port of ['launch', 'launchOpenShell'] as const)
    vi.spyOn(native.CodexAppServerClient, port).mockImplementation(() => {
      throw Error('Alternate native process forbidden');
    });
  const { SessionSseRegistry } = await import('../session-sse-registry.js'),
    { SseTransport } = await import('../sse-transport.js'),
    { ConnectionRegistry } = await import('@mitzo/harness');
  connections = new ConnectionRegistry();
  streams = new SessionSseRegistry();
  streams.add(
    f.operatorConnectionId,
    { write: vi.fn(() => true), end: vi.fn(), writableEnded: false } as unknown as Response,
    f.auth.id,
  );
  connections.register(f.operatorConnectionId, new SseTransport(f.operatorConnectionId, streams));
  transportAuth.claimTransportConnection(f.operatorConnectionId, f.auth.id);
  chat.setConnectionRegistry(connections);
  entry = await import('../ordinary-local-codex-entry.js');
});
afterEach(async () => {
  if (chat && f) {
    auth.revokeAuthSession(f.auth);
    await vi.waitFor(() =>
      expect(chat.registry.findBySessionId(f.first.receipt.sessionId)).toBeNull(),
    );
    streams?.remove(f.operatorConnectionId);
    transportAuth.releaseTransportConnection(f.operatorConnectionId, f.auth.id);
    connections.dispose();
    chat.setConnectionRegistry(null);
    expect(chat.getConnectionRegistry()).toBeNull();
    chat.eventStore.close();
  }
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
// Each test owns a new private root; this initial import root contains no target.
import { afterAll } from 'vitest';
afterAll(() => startup.remove());
async function mount() {
  app = express();
  app.use(express.json());
  app.use(
    '/api/ordinary/workspaces/commands',
    entry.createOwnedOrdinaryWorkspaceCommandRouter(streams, {
      connRegistry: connections,
      sessionRegistry: chat.registry,
      eventStore: chat.eventStore,
    }),
  );
  const { OrdinaryWorkspaceApiClient } = await import('@mitzo/client');
  api = new OrdinaryWorkspaceApiClient(async (url, init) => {
    const response = await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + f.token)
      .set('X-Connection-Id', f.operatorConnectionId)
      .send(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}
const first = () => ({
  version: 2 as const,
  ...structuredClone(f.first.request),
  runOn: 'local' as const,
  sessionId: f.first.receipt.sessionId,
  workspace: { kind: 'ordinary' as const, workspaceId: f.first.reserved.id },
});
it('the fixture uses real non-Git ordinary preparation and independently shared chat storage before any native launch', async () => {
  await expect(access(join(f.first.reserved.directory, '.git'))).rejects.toThrow();
  expect(
    chat.eventStore.getOrdinaryWorkspaceSessionPreparation(f.first.receipt.allocationOperationId),
  ).toEqual(f.first.receipt);
  expect(f.first.launch).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('typed ordinary first HTTP reaches real chat/native custody and exact consumed replay never sends another turn', async () => {
  await mount();
  const input = first();
  const receipt = await api.firstCommand(input);
  expect(receipt).toMatchObject({
    ok: true,
    sessionId: input.sessionId,
    clientMsgId: input.clientMsgId,
    dispatched: true,
    state: 'consumed',
  });
  expect(f.workspaces.getOrdinaryWorkspace(input.workspace.workspaceId).state).toBe('claimed');
  expect(chat.eventStore.getSession(input.sessionId)?.repositoryWorkspaceId).toBeUndefined();
  expect(chat.registry.findBySessionId(input.sessionId)?.session.ownedLocalAuthSessionId).toBe(
    f.auth.id,
  );
  expect(chat.getConnectionRegistry()).toBe(connections);
  expect(() => chat.setConnectionRegistry(null)).toThrow('Chat session owners are active');
  expect(chat.getConnectionRegistry()).toBe(connections);
  expect(await api.firstCommand(input)).toMatchObject({ dispatched: false, state: 'consumed' });
  expect(native.CodexAppServerClient.launchIsolated).toHaveBeenCalledOnce();
  expect(f.first.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(
    1,
  );
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(f.legacyLookup).not.toHaveBeenCalled();
});
it('rejects a mismatched ordinary identity before any native launch or durable command', async () => {
  await mount();
  const input = first();
  input.workspace.workspaceId = randomUUID();
  await expect(api.firstCommand(input)).rejects.toThrow();
  expect(native.CodexAppServerClient.launchIsolated).not.toHaveBeenCalled();
  expect(chat.eventStore.getOrdinaryCommandAdmission(input.clientMsgId)).toBeUndefined();
});
it('retains a running ordinary command across detach and reattach without another launch', async () => {
  await mount();
  const input = first();
  await api.firstCommand(input);
  const found = chat.registry.findBySessionId(input.sessionId)!;
  const transport = found.session.transport;
  streams.remove(f.operatorConnectionId);
  connections.remove(f.operatorConnectionId);
  expect(chat.detachChatIfCurrentTransport(found.clientId, transport)).toBe(true);
  const next = { send: vi.fn(), isOpen: () => true };
  expect(chat.reattachChat(found.clientId, next)).toBe(true);
  expect(chat.eventStore.getOrdinaryCommandAdmission(input.clientMsgId)?.state).toBe('consumed');
  expect(native.CodexAppServerClient.launchIsolated).toHaveBeenCalledOnce();
});

it('warm continuation uses the same native FIFO and original ordinary custody', async () => {
  await mount();
  const input = first();
  await api.firstCommand(input);
  const next = {
    ...input,
    clientMsgId: randomUUID(),
    payload: { text: 'Refine the retained report' },
  };
  const pending = api.continueCommand(next);
  await vi.waitFor(() =>
    expect(chat.eventStore.getOrdinaryCommandAdmission(next.clientMsgId)).toBeDefined(),
  );
  lifecycle!.onNotification('turn/completed', {
    threadId: 'offline-ordinary-thread',
    turn: { id: 'offline-ordinary-turn-1', status: 'completed' },
  });
  expect(await pending).toMatchObject({
    sessionId: input.sessionId,
    dispatched: true,
    state: 'consumed',
  });
  await vi.waitFor(() =>
    expect(
      f.first.rpc.request.mock.calls.filter(([method]) => method === 'turn/start'),
    ).toHaveLength(2),
  );
  expect(native.CodexAppServerClient.launchIsolated).toHaveBeenCalledOnce();
  expect(chat.eventStore.getSession(input.sessionId)?.ordinaryWorkspaceId).toBe(
    input.workspace.workspaceId,
  );
});
it('cold native-owner continuation reopens the same private thread and workspace after an explicit stop', async () => {
  await mount();
  const input = first();
  await api.firstCommand(input);
  lifecycle!.onNotification('turn/completed', {
    threadId: 'offline-ordinary-thread',
    turn: { id: 'offline-ordinary-turn-1', status: 'completed' },
  });
  const nativeStore = (await import('../codex-chat-session.js')).getCodexConversationStore();
  await vi.waitFor(() =>
    expect(nativeStore.hasRunningCommand(input.sessionId, f.binding)).toBe(false),
  );
  const file = join(f.first.reserved.directory, 'retained-report.txt');
  await writeFile(file, 'Original ordinary report');
  const directoryIdentity = (await stat(f.first.reserved.directory)).ino;
  const found = chat.registry.findBySessionId(input.sessionId)!;
  chat.stopOrdinaryChat(found.clientId);
  await vi.waitFor(() => expect(chat.registry.findBySessionId(input.sessionId)).toBeNull());
  expect(chat.canResumeOwnedLocalCodexDriver(input.sessionId, f.auth.id)).toBe(true);
  nativeClosed = false;
  const next = {
    ...input,
    clientMsgId: randomUUID(),
    payload: { text: 'Continue the same retained work' },
  };
  expect(await api.continueCommand(next)).toMatchObject({
    sessionId: input.sessionId,
    dispatched: true,
    state: 'consumed',
  });
  expect(
    f.first.rpc.request.mock.calls.filter(([method]) => method === 'thread/start'),
  ).toHaveLength(1);
  expect(
    f.first.rpc.request.mock.calls.filter(([method]) => method === 'thread/resume'),
  ).toHaveLength(1);
  expect(chat.eventStore.getSession(input.sessionId)?.ordinaryWorkspaceId).toBe(
    input.workspace.workspaceId,
  );
  expect(f.workspaces.getOrdinaryWorkspace(input.workspace.workspaceId).state).toBe('claimed');
  expect(await readFile(file, 'utf8')).toBe('Original ordinary report');
  expect((await stat(f.first.reserved.directory)).ino).toBe(directoryIdentity);
  expect(f.legacyLookup).not.toHaveBeenCalled();
});
it('refuses altered consumed command identity without another launch or turn', async () => {
  await mount();
  const input = first();
  await api.firstCommand(input);
  const retained = chat.eventStore.getOrdinaryCommandAdmission(input.clientMsgId);
  await expect(
    api.firstCommand({ ...input, payload: { text: 'Changed intent' } }),
  ).rejects.toMatchObject({ status: 409 });
  expect(chat.eventStore.getOrdinaryCommandAdmission(input.clientMsgId)).toEqual(retained);
  expect(native.CodexAppServerClient.launchIsolated).toHaveBeenCalledOnce();
  expect(f.first.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(
    1,
  );
});
it('native startup failure preserves the original uncertain command and claimed directory without automatic replay', async () => {
  await mount();
  const input = first();
  const raw = f.first.rpc.request.getMockImplementation()!;
  f.first.rpc.request.mockImplementation(async (method: string) => {
    if (method === 'thread/start') throw Error('Injected offline provider startup loss');
    return raw(method);
  });
  await expect(api.firstCommand(input)).rejects.toMatchObject({ status: 409 });
  const retained = chat.eventStore.getOrdinaryCommandAdmission(input.clientMsgId);
  expect(retained?.state).toBe('uncertain');
  expect(f.workspaces.getOrdinaryWorkspace(input.workspace.workspaceId).state).toBe('claimed');
  await expect(api.firstCommand(input)).rejects.toMatchObject({ status: 409 });
  expect(chat.eventStore.getOrdinaryCommandAdmission(input.clientMsgId)).toEqual(retained);
  expect(native.CodexAppServerClient.launchIsolated).toHaveBeenCalledOnce();
  expect(f.first.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(
    0,
  );
});

it('actual command middleware refuses absent auth and cross-origin requests before native or command effects', async () => {
  await mount();
  const input = first(),
    path = '/api/ordinary/workspaces/commands/first';
  expect(
    (await request(app).post(path).set('X-Connection-Id', f.operatorConnectionId).send(input))
      .status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .post(path)
        .set('Authorization', 'Bearer ' + f.token)
        .set('X-Connection-Id', f.operatorConnectionId)
        .set('Origin', 'https://untrusted.example.test')
        .send(input)
    ).status,
  ).toBe(403);
  expect(native.CodexAppServerClient.launchIsolated).not.toHaveBeenCalled();
  expect(chat.eventStore.getOrdinaryCommandAdmission(input.clientMsgId)).toBeUndefined();
});
it('ordinary command routing rejects forged paths and repository grants and requires the actual owned SSE connection', async () => {
  await mount();
  const input = first(),
    path = '/api/ordinary/workspaces/commands/first';
  const post = (body: object, connection: string = f.operatorConnectionId) =>
    request(app)
      .post(path)
      .set('Authorization', 'Bearer ' + f.token)
      .set('X-Connection-Id', connection)
      .send(body);
  expect(
    (await post({ ...input, repositoryWorkspaceId: 'fake-repository', cwd: '/fake-root' })).status,
  ).toBe(400);
  expect((await post(input, 'unbound-stream')).status).toBe(403);
  expect(native.CodexAppServerClient.launchIsolated).not.toHaveBeenCalled();
  expect(chat.eventStore.getOrdinaryCommandAdmission(input.clientMsgId)).toBeUndefined();
});

it('refuses a consumed continuation acknowledgement after its claimed ordinary directory is replaced', async () => {
  await mount();
  const input = first();
  await api.firstCommand(input);
  const next = { ...input, clientMsgId: randomUUID(), payload: { text: 'Retained continuation' } };
  const pending = api.continueCommand(next);
  await vi.waitFor(() =>
    expect(chat.eventStore.getOrdinaryCommandAdmission(next.clientMsgId)).toBeDefined(),
  );
  lifecycle!.onNotification('turn/completed', {
    threadId: 'offline-ordinary-thread',
    turn: { id: 'offline-ordinary-turn-1', status: 'completed' },
  });
  await pending;
  const retained = chat.eventStore.getOrdinaryCommandAdmission(next.clientMsgId);
  await rename(f.first.reserved.directory, f.first.reserved.directory + '-retained');
  await mkdir(f.first.reserved.directory, { mode: 0o700 });
  await expect(api.continueCommand(next)).rejects.toMatchObject({ status: 409 });
  expect(chat.eventStore.getOrdinaryCommandAdmission(next.clientMsgId)).toEqual(retained);
  expect(native.CodexAppServerClient.launchIsolated).toHaveBeenCalledOnce();
});

it(interruptedDelegationCase, async () => {
  await mount();
  const input = first(),
    original = chat.eventStore.getOrdinaryWorkspaceSessionPreparation(
      f.first.receipt.allocationOperationId,
    )!;
  expect(original.delegationAttemptId).toBeTruthy();
  expect(chat.eventStore.getSessionEvents(input.sessionId)).toEqual([]);
  const before = chat.eventStore.listSessions().length;
  await expect(api.firstCommand(input)).rejects.toMatchObject({ status: 409 });
  expect(native.CodexAppServerClient.launchIsolated).not.toHaveBeenCalled();
  expect(chat.eventStore.getOrdinaryCommandAdmission(input.clientMsgId)).toBeUndefined();
  expect(f.workspaces.getOrdinaryWorkspace(input.workspace.workspaceId).state).toBe('reserved');
  await expect(access(f.first.reserved.directory)).rejects.toThrow();
  f.reopenWorkspaceOwner();
  services.workspace = f.workspaces;
  await expect(api.firstCommand(input)).rejects.toMatchObject({ status: 409 });
  expect(
    chat.eventStore.getOrdinaryWorkspaceSessionPreparation(f.first.receipt.allocationOperationId),
  ).toEqual(original);
  expect(chat.eventStore.listSessions()).toHaveLength(before);
  expect(native.CodexAppServerClient.launchIsolated).not.toHaveBeenCalled();
  expect(chat.eventStore.getOrdinaryCommandAdmission(input.clientMsgId)).toBeUndefined();
});

it('delivers a queued reply with the exact server-captured source text through actual ordinary HTTP and native turn input', async () => {
  await mount();
  const input = first();
  await api.firstCommand(input);
  const next = {
    ...input,
    clientMsgId: randomUUID(),
    payload: { text: 'The current priorities are fine.', replyToMessageId: input.clientMsgId },
  };
  const pending = Promise.all([
    api.continueCommand(next),
    api.continueCommand(structuredClone(next)),
  ]);
  await vi.waitFor(() =>
    expect(chat.eventStore.getOrdinaryCommandAdmission(next.clientMsgId)).toBeDefined(),
  );
  lifecycle!.onNotification('turn/completed', {
    threadId: 'offline-ordinary-thread',
    turn: { id: 'offline-ordinary-turn-1', status: 'completed' },
  });
  await pending;
  await vi.waitFor(() =>
    expect(
      f.first.rpc.request.mock.calls.filter(([method]) => method === 'turn/start'),
    ).toHaveLength(2),
  );
  const sent = JSON.stringify(
    f.first.rpc.request.mock.calls.filter(([method]) => method === 'turn/start').at(-1),
  );
  expect(sent).toContain(input.payload.text);
  expect(sent).toContain(next.payload.text);
  expect(sent).toContain('mitzo_message_reply');
  expect(chat.eventStore.getMessageReplyContext(input.sessionId, next.clientMsgId)).toMatchObject({
    messageId: input.clientMsgId,
    text: input.payload.text,
  });
  expect(
    chat.eventStore
      .getSessionEvents(input.sessionId)
      .filter((e) => e.type === 'message_reply_context'),
  ).toHaveLength(1);
});
it('delivers a reply correction to the exact active native turn with the same-chat reference included', async () => {
  await mount();
  const input = first();
  await api.firstCommand(input);
  const rpc = f.first.rpc.request.getMockImplementation()!;
  f.first.rpc.request.mockImplementation(async (method, ...args) =>
    method === 'turn/steer'
      ? ({ turnId: 'offline-ordinary-turn-1' } as never)
      : rpc(method, ...args),
  );
  const { getCodexRuntime } = await import('../codex-chat-session.js');
  const runtime = getCodexRuntime(chat.registry.findBySessionId(input.sessionId)!.session)!;
  expect(
    await runtime.steer(
      {
        requestId: 'quoted-correction',
        targetCommandId: input.clientMsgId,
        text: 'Use this correction.',
        replyToMessageId: input.clientMsgId,
      },
      () => {},
    ),
  ).toEqual({ status: 'accepted' });
  const sent = JSON.stringify(
    f.first.rpc.request.mock.calls.filter(([method]) => method === 'turn/steer').at(-1),
  );
  expect(sent).toContain(input.payload.text);
  expect(sent).toContain('Use this correction.');
  expect(sent).toContain('mitzo_message_reply');
});
