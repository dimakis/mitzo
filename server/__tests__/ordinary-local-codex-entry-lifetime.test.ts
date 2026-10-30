import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Request, Response, Router } from 'express';
import type { ownedRuntimeFixture } from './fixtures/owned-local-codex-runtime.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';
import { SessionSseRegistry } from '../session-sse-registry.js';
import { SseTransport } from '../sse-transport.js';
import { ConnectionRegistry } from '@mitzo/harness';
import type { SessionTransport } from '@mitzo/harness';

const services = vi.hoisted(() => ({ workspace: undefined as unknown }));
vi.mock('../repository-workspace-runtime.js', async (original) => ({
  ...(await original<object>()),
  getRepositoryWorkspaces: () => services.workspace,
}));
vi.mock('../auth.js', async (original) => ({
  ...(await original<object>()),
  operatorAuthMiddleware: (_req: Request, res: Response, next: () => void) =>
    res.locals.authSession ? next() : res.status(401).end(),
}));
vi.mock('../connections-router.js', async (original) => ({
  ...(await original<object>()),
  requireSameOriginJson: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
// This suite uses a seven-byte Mach-O placeholder and a mocked native launch
// to exercise transport lifetime. Canonical native workflows and the separate
// unqualified-artifact negative test qualify the actual Mac artifact/kernel.
vi.mock('../codex-native-artifact-qualification.js', async (original) => ({
  ...(await original<object>()),
  assertQualifiedNativeMacExecutionArtifact: vi.fn(),
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('No SDK or model execution');
  },
}));
vi.mock('../auto-rename.js', () => ({
  shouldAutoRename: () => {
    throw Error('No model naming');
  },
}));
vi.mock('../notify.js', () => ({ sendTurnCompleteNotification: vi.fn(async () => {}) }));
vi.mock('../pushover.js', () => ({ sendTurnCompleteNotification: vi.fn(async () => {}) }));
vi.mock('../goal-client.js', () => ({
  createGoal: vi.fn(async () => null),
  reportUsage: vi.fn(async () => {}),
  deriveGoalTitle: () => 'Offline',
}));

const cleanups: Array<() => void | Promise<void>> = [];
let f: Awaited<ReturnType<typeof ownedRuntimeFixture>>;
let chat: typeof import('../chat.js');
let router: Router;
let streams: SessionSseRegistry;
let connections: ConnectionRegistry;
let lifecycle: CodexLifecycleTransport | undefined;
let nativeClosed = false;
const nativeCloseEffect = vi.fn();
const changes = vi.fn();
let native: typeof import('../codex-app-server-client.js');
let auth: typeof import('../auth.js');
let transportAuth: typeof import('../transport-auth-ownership.js');
let operator: typeof import('../agent-library-transport.js');
let controls: typeof import('../owned-local-codex-control.js');
let originalTransport: SessionTransport;

beforeEach(async () => {
  vi.resetModules();
  nativeClosed = false;
  lifecycle = undefined;
  nativeCloseEffect.mockClear();
  changes.mockClear();
  const { ownedRuntimeFixture } = await import('./fixtures/owned-local-codex-runtime.js');
  native = await import('../codex-app-server-client.js');
  auth = await import('../auth.js');
  transportAuth = await import('../transport-auth-ownership.js');
  operator = await import('../agent-library-transport.js');
  controls = await import('../owned-local-codex-control.js');
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No network or real model calls');
    }),
  );
  f = await ownedRuntimeFixture(cleanups, { chatRoute: true });
  services.workspace = f.workspace;
  const rawRequest = f.rpc.request.getMockImplementation()!;
  f.rpc.request.mockImplementation(async (method: string) => {
    if (method === 'thread/start')
      return {
        thread: { id: 'offline-entry-thread' },
        model: 'fixture-model',
        modelProvider: 'openai',
      } as never;
    if (method === 'turn/start') return { turn: { id: 'offline-entry-turn' } } as never;
    if (method === 'turn/interrupt') return {} as never;
    return rawRequest(method);
  });
  f.rpc.close.mockImplementation(() => {
    if (nativeClosed) return;
    nativeClosed = true;
    nativeCloseEffect();
    lifecycle?.onClose?.(Error('Offline native closed'));
  });
  vi.spyOn(native.CodexAppServerClient, 'launchIsolated').mockImplementation(
    (_home, _env, callbacks) => {
      lifecycle = callbacks;
      expect(f.events.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)?.state).toBe(
        'uncertain',
      );
      return f.rpc as unknown as ReturnType<typeof native.CodexAppServerClient.launchIsolated>;
    },
  );
  vi.spyOn(native.CodexAppServerClient, 'launch').mockImplementation(() => {
    throw Error('No alternate native process');
  });
  vi.spyOn(native.CodexAppServerClient, 'launchOpenShell').mockImplementation(() => {
    throw Error('No alternate native process');
  });
  chat = await import('../chat.js');
  const entry = await import('../ordinary-local-codex-entry.js');
  connections = new ConnectionRegistry();
  streams = new SessionSseRegistry();
  streams.add(
    f.dependencies.operatorConnectionId,
    { write: vi.fn(() => true), end: vi.fn(), writableEnded: false } as unknown as Response,
    f.auth.id,
  );
  originalTransport = new SseTransport(f.dependencies.operatorConnectionId, streams);
  connections.register(f.dependencies.operatorConnectionId, originalTransport);
  transportAuth.claimTransportConnection(f.dependencies.operatorConnectionId, f.auth.id);
  chat.setConnectionRegistry(connections);
  chat.setSessionChangeCallback(changes);
  router = entry.createOwnedLocalCodexEntryRouter(streams, {
    connRegistry: connections,
    sessionRegistry: chat.registry,
    eventStore: chat.eventStore,
  });
});
afterEach(async () => {
  if (f) {
    auth.revokeAuthSession(f.auth);
    await vi.waitFor(() =>
      expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeNull(),
    );
  }
  if (f) {
    streams?.remove(f.dependencies.operatorConnectionId);
    transportAuth.releaseTransportConnection(f.dependencies.operatorConnectionId, f.auth.id);
  }
  chat?.eventStore.close();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function sendFirstCommand() {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    let status = 200;
    const req = {
      method: 'POST',
      url: '/send',
      headers: { 'x-connection-id': f.dependencies.operatorConnectionId },
      body: { ...f.request, runOn: 'local', repositoryWorkspaceId: f.reservation.id },
    } as unknown as Request;
    const res = {
      locals: { authSession: f.auth },
      set() {
        return this;
      },
      status(code: number) {
        status = code;
        return this;
      },
      json(body: unknown) {
        resolve({ status, body });
        return this;
      },
    } as unknown as Response;
    (
      router as Router & {
        handle(req: Request, res: Response, next: (error?: unknown) => void): void;
      }
    ).handle(req, res, (error) => reject(error ?? Error('Unmatched route')));
  });
}

