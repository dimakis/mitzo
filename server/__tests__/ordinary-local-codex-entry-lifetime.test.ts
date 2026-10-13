import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Request, Response, Router } from 'express';
import { ownedRuntimeFixture } from './fixtures/owned-local-codex-runtime.js';
import { CodexAppServerClient, type CodexLifecycleTransport } from '../codex-app-server-client.js';
import {
  claimTransportConnection,
  releaseTransportConnection,
} from '../transport-auth-ownership.js';
import { SessionSseRegistry } from '../session-sse-registry.js';
import { ConnectionRegistry } from '@mitzo/harness';
import { revokeAuthSession } from '../auth.js';

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
vi.mock('../connections-router.js', () => ({
  requireSameOriginJson: (_req: unknown, _res: unknown, next: () => void) => next(),
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

beforeAll(async () => {
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
  vi.spyOn(CodexAppServerClient, 'launchIsolated').mockImplementation((_home, _env, callbacks) => {
    lifecycle = callbacks;
    expect(f.events.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)?.state).toBe(
      'uncertain',
    );
    return f.rpc as unknown as ReturnType<typeof CodexAppServerClient.launchIsolated>;
  });
  vi.spyOn(CodexAppServerClient, 'launch').mockImplementation(() => {
    throw Error('No alternate native process');
  });
  vi.spyOn(CodexAppServerClient, 'launchOpenShell').mockImplementation(() => {
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
  connections.register(f.dependencies.operatorConnectionId, {
    send: vi.fn(),
    isOpen: () => streams.isOpen(f.dependencies.operatorConnectionId),
  });
  claimTransportConnection(f.dependencies.operatorConnectionId, f.auth.id);
  chat.setConnectionRegistry(connections);
  router = entry.createOwnedLocalCodexEntryRouter(streams, {
    connRegistry: connections,
    sessionRegistry: chat.registry,
    eventStore: chat.eventStore,
  });
});
afterAll(async () => {
  if (f) {
    streams?.remove(f.dependencies.operatorConnectionId);
    releaseTransportConnection(f.dependencies.operatorConnectionId, f.auth.id);
  }
  chat?.eventStore.close();
  for (const cleanup of cleanups.reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('the actual consumed route survives finally/detach and terminates its original owner on logout', async () => {
  const response = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
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
  chat.detachChat(original.clientId);
  expect(f.rpc.close).not.toHaveBeenCalled();
  expect(chat.registry.findBySessionId(f.reservation.conversationId)?.session).toBe(
    original.session,
  );
  revokeAuthSession(f.auth);
  await vi.waitFor(() =>
    expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeNull(),
  );
  expect(nativeCloseEffect).toHaveBeenCalledOnce();
  expect(CodexAppServerClient.launchIsolated).toHaveBeenCalledOnce();
  expect(chat.eventStore.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)).toEqual(receipt);
  expect(f.workspace.getHostReservation(f.reservation).state).toBe('claimed');
});
