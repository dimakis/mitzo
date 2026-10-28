import { fixture, cleanups } from './prepared-repository-native-consumer.js';
import express from 'express';
import requestHttp, { type Response as HttpResponse } from 'supertest';
import { expect, vi } from 'vitest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMitzoStore } from '@mitzo/client';
import { LocalCodexFirstCommandSchema, LocalCodexFirstCommandReceiptSchema } from '@mitzo/protocol';
import { CodexAppServerClient } from '../../codex-app-server-client.js';
import { codexNativeExecutionPolicy } from '../../codex-native-execution-policy.js';

import { preparedRepositoryBrowser as browser } from './prepared-repository-browser.js';
vi.mock('../../../packages/client/src/sse-connection.js', async () => ({
  SseConnection: (await import('./prepared-repository-browser.js')).PreparedRepositorySseConnection,
}));

/** Real admission/adoption, public router, durable client outbox and native FIFO.
 * Only provider RPC, physical reader and browser SSE transport are synthetic. */
export async function preparedRepositoryDeliveryFlow(
  options: {
    images?: Array<{ data: string; mediaType: string }>;
    publicationFlow?: boolean;
    unadmittedStaleWorkspace?: boolean;
    storage?: (
      seed: string,
    ) => Pick<Storage, 'getItem' | 'setItem'> & { flush?: () => Promise<void> };
  } = {},
) {
  // This synthetic operator covers the composed test envelope plus cleanup.
  // Production authentication and the separate expiry-negative fixtures retain
  // their own lifetimes; no authority is refreshed during an active operation.
  const operatorLifetimeMs = process.env.CI ? 960_000 : 480_000;
  const f = await fixture(true, operatorLifetimeMs, options.images, options.publicationFlow);
  const sessionId = f.first.sessionId;
  const binding = f.first.lease.binding;
  const originalBody = LocalCodexFirstCommandSchema.parse({
    ...structuredClone(f.request),
    runOn: 'local',
    repositoryWorkspaceId: f.reservation.id,
  });
  const originalReceipt = f.events.getOrdinaryLocalCommandAdmission(f.request.clientMsgId);
  const originalMetadata = structuredClone(f.events.getSession(sessionId));
  const adopted = (await f.adopt())!;
  f.setCwd(adopted.directory);
  const primary = f.native.claimNext(sessionId, binding)!;
  f.admission.assertBeforeDispatch(primary.id);
  f.native.prepareNativeExecution(
    sessionId,
    binding,
    primary,
    'thread',
    codexNativeExecutionPolicy({
      bindingRevision: binding.profileRevision!,
      mode: 'agent',
      cwd: adopted.directory,
      readableRoots: ['/'],
      writableRoots: [adopted.directory],
      deniedRoots: [join(f.root, 'login'), join(f.root, 'custody')],
      writeProtectedRoots: [],
    }),
  );
  f.native.recordNativeTurnAck(sessionId, binding, primary, 'thread', 'prepared-primary-turn');
  f.native.acceptNativeExecution(sessionId, binding, primary, 'thread', 'prepared-primary-turn');
  f.native.finish(sessionId, binding, primary.id, 'completed', 'prepared-primary-turn');
  f.runtime.close();
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }));
  const chat = await import('../../chat.js');
  const workspaceRuntime = await import('../../repository-workspace-runtime.js');
  const libraryRuntime = await import('../../agent-library-runtime.js');
  vi.spyOn(workspaceRuntime, 'getRepositoryWorkspaces').mockReturnValue(f.workspace);
  vi.spyOn(libraryRuntime, 'getAgentLibrary').mockReturnValue(f.library);
  const underlying = f.rpc.request.getMockImplementation()!;
  f.rpc.request.mockImplementation(async (method, params?: Record<string, unknown>) => {
    if (method === 'thread/resume')
      return { thread: { id: params?.threadId }, model: 'fixture-model', modelProvider: 'openai' };
    if (method === 'thread/turns/list')
      return { data: [{ id: 'prepared-primary-turn', status: 'completed' }], nextCursor: null };
    if (method === 'turn/start')
      return { turn: { id: `turn-${String(params?.clientUserMessageId)}` } };
    return underlying(method);
  });
  const launch = vi
    .spyOn(CodexAppServerClient, 'launchIsolated')
    .mockReturnValue({ ...f.rpc, close: vi.fn() } as never);
  const { SessionSseRegistry } = await import('../../session-sse-registry.js');
  const { ConnectionRegistry } = await import('@mitzo/harness');
  const { claimTransportConnection, releaseTransportConnection } =
    await import('../../transport-auth-ownership.js');
  const { createOwnedLocalCodexEntryRouter } = await import('../../ordinary-local-codex-entry.js');
  const streams = new SessionSseRegistry();
  const connections = new ConnectionRegistry();
  browser.id = f.dependencies.operatorConnectionId;
  streams.add(
    browser.id,
    { write: vi.fn(() => true), end: vi.fn(), writableEnded: false } as never,
    f.auth.id,
  );
  connections.register(browser.id, { send: vi.fn(), isOpen: () => true });
  claimTransportConnection(browser.id, f.auth.id);
  chat.setConnectionRegistry(connections);
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.authSession = f.auth;
    next();
  });
  app.use(
    '/api/chat/local-codex',
    createOwnedLocalCodexEntryRouter(streams, {
      connRegistry: connections,
      sessionRegistry: chat.registry,
      eventStore: chat.eventStore,
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  cleanups.push(async () => {
    const live = chat.registry.findBySessionId(sessionId);
    if (live) chat.registry.abort(live.clientId);
    await vi.waitFor(() => expect(chat.registry.findBySessionId(sessionId)).toBeFalsy());
    streams.remove(browser.id);
    connections.dispose();
    releaseTransportConnection(browser.id, f.auth.id);
    chat.setConnectionRegistry(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const submissions = new Map<string, Promise<HttpResponse>>();
  const post = (path: string, body: unknown) => {
    const pending = requestHttp(server)
      .post(path)
      .set('Authorization', 'Bearer ' + f.operatorToken)
      .set('Content-Type', 'application/json')
      .set('X-Connection-ID', browser.id)
      .send(JSON.stringify(body))
      .then((response) => response);
    const commandId =
      body && typeof body === 'object' && 'clientMsgId' in body ? body.clientMsgId : undefined;
    if (!path.endsWith('/receipt') && typeof commandId === 'string')
      submissions.set(commandId, pending);
    return pending;
  };
  const waitForDispatch = async (commandId: string) => {
    // The HTTP owner has its own production startup deadline. Only its exact
    // successful receipt releases the separate native acceptance observation.
    await vi.waitFor(() => expect(submissions.has(commandId)).toBe(true), { timeout: 5000 });
    const response = await submissions.get(commandId)!;
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(LocalCodexFirstCommandReceiptSchema.parse(response.body)).toMatchObject({
      sessionId,
      clientMsgId: commandId,
      state: 'consumed',
    });
    return response;
  };
  const pendingBody = options.unadmittedStaleWorkspace
    ? {
        ...originalBody,
        sessionId,
        clientMsgId: `stale-post-adoption-explicit-command-${randomUUID()}`,
        payload: { text: 'so is it not operational now?' },
      }
    : originalBody;
  let saved = JSON.stringify([
    {
      body: pendingBody,
      scope: options.unadmittedStaleWorkspace ? Date.now() : 1,
      uncertain: true,
      ...(options.unadmittedStaleWorkspace
        ? {}
        : { localReceipt: { sessionId, state: 'uncertain' } }),
      composerDraft: { storageKey: 'original-composer', revisionToken: 'submitted-revision' },
    },
  ]);
  const storage = options.storage?.(saved) ?? {
    getItem: () => saved,
    setItem: (_key: string, value: string) => {
      saved = value;
    },
  };
  const requests: Array<{ path: string; body: Record<string, unknown>; status: number }> = [];
  let loseNextResponse = false;
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/api/chat/local-codex/')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const pending = post(path, body);
      const response = await pending;
      requests.push({ path, body, status: response.status });
      if (loseNextResponse && !path.endsWith('/receipt')) {
        loseNextResponse = false;
        throw Error('Offline response lost after server acceptance');
      }
      return Response.json(response.body, { status: response.status });
    }
    if (path.endsWith('/meta')) return Response.json(f.events.getSession(sessionId));
    return Response.json([]);
  });
  const store = createMitzoStore({
    transport: { fetch },
    wsConfig: {
      buildUrl: () => '',
      createWebSocket: () => {
        throw Error('Offline SSE only');
      },
    },
    sseConfig: { baseUrl: '', fetch },
    localFirstCommandConfig: {
      url: '/api/chat/local-codex/send',
      storage,
    },
  });
  await store.getState().switchSession(sessionId);
  return {
    f,
    store,
    sessionId,
    binding,
    originalBody,
    pendingBody,
    originalReceipt,
    originalMetadata,
    adopted,
    primary,
    requests,
    post,
    waitForDispatch,
    launch,
    chat,
    saved: () => JSON.parse(storage.getItem('queue') ?? '[]'),
    reconnect: () => browser.listener({ type: '_foreground' }),
    loseNextResponse: () => {
      loseNextResponse = true;
    },
    async complete(commandId: string, beforeComplete?: () => Promise<void>) {
      await waitForDispatch(commandId);
      await vi.waitFor(
        () =>
          expect(
            f.native.readNativeExecution(sessionId, binding, { id: commandId, attempt: 1 }),
            JSON.stringify({
              commandId,
              status: f.native.commandStatus(sessionId, binding, commandId),
              error: f.events.getLatestEvent(sessionId, 'error')?.payload,
            }),
          ).toMatchObject({ phase: 'accepted' }),
        { timeout: 120000 },
      );
      await beforeComplete?.();
      launch.mock.calls.at(-1)![2]!.onNotification('turn/completed', {
        threadId: f.native.read(sessionId, binding).threadId,
        turn: { id: `turn-${commandId}`, status: 'completed' },
      });
      await vi.waitFor(
        () => expect(f.native.commandStatus(sessionId, binding, commandId)).toBe('completed'),
        { timeout: 30000 },
      );
    },
  };
}