it('the actual consumed route survives finally/detach and terminates its original owner on logout', async () => {
  const response = await sendFirstCommand();
  expect(response).toMatchObject({
    status: 202,
    body: {
      ok: true,
      dispatched: true,
      state: 'consumed',
      sessionId: f.reservation.conversationId,
    },
  });
  const original = chat.registry.findBySessionId(f.reservation.conversationId)!;
  expect(original.session.ownedLocalAuthSessionId).toBe(f.auth.id);
  const receipt = chat.eventStore.getOrdinaryLocalCommandAdmission(f.request.clientMsgId);
  f.detach();
  streams.remove(f.dependencies.operatorConnectionId);
  connections.remove(f.dependencies.operatorConnectionId);
  expect(chat.detachChatIfCurrentTransport(original.clientId, originalTransport)).toBe(true);
  expect(f.rpc.close).not.toHaveBeenCalled();
  expect(chat.registry.findBySessionId(f.reservation.conversationId)?.session).toBe(
    original.session,
  );
  auth.revokeAuthSession(f.auth);
  await vi.waitFor(() =>
    expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeNull(),
  );
  expect(nativeCloseEffect).toHaveBeenCalledOnce();
  expect(native.CodexAppServerClient.launchIsolated).toHaveBeenCalledOnce();
  expect(chat.eventStore.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)).toEqual(receipt);
  expect(f.workspace.getHostReservation(f.reservation).state).toBe('claimed');
});

