import { fixture, cleanups, git } from './prepared-repository-native-consumer.js';
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
import { executeTrustedGitCommit } from '../../trusted-native-operation.js';

export const runPublicColdAdmission = async (
  primaryStatus:
    | 'completed'
    | 'interrupted'
    | 'partial-adoption'
    | 'untransferred'
    | 'retained-http'
    | 'tool-rollover'
    | 'tool-rollover-interrupted'
    | 'tool-rollover-queued',
) => {
  const toolRollover = primaryStatus.startsWith('tool-rollover');
  const queuedPrimary = primaryStatus === 'tool-rollover-queued';
  const interruptedPrimary =
    primaryStatus === 'interrupted' || primaryStatus === 'tool-rollover-interrupted';
  const retainedPrimaryStatus = interruptedPrimary ? 'interrupted' : 'completed';
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
  if (
    primaryStatus === 'completed' ||
    primaryStatus === 'interrupted' ||
    (toolRollover && !queuedPrimary)
  ) {
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
    if (interruptedPrimary)
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
    ).toBe(retainedPrimaryStatus);
  }
  if (toolRollover)
    f.native.bindThread(f.first.sessionId, f.first.lease.binding, 'thread', 'pre-deploy-tools');
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
  let request =
    primaryStatus === 'retained-http'
      ? held
      : {
          ...structuredClone(f.request),
          clientMsgId: `public-qualified-cold-${primaryStatus}`,
          payload: { text: 'Continue the same saved task' },
        };
  const queuedPrimaryId = queuedPrimary
    ? f.native.commands(sessionId, binding).find((command) => command.status === 'queued')!.id
    : undefined;
  let firstCommandId = request.clientMsgId;
  let firstTurnId = `public-cold-${firstCommandId}`;
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
  let acknowledge: (() => void) | undefined;
  let replacementGeneration = 1;
  const providerTerminalTurns = new Map([
    ['thread', { id: 'pre-public-turn', status: 'interrupted' }],
  ]);
  const recoveryProbes: Array<{
    threadId: unknown;
    turn: { id: string; status: string } | undefined;
  }> = [];
  f.rpc.request.mockImplementation(async (method, params?: Record<string, unknown>) => {
    if (method === 'thread/resume')
      return { thread: { id: params?.threadId }, model: 'fixture-model', modelProvider: 'openai' };
    if (method === 'thread/start' && toolRollover)
      return {
        thread: { id: `changed-tools-${replacementGeneration}` },
        model: 'fixture-model',
        modelProvider: 'openai',
      };
    if (method === 'thread/turns/list') {
      const turn = providerTerminalTurns.get(String(params?.threadId));
      recoveryProbes.push({ threadId: params?.threadId, turn: turn && { ...turn } });
      return { data: turn ? [{ ...turn }] : [], nextCursor: null };
    }
    if (method === 'turn/start') {
      if (toolRollover && params?.clientUserMessageId === firstCommandId) {
        // Native events may precede the JSON-RPC response. They must cross the
        // real cold-owner bridge while the durable parent and dispatch fence remain.
        const lifecycle = launch.mock.calls.at(-1)![2]!;
        lifecycle.onNotification('turn/started', {
          threadId: params.threadId,
          turn: { id: `public-cold-${String(params.clientUserMessageId)}` },
        });
        await new Promise<void>((resolve) => {
          acknowledge = resolve;
          signalNativeTurnStarted();
        });
      } else signalNativeTurnStarted();
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
    if (queuedPrimaryId)
      expect(f.native.commandStatus(sessionId, binding, queuedPrimaryId)).toBe('cancelled');
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
    expect(
      packets
        .filter(([method]) => method === (toolRollover ? 'thread/start' : 'thread/resume'))
        .at(-1)?.[1],
    ).toMatchObject({
      ...(toolRollover ? {} : { threadId: 'thread' }),
      cwd: result!.directory,
      permissions: 'mitzo-native-agent',
      config: expect.objectContaining({ 'skills.max_context_tokens': 1500 }),
    });
    if (primaryStatus === 'retained-http') {
      expect(packets.filter(([method]) => method === 'turn/start')).toHaveLength(1);
    }
    expect(packets.some(([method]) => method === 'thread/start')).toBe(toolRollover);
    if (toolRollover) {
      expect(f.native.read(sessionId, binding)).toMatchObject({
        threadId: 'thread',
        threadGeneration: 0,
      });
      expect(() => f.native.assertNoPendingThreadDispatch(sessionId, binding)).toThrow(
        'explicit recovery',
      );
      expect(
        f.native.readNativeExecution(sessionId, binding, { id: firstCommandId, attempt: 1 }),
      ).toMatchObject({
        phase: 'prepared',
        threadId: 'changed-tools-1',
        generation: 1,
      });
      expect(acknowledge).toBeTypeOf('function');
      acknowledge!();
    }
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
        const command = f.native.commands(sessionId, binding).find((c) => c.id === firstCommandId)!;
        expect(f.native.readNativeExecution(sessionId, binding, command)).toMatchObject({
          phase: 'accepted',
          turnId: firstTurnId,
        });
        expect(
          f.native.nativeTurnTarget(sessionId, binding, command.id, command.attempt)?.turnId,
        ).toBe(firstTurnId);
      },
      { timeout: 120000 },
    );
    expect(await readFile(retainedEdit, 'utf8')).toBe('Already completed tool effect');
    if (completedPrimary)
      expect(f.native.commandStatus(sessionId, binding, completedPrimary.id)).toBe(
        retainedPrimaryStatus,
      );
    const activeThread = toolRollover ? 'changed-tools-1' : 'thread';
    expect(f.native.read(sessionId, binding).threadId).toBe(activeThread);
    if (toolRollover) {
      expect(f.native.readThreadAcceptances(sessionId, binding)).toMatchObject([
        {
          commandId: firstCommandId,
          attempt: 1,
          threadId: activeThread,
          generation: 1,
          ownershipPending: false,
        },
      ]);
      expect(() => f.native.assertNoPendingThreadDispatch(sessionId, binding)).not.toThrow();
      expect(() => f.native.assertNoPendingThreadOwnership(sessionId, binding)).not.toThrow();
    }
    expect(f.native.read(sessionId, binding).recovery).toBe(0);
    const lifecycle = launch.mock.calls[0][2]!;
    if (toolRollover) {
      // A late terminal event from the retired parent cannot settle the child.
      expect(() =>
        lifecycle.onNotification('turn/completed', {
          threadId: 'thread',
          turn: { id: 'pre-public-turn', status: 'completed' },
        }),
      ).not.toThrow();
      expect(f.native.commandStatus(sessionId, binding, firstCommandId)).toBe('running');
    }
    if (queuedPrimary) {
      // The provider history must advance with the accepted child. Returning
      // the retired parent's terminal identity correctly blocks exact recovery.
      providerTerminalTurns.set(activeThread, { id: firstTurnId, status: 'interrupted' });
      lifecycle.onNotification('turn/completed', {
        threadId: activeThread,
        turn: { id: firstTurnId, status: 'interrupted' },
      });
      await vi.waitFor(
        () =>
          expect(f.native.commandStatus(sessionId, binding, firstCommandId)).toBe('interrupted'),
        { timeout: 30000 },
      );
      const interruptedPrimaryId = firstCommandId;
      const interruptedExecution = f.native.readNativeExecution(sessionId, binding, {
        id: firstCommandId,
        attempt: 1,
      });
      expect(interruptedExecution).toMatchObject({
        phase: 'accepted',
        threadId: activeThread,
        generation: 1,
      });
      if (interruptedExecution?.phase !== 'accepted')
        throw new Error('Expected the interrupted native execution to have been accepted');
      expect(f.native.nativeRecoveryTarget(sessionId, binding)).toMatchObject({
        commandId: firstCommandId,
        threadId: activeThread,
        turnId: firstTurnId,
      });
      const explicit = {
        ...structuredClone(request),
        clientMsgId: 'resume-after-accepted-primary-interruption',
        payload: { text: 'Continue the held work after that interruption' },
      };
      firstCommandId = explicit.clientMsgId;
      firstTurnId = `public-cold-${firstCommandId}`;
      acknowledge = undefined;
      const continuation = chat.sendOwnedLocalCodexCommand({
        sessionId,
        command: explicit,
        operatorConnectionId: f.dependencies.operatorConnectionId,
      });
      await Promise.race([
        vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'), { timeout: 120000 }),
        // Admission may resolve before its asynchronous pump reaches the
        // provider. Only a rejected send may settle this branch of the race.
        continuation.then(() => new Promise<never>(() => {})),
      ]);
      acknowledge!();
      await expect(continuation).resolves.toEqual({ dispatched: true, sessionId });
      expect(recoveryProbes.at(-1)).toEqual({
        threadId: activeThread,
        turn: { id: interruptedExecution!.turnId, status: 'interrupted' },
      });
      await vi.waitFor(
        () =>
          expect(
            f.native.readNativeExecution(sessionId, binding, {
              id: explicit.clientMsgId,
              attempt: 1,
            }),
          ).toMatchObject({ phase: 'accepted', threadId: activeThread, generation: 1 }),
        { timeout: 120000 },
      );
      lifecycle.onNotification('turn/completed', {
        threadId: activeThread,
        turn: { id: firstTurnId, status: 'completed' },
      });
      await vi.waitFor(
        () =>
          expect(f.native.commandStatus(sessionId, binding, explicit.clientMsgId)).toBe(
            'completed',
          ),
        { timeout: 30000 },
      );
      expect(
        f.native.readNativeExecution(sessionId, binding, { id: interruptedPrimaryId, attempt: 1 }),
      ).toEqual(interruptedExecution);
    } else
      lifecycle.onNotification('turn/completed', {
        threadId: activeThread,
        turn: { id: firstTurnId, status: 'completed' },
      });
    await vi.waitFor(
      () =>
        expect(f.native.commandStatus(sessionId, binding, request.clientMsgId)).toBe(
          queuedPrimary ? 'interrupted' : 'completed',
        ),
      { timeout: 30000 },
    );
    if (toolRollover) {
      await expect(
        chat.sendOwnedLocalCodexCommand({
          sessionId,
          command: structuredClone(request),
          operatorConnectionId: f.dependencies.operatorConnectionId,
        }),
      ).resolves.toEqual({ dispatched: false, sessionId });
      const next = {
        ...structuredClone(request),
        clientMsgId: 'after-tool-rollover',
        payload: { text: 'Inspect the result without repeating completed work' },
      };
      await expect(
        chat.sendOwnedLocalCodexCommand({
          sessionId,
          command: next,
          operatorConnectionId: f.dependencies.operatorConnectionId,
        }),
      ).resolves.toEqual({ dispatched: true, sessionId });
      await vi.waitFor(
        () =>
          expect(
            f.native.readNativeExecution(sessionId, binding, { id: next.clientMsgId, attempt: 1 }),
          ).toMatchObject({
            phase: 'accepted',
            threadId: activeThread,
            generation: 1,
          }),
        { timeout: 120000 },
      );
      expect(f.rpc.request.mock.calls.filter(([method]) => method === 'thread/start')).toHaveLength(
        1,
      );
      lifecycle.onNotification('turn/completed', {
        threadId: activeThread,
        turn: { id: `public-cold-${next.clientMsgId}`, status: 'completed' },
      });
      await vi.waitFor(
        () =>
          expect(f.native.commandStatus(sessionId, binding, next.clientMsgId)).toBe('completed'),
        { timeout: 30000 },
      );
      expect(
        packets.filter(
          ([method, params]) =>
            method === 'turn/start' && params?.clientUserMessageId === request.clientMsgId,
        ),
      ).toHaveLength(1);
    }
    registered.session.queryInstance!.close();
    await vi.waitFor(() => expect(chat.registry.findBySessionId(sessionId)).toBeFalsy());
    if (toolRollover) {
      // A second deployment starts from the first child's durable lineage. The
      // previous owner's authorization cannot authorize the new cold owner.
      replacementGeneration = 2;
      f.native.bindThread(sessionId, binding, activeThread, 'another-deploy-tools');
      request = {
        ...structuredClone(request),
        clientMsgId: 'second-cold-tool-rollover',
        payload: { text: 'Continue after another deployment' },
      };
      firstCommandId = request.clientMsgId;
      firstTurnId = `public-cold-${firstCommandId}`;
      acknowledge = undefined;
      await expect(start()).resolves.toMatchObject({ dispatched: true, sessionId });
      await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'), { timeout: 120000 });
      expect(f.native.read(sessionId, binding)).toMatchObject({
        threadId: activeThread,
        threadGeneration: 1,
      });
      acknowledge!();
      await vi.waitFor(
        () =>
          expect(
            f.native.readNativeExecution(sessionId, binding, {
              id: request.clientMsgId,
              attempt: 1,
            }),
          ).toMatchObject({
            phase: 'accepted',
            threadId: 'changed-tools-2',
            generation: 2,
          }),
        { timeout: 120000 },
      );
      expect(f.native.readThreadAcceptances(sessionId, binding)).toMatchObject([
        { threadId: activeThread, generation: 1, ownershipPending: false },
        { threadId: 'changed-tools-2', generation: 2, ownershipPending: false },
      ]);
      const secondLifecycle = launch.mock.calls.at(-1)![2]!;
      await writeFile(
        join(expectedDirectory, 'rollover-selected.txt'),
        'Reviewed change from the new provider generation',
      );
      await writeFile(
        join(expectedDirectory, 'rollover-unselected.txt'),
        'Preserve unrelated dirty work',
      );
      const task = await f.workspace.validateHostTask(sessionId, expectedDirectory);
      await executeTrustedGitCommit(
        expectedDirectory,
        ['rollover-selected.txt'],
        'fix: selected work after cold rollover',
        new AbortController().signal,
        undefined,
        undefined,
        undefined,
        task,
      );
      expect(git(expectedDirectory, 'show', '--format=', '--name-only', 'HEAD')).toBe(
        'rollover-selected.txt',
      );
      expect(git(expectedDirectory, 'status', '--porcelain')).toContain(
        '?? rollover-unselected.txt',
      );
      expect((await f.workspace.validateHostTask(sessionId, expectedDirectory)).directory).toBe(
        expectedDirectory,
      );
      secondLifecycle.onNotification('turn/completed', {
        threadId: 'changed-tools-2',
        turn: { id: `public-cold-${request.clientMsgId}`, status: 'completed' },
      });
      await vi.waitFor(
        () =>
          expect(f.native.commandStatus(sessionId, binding, request.clientMsgId)).toBe('completed'),
        { timeout: 30000 },
      );
      if (primaryStatus === 'tool-rollover-interrupted') {
        const { revokeAuthSession } = await import('../../auth.js');
        const dispatchedBeforeRevocation = f.rpc.request.mock.calls.filter(
          ([method]) => method === 'turn/start',
        ).length;
        revokeAuthSession(f.auth);
        expect(() => secondLifecycle.onNotification('account/rateLimits/updated', {})).toThrow(
          'Owned Codex lifecycle unavailable',
        );
        await expect(
          chat.sendOwnedLocalCodexCommand({
            sessionId,
            command: { ...structuredClone(request), clientMsgId: 'revoked-after-rollover' },
            operatorConnectionId: f.dependencies.operatorConnectionId,
          }),
        ).rejects.toThrow();
        expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(
          dispatchedBeforeRevocation,
        );
      } else chat.registry.findBySessionId(sessionId)!.session.queryInstance!.close();
      await vi.waitFor(() => expect(chat.registry.findBySessionId(sessionId)).toBeFalsy());
      expect(launch).toHaveBeenCalledTimes(2);
      expect(f.rpc.request.mock.calls.filter(([method]) => method === 'thread/start')).toHaveLength(
        2,
      );
      expect(await readFile(retainedEdit, 'utf8')).toBe('Already completed tool effect');
    }
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
