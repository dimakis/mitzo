import { fixture, cleanups } from './prepared-repository-native-consumer.js';
import express from 'express';
import requestHttp from 'supertest';
import * as nativeFileOperations from '../../native-file-operation.js';
import { CodexAppServerClient } from '../../codex-app-server-client.js';
import { CodexConversation } from '../../codex-conversation.js';
import { expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { codexNativeExecutionPolicy } from '../../codex-native-execution-policy.js';

export const runPublicColdAdmission = async (
  primaryStatus:
    'completed' | 'interrupted' | 'partial-adoption' | 'untransferred' | 'retained-http',
) => {
  vi.spyOn(nativeFileOperations, 'executeNativeAnchoredReadOperation').mockImplementation(
    async () => {
      throw Error('Offline controlled reader must not use a native helper fallback');
    },
  );
  const f = await fixture(true);
  const held = {
    ...structuredClone(f.request),
    clientMsgId: 'held-exact-http-recovery',
    payload: { text: 'Keep this original browser request and my checkout' },
  };
  if (primaryStatus === 'retained-http') await f.runtime.admitContinuation(held);
  const originalHeld =
    primaryStatus === 'retained-http'
      ? f.events.getOrdinaryLocalCommandAdmission(held.clientMsgId)
      : undefined;
  let result: Awaited<ReturnType<typeof f.adopt>>;
  if (primaryStatus === 'untransferred') {
    vi.spyOn(f.workspace, 'adoptPreparedRepositoryTransition').mockImplementationOnce(() => {
      throw Error('Process lost before custody transfer');
    });
    await expect(f.adopt()).rejects.toThrow();
    result = f.workspace.getForConversation(f.first.sessionId) as typeof result;
  } else if (primaryStatus === 'partial-adoption') {
    vi.spyOn(f.native, 'adoptPreparedRepositoryWorkspace').mockImplementationOnce(() => {
      throw Error('Process lost after committed custody');
    });
    await expect(f.adopt()).rejects.toThrow();
    result = f.workspace.getForConversation(f.first.sessionId) as typeof result;
  } else result = await f.adopt();
  f.setCwd(result!.directory);
  const retainedEdit = join(
    primaryStatus === 'untransferred' ? f.record.pendingHostTask!.directory! : result!.directory,
    'retained-before-transport-loss.txt',
  );
  await writeFile(retainedEdit, 'Already completed tool effect');
  let completedPrimary: import('../../codex-conversation-store.js').CodexCommand | undefined;
  if (primaryStatus === 'completed' || primaryStatus === 'interrupted') {
    completedPrimary = f.native.claimNext(f.first.sessionId, f.first.lease.binding)!;
    f.admission.assertBeforeDispatch(completedPrimary.id);
    const completedPolicy = codexNativeExecutionPolicy({
      bindingRevision: f.first.lease.binding.profileRevision!,
      mode: 'agent',
      cwd: result!.directory,
      readableRoots: ['/'],
      writableRoots: [result!.directory],
      deniedRoots: [join(f.root, 'login'), join(f.root, 'custody')],
      writeProtectedRoots: [],
    });
    f.native.prepareNativeExecution(
      f.first.sessionId,
      f.first.lease.binding,
      completedPrimary,
      'thread',
      completedPolicy,
    );
    f.native.recordNativeTurnAck(
      f.first.sessionId,
      f.first.lease.binding,
      completedPrimary,
      'thread',
      'pre-public-turn',
    );
    f.native.acceptNativeExecution(
      f.first.sessionId,
      f.first.lease.binding,
      completedPrimary,
      'thread',
      'pre-public-turn',
    );
    if (primaryStatus === 'interrupted')
      f.native.pauseForRecovery(
        f.first.sessionId,
        f.first.lease.binding,
        completedPrimary.id,
        'interrupted',
        'resume',
        undefined,
        true,
        true,
      );
    else
      f.native.finish(
        f.first.sessionId,
        f.first.lease.binding,
        completedPrimary.id,
        'completed',
        'pre-public-turn',
      );
    expect(
      f.native.commandStatus(f.first.sessionId, f.first.lease.binding, completedPrimary.id),
    ).toBe(primaryStatus);
  }
  f.runtime.close();
  // The real HOST SQLite, chat and native stores were initialized above. Only
  // now select the synthetic Mac route whose artifact/physical/RPC ports this
  // offline positive controls; loading native addons under a spoof would pick
  // the wrong host binary on Linux. afterEach restores the original process.
  // platform is a data property, so use the existing controller stub pattern.
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }));
  const chat = await import('../../chat.js'),
    native = await import('../../codex-chat-session.js');
  const workspaceRuntime = await import('../../repository-workspace-runtime.js'),
    libraryRuntime = await import('../../agent-library-runtime.js');
  vi.spyOn(workspaceRuntime, 'getRepositoryWorkspaces').mockReturnValue(f.workspace);
  vi.spyOn(libraryRuntime, 'getAgentLibrary').mockReturnValue(f.library);
  const sessionId = f.first.sessionId,
    binding = f.first.lease.binding;
  const custody = f.native.readHostCustody(sessionId, binding);
  expect(chat.registry.findBySessionId(sessionId)).toBeFalsy();
  expect(chat.canResumeOwnedLocalCodexDriver(sessionId, f.auth.id)).toBe(true);
  const request =
    primaryStatus === 'retained-http'
      ? held
      : {
          ...structuredClone(f.request),
          clientMsgId: `public-qualified-cold-${primaryStatus}`,
          payload: { text: 'Continue the same saved task' },
        };
  const underlying = f.rpc.request.getMockImplementation()!;
  let signalNativeTurnStarted!: () => void;
  let rejectNativeTurnStarted!: (error: Error) => void;
  let nativeStarted = false;
  const nativeTurnStarted = new Promise<void>((resolve, reject) => {
    signalNativeTurnStarted = () => {
      nativeStarted = true;
      resolve();
    };
    rejectNativeTurnStarted = reject;
  });
  void nativeTurnStarted.catch(() => {});
  f.rpc.request.mockImplementation(async (method, params?: Record<string, unknown>) => {
    if (method === 'thread/resume')
      return { thread: { id: 'thread' }, model: 'fixture-model', modelProvider: 'openai' };
    if (method === 'thread/turns/list')
      return { data: [{ id: 'pre-public-turn', status: 'interrupted' }], nextCursor: null };
    if (method === 'turn/start') {
      signalNativeTurnStarted();
      return { turn: { id: `public-cold-${String(params?.clientUserMessageId)}` } };
    }
    return underlying(method);
  });
  const launch = vi
    .spyOn(CodexAppServerClient, 'launchIsolated')
    .mockReturnValue({ ...f.rpc, close: vi.fn() } as never);
  const clientId =
    primaryStatus === 'retained-http'
      ? `${f.dependencies.operatorConnectionId}:${sessionId}`
      : `public-cold:${sessionId}`;
  cleanups.push(async () => {
    chat.registry.abort(clientId);
    await vi.waitFor(() => expect(chat.registry.findBySessionId(sessionId)).toBeFalsy());
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  let startupFailure: string | undefined;
  const initialize = CodexConversation.prototype.initialize;
  vi.spyOn(CodexConversation.prototype, 'initialize').mockImplementation(async function (
    this: CodexConversation,
  ) {
    try {
      return await initialize.call(this);
    } catch (error) {
      startupFailure = error instanceof Error ? error.message.slice(0, 200) : 'unknown';
      throw error;
    }
  });
  const start = async () => {
    if (primaryStatus !== 'retained-http')
      return chat.startOwnedLocalCodexCommand({ send: vi.fn(), isOpen: () => true }, clientId, {
        command: request,
        reservation: { ...f.reservation, id: result!.id },
        commandId: request.clientMsgId,
        operatorConnectionId: f.dependencies.operatorConnectionId,
        ownerConnectionId: f.dependencies.operatorConnectionId,
        signal: f.signal.signal,
        resume: true,
        onEnded: () => {
          if (!nativeStarted)
            rejectNativeTurnStarted(Error('Owned query ended before native turn start'));
        },
      });
    const { SessionSseRegistry } = await import('../../session-sse-registry.js');
    const { ConnectionRegistry } = await import('@mitzo/harness');
    const { claimTransportConnection, releaseTransportConnection } =
      await import('../../transport-auth-ownership.js');
    const { createOwnedLocalCodexEntryRouter } =
      await import('../../ordinary-local-codex-entry.js');
    const streams = new SessionSseRegistry(),
      connections = new ConnectionRegistry();
    const connectionId = f.dependencies.operatorConnectionId;
    streams.add(
      connectionId,
      { write: vi.fn(() => true), end: vi.fn(), writableEnded: false } as never,
      f.auth.id,
    );
    connections.register(connectionId, { send: vi.fn(), isOpen: () => true });
    claimTransportConnection(connectionId, f.auth.id);
    chat.setConnectionRegistry(connections);
    cleanups.push(() => {
      streams.remove(connectionId);
      connections.dispose();
      releaseTransportConnection(connectionId, f.auth.id);
      chat.setConnectionRegistry(null);
    });
    const originalWire = {
      ...request,
      runOn: 'local',
      sessionId,
      repositoryWorkspaceId: f.reservation.id,
    };
    const serialized = JSON.stringify(originalWire);
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals.authSession = f.auth;
      next();
    });
    app.use(
      createOwnedLocalCodexEntryRouter(streams, {
        connRegistry: connections,
        sessionRegistry: chat.registry,
        eventStore: f.events,
      }),
    );
    const server = app.listen(0, '127.0.0.1');
    try {
      const response = await requestHttp(server)
        .post('/continue')
        .set('Authorization', 'Bearer ' + f.operatorToken)
        .set('Content-Type', 'application/json')
        .set('X-Connection-ID', connectionId)
        .send(serialized);
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      expect(response.body).toMatchObject({
        dispatched: true,
        state: 'consumed',
        clientMsgId: request.clientMsgId,
      });
      expect(JSON.stringify(originalWire)).toBe(serialized);
      const execution = f.events.getOrdinaryLocalCommandExecutionAdmission(request.clientMsgId)!;
      expect(execution.workspace.cwd).toBe(result!.directory);
      expect(
        f.events.getPreparedRepositoryCommandAdmissionEvidence(
          request.clientMsgId,
          execution.preparedRepositoryPrimaryCommandId!,
        ),
      ).toEqual(originalHeld);
      return response.body;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  const attempt = start();
  const evidencePath = join(tmpdir(), `qualified-cold-public-${Date.now()}.json`);
  try {
    await expect(attempt).resolves.toMatchObject({ dispatched: true, sessionId });
  } finally {
    await writeFile(
      evidencePath,
      JSON.stringify(
        { startupFailure, methods: f.rpc.request.mock.calls.map(([method]) => method) },
        null,
        2,
      ),
    );
  }

  const expectedDirectory =
    primaryStatus === 'untransferred' ? f.record.pendingHostTask!.directory! : result!.directory;
  let cleanRetired = false;
  try {
    const registered = chat.registry.findBySessionId(sessionId)!;
    await nativeTurnStarted;
    expect(registered.session.cwd).toBe(expectedDirectory);
    expect(chat.canResumeOwnedLocalCodexDriver(sessionId, f.auth.id)).toBe(false);
    const competitor = { ...request, clientMsgId: 'competing-cold-command' };
    await expect(
      chat.startOwnedLocalCodexCommand({ send: vi.fn(), isOpen: () => true }, 'competing-client', {
        command: competitor,
        reservation: { ...f.reservation, id: result!.id },
        commandId: competitor.clientMsgId,
        operatorConnectionId: f.dependencies.operatorConnectionId,
        signal: f.signal.signal,
        resume: true,
      }),
    ).rejects.toThrow();

    expect(launch).toHaveBeenCalledOnce();
    expect(f.native.readHostCustody(sessionId, binding)).toEqual(custody);
    const packets = f.rpc.request.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
    expect(packets.filter(([method]) => method === 'thread/resume').at(-1)?.[1]).toMatchObject({
      threadId: 'thread',
      cwd: result!.directory,
      permissions: 'mitzo-native-agent',
      config: expect.objectContaining({ 'skills.max_context_tokens': 1500 }),
    });
    if (primaryStatus === 'retained-http') {
      expect(packets.filter(([method]) => method === 'turn/start')).toHaveLength(1);
    }
    expect(packets.some(([method]) => method === 'thread/start')).toBe(false);
    expect(packets.filter(([method]) => method === 'turn/start').at(-1)?.[1]).toMatchObject({
      cwd: expectedDirectory,
    });
    expect(native.getCodexRuntime(registered.session)).toBeDefined();
    // Cold requalification performs real physical checks before dispatch. Await
    // the provider boundary within this journey's existing 420-second limit;
    // the receipt poll below bounds projection after that actual turn/start.
    await nativeTurnStarted;
    await vi.waitFor(
      () => {
        const command = f.native
          .commands(sessionId, binding)
          .find((c) => c.id === request.clientMsgId)!;
        expect(f.native.readNativeExecution(sessionId, binding, command)).toMatchObject({
          phase: 'accepted',
          turnId: `public-cold-${request.clientMsgId}`,
        });
        expect(
          f.native.nativeTurnTarget(sessionId, binding, command.id, command.attempt)?.turnId,
        ).toBe(`public-cold-${request.clientMsgId}`);
      },
      { timeout: 120000 },
    );
    expect(await readFile(retainedEdit, 'utf8')).toBe('Already completed tool effect');
    if (completedPrimary)
      expect(f.native.commandStatus(sessionId, binding, completedPrimary.id)).toBe(primaryStatus);
    expect(f.native.read(sessionId, binding).threadId).toBe('thread');
    expect(f.native.read(sessionId, binding).recovery).toBe(0);
    const lifecycle = launch.mock.calls[0][2]!;
    lifecycle.onNotification('turn/completed', {
      threadId: 'thread',
      turn: { id: `public-cold-${request.clientMsgId}`, status: 'completed' },
    });
    await vi.waitFor(
      () =>
        expect(f.native.commandStatus(sessionId, binding, request.clientMsgId)).toBe('completed'),
      { timeout: 30000 },
    );
    registered.session.queryInstance!.close();
    await vi.waitFor(() => expect(chat.registry.findBySessionId(sessionId)).toBeFalsy());
    expect(chat.eventStore.getSession(sessionId)?.state).toBe('ENDED');
    expect(chat.canResumeOwnedLocalCodexDriver(sessionId, f.auth.id)).toBe(true);
    expect(f.native.readHostCustody(sessionId, binding)).toEqual(custody);
    cleanRetired = true;
  } finally {
    const command = f.native.commands(sessionId, binding).find((c) => c.id === request.clientMsgId);
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          startupFailure,
          methods: f.rpc.request.mock.calls.map(([method]) => method),
          status: command?.status,
          nativeReceiptPhase:
            command && f.native.readNativeExecution(sessionId, binding, command)?.phase,
          registryPresent: !!chat.registry.findBySessionId(sessionId),
          sessionState: chat.eventStore.getSession(sessionId)?.state,
          cleanRetired,
        },
        null,
        2,
      ),
    );
  }
  // Initial adoption, fresh cold admission and outgoing child physical checks
  // retain independent production deadlines; allow the full joined test.
};