function closeOriginalStream() {
  f.detach();
  streams.remove(f.dependencies.operatorConnectionId);
  connections.remove(f.dependencies.operatorConnectionId);
  transportAuth.releaseTransportConnection(f.dependencies.operatorConnectionId, f.auth.id);
}

function sameLoginSocket() {
  const connectionId = `same-login:${randomUUID()}`;
  const transport = { send: vi.fn(), isOpen: () => true };
  const release = operator.bindAgentLibraryTransport(connectionId, f.auth);
  transportAuth.claimTransportConnection(connectionId, f.auth.id);
  cleanups.push(() => {
    release();
    transportAuth.releaseTransportConnection(connectionId, f.auth.id);
  });
  return { connectionId, transport };
}

it('closing original SSE A preserves same-login legacy attachment B and consumed execution', async () => {
  expect(await sendFirstCommand()).toMatchObject({ status: 202, body: { state: 'consumed' } });
  const original = chat.registry.findBySessionId(f.reservation.conversationId)!;
  const receipt = chat.eventStore.getOrdinaryLocalCommandAdmission(f.request.clientMsgId);
  const next = sameLoginSocket();
  controls.assertLegacyOwnedControlAllowed(
    next.connectionId,
    next.connectionId,
    next.transport,
    { type: 'reattach', clientId: original.clientId },
    { sessionRegistry: chat.registry, eventStore: chat.eventStore },
  );
  expect(chat.reattachChat(original.clientId, next.transport)).toBe(true);
  expect(original.session.ownerConnectionId).toBe(f.dependencies.operatorConnectionId);
  closeOriginalStream();
  expect(chat.detachChatIfCurrentTransport(original.clientId, originalTransport)).toBe(false);
  expect(chat.registry.isAttached(original.clientId)).toBe(true);
  expect(original.session.transport).toBe(next.transport);
  expect(chat.eventStore.getSessionState(f.reservation.conversationId)).toBe('ACTIVE');
  expect(changes).not.toHaveBeenCalledWith(
    original.clientId,
    'detach',
    f.reservation.conversationId,
  );
  expect(nativeCloseEffect).not.toHaveBeenCalled();
  expect(chat.eventStore.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)).toEqual(receipt);
  expect(f.workspace.getHostReservation(f.reservation).state).toBe('claimed');
  expect(chat.detachChatIfCurrentTransport(original.clientId, next.transport)).toBe(true);
  expect(chat.registry.isAttached(original.clientId)).toBe(false);
  expect(changes).toHaveBeenCalledWith(original.clientId, 'detach', f.reservation.conversationId);
});

it('publishes a detached consumed query when original SSE disappears during source reservation', async () => {
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const reserve = f.workspace.reserveHostTask.bind(f.workspace);
  vi.spyOn(f.workspace, 'reserveHostTask').mockImplementationOnce(async (args) => {
    enter();
    await pending;
    return reserve(args);
  });
  const response = sendFirstCommand();
  await entered;
  expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeNull();
  closeOriginalStream();
  expect(originalTransport.isOpen()).toBe(false);
  finish();
  expect(await response).toMatchObject({
    status: 202,
    body: { state: 'consumed', dispatched: true },
  });
  const original = chat.registry.findBySessionId(f.reservation.conversationId)!;
  expect(original.session.transport).toBe(originalTransport);
  expect(chat.registry.isAttached(original.clientId)).toBe(false);
  expect(chat.eventStore.getSessionState(f.reservation.conversationId)).toBe('DETACHED');
  expect(changes).toHaveBeenCalledWith(original.clientId, 'detach', f.reservation.conversationId);
  expect(original.session.ownedLocalAuthSessionId).toBe(f.auth.id);
  expect(nativeCloseEffect).not.toHaveBeenCalled();
  expect(native.CodexAppServerClient.launchIsolated).toHaveBeenCalledOnce();
  const receipt = chat.eventStore.getOrdinaryLocalCommandAdmission(f.request.clientMsgId);
  expect(f.workspace.getHostReservation(f.reservation).state).toBe('claimed');
  const next = sameLoginSocket();
  controls.assertLegacyOwnedControlAllowed(
    next.connectionId,
    next.connectionId,
    next.transport,
    { type: 'reattach', clientId: original.clientId },
    { sessionRegistry: chat.registry, eventStore: chat.eventStore },
  );
  expect(chat.reattachChat(original.clientId, next.transport)).toBe(true);
  expect(chat.registry.isAttached(original.clientId)).toBe(true);
  expect(native.CodexAppServerClient.launchIsolated).toHaveBeenCalledOnce();
  expect(chat.eventStore.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)).toEqual(receipt);
});

it('closing v2 WS predecessor B cannot detach current legacy C after SSE A', async () => {
  expect(await sendFirstCommand()).toMatchObject({ status: 202 });
  const original = chat.registry.findBySessionId(f.reservation.conversationId)!;
  closeOriginalStream();
  expect(chat.detachChatIfCurrentTransport(original.clientId, originalTransport)).toBe(true);
  const next = sameLoginSocket();
  connections.register(next.connectionId, next.transport);
  const ws = await import('../ws-handler-v2.js');
  const { NativeCommandRegistry } = await import('../native-commands.js');
  ws.handleReconnect(
    next.connectionId,
    {
      type: 'reconnect',
      sessions: [{ sessionId: f.reservation.conversationId, lastSeq: 0 }],
    },
    {
      sessionRegistry: chat.registry,
      connRegistry: connections,
      eventStore: chat.eventStore,
      nativeCommands: new NativeCommandRegistry(),
    },
  );
  expect(original.session.ownerConnectionId).toBe(next.connectionId);
  expect(original.session.transport).toBe(next.transport);
  const current = sameLoginSocket();
  controls.assertLegacyOwnedControlAllowed(
    current.connectionId,
    current.connectionId,
    current.transport,
    { type: 'reattach', clientId: original.clientId },
    { sessionRegistry: chat.registry, eventStore: chat.eventStore },
  );
  expect(chat.reattachChat(original.clientId, current.transport)).toBe(true);
  connections.remove(next.connectionId);
  expect(chat.detachChatIfCurrentTransport(original.clientId, next.transport)).toBe(false);
  expect(chat.registry.isAttached(original.clientId)).toBe(true);
  expect(original.session.transport).toBe(current.transport);
  expect(original.session.ownedLocalAuthSessionId).toBe(f.auth.id);
  expect(nativeCloseEffect).not.toHaveBeenCalled();
  expect(native.CodexAppServerClient.launchIsolated).toHaveBeenCalledOnce();
  expect(chat.eventStore.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)?.state).toBe(
    'consumed',
  );
  chat.registry.suspend(original.clientId, 0);
  chat.eventStore.setSessionState(f.reservation.conversationId, 'SUSPENDED', {
    clientId: original.clientId,
  });
  const detachNotifications = changes.mock.calls.filter(([, event]) => event === 'detach').length;
  expect(chat.detachChatIfCurrentTransport(original.clientId, current.transport)).toBe(false);
  expect(chat.registry.isSuspended(original.clientId)).toBe(true);
  expect(chat.eventStore.getSessionState(f.reservation.conversationId)).toBe('SUSPENDED');
  expect(changes.mock.calls.filter(([, event]) => event === 'detach')).toHaveLength(
    detachNotifications,
  );
  expect(nativeCloseEffect).not.toHaveBeenCalled();
});

it('buffered immediate completion observes detached notification state before query pumping', async () => {
  const notifications = await import('../notification-center.js');
  const record = vi.spyOn(notifications, 'recordTurnNotification');
  const reserve = f.workspace.reserveHostTask.bind(f.workspace);
  vi.spyOn(f.workspace, 'reserveHostTask').mockImplementationOnce(async (args) => {
    closeOriginalStream();
    return reserve(args);
  });
  const request = f.rpc.request.getMockImplementation()!;
  f.rpc.request.mockImplementation(async (method: string) => {
    if (method === 'turn/start')
      lifecycle!.onNotification('turn/completed', {
        threadId: 'offline-entry-thread',
        turn: { id: 'offline-entry-turn', status: 'completed' },
      });
    return request(method);
  });
  expect(await sendFirstCommand()).toMatchObject({ status: 202, body: { state: 'consumed' } });
  await vi.waitFor(() => expect(record).toHaveBeenCalled());
  expect(record).toHaveBeenCalledWith(
    f.reservation.conversationId,
    expect.any(Number),
    expect.any(String),
    undefined,
    true,
  );
  expect(changes).toHaveBeenCalledWith(expect.any(String), 'detach', f.reservation.conversationId);
  expect(chat.eventStore.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)?.state).toBe(
    'consumed',
  );
  expect(f.workspace.getHostReservation(f.reservation).state).toBe('claimed');
  expect(native.CodexAppServerClient.launchIsolated).toHaveBeenCalledOnce();
});

it('keeps a later session cleanup failure separate from its completed first command', async () => {
  expect(await sendFirstCommand()).toMatchObject({ status: 202 });
  const sessionId = f.reservation.conversationId;
  const original = chat.registry.findBySessionId(sessionId)!;
  const codex = await import('../codex-chat-session.js');
  await vi.waitFor(() =>
    expect(
      codex
        .getCodexConversationStore()
        .commandLifecycle(sessionId, f.reservation.binding, f.request.clientMsgId).nativeTarget,
    ).toBeDefined(),
  );
  lifecycle!.onNotification('turn/completed', {
    threadId: 'offline-entry-thread',
    turn: { id: 'offline-entry-turn', status: 'completed' },
  });
  await vi.waitFor(() =>
    expect(
      codex
        .getCodexConversationStore()
        .commandStatus(sessionId, f.reservation.binding, f.request.clientMsgId),
    ).toBe('completed'),
  );
  chat.setSessionChangeCallback((_clientId, change) => {
    if (change === 'end') throw Error('Offline later lifecycle cleanup failure');
  });
  try {
    codex.getCodexRuntime(original.session)!.close();
    await vi.waitFor(() =>
      expect(
        chat.eventStore.getSessionEvents(sessionId).filter((event) => event.type === 'error'),
      ).toHaveLength(1),
    );
    const error = chat.eventStore.getLatestEvent(sessionId, 'error')!.payload;
    expect(error).toMatchObject({
      runtimeFailure: {
        runtimeFailureCode: 'runtime_unavailable',
        diagnosticId: expect.any(String),
      },
    });
    expect(error).not.toHaveProperty('clientMsgId');
    expect(error).not.toHaveProperty('retainedCommandFailure');
    expect(
      codex
        .getCodexConversationStore()
        .commandStatus(sessionId, f.reservation.binding, f.request.clientMsgId),
    ).toBe('completed');
    expect(chat.eventStore.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)?.state).toBe(
      'consumed',
    );
    expect(native.CodexAppServerClient.launchIsolated).toHaveBeenCalledOnce();
  } finally {
    chat.setSessionChangeCallback(changes);
  }
});
