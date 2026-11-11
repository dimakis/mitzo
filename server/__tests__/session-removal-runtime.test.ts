import { expect, it, vi } from 'vitest';
import { createSessionRemovalRuntime } from '../session-removal-runtime.js';

function fixture() {
  const session = {
    sessionId: 'chat',
    cwd: '/task',
    accountBinding: { accountId: 'a' },
    executionPhase: 'TERMINAL',
  };
  const live = {
    clientId: 'client',
    session: {
      turnInProgress: false,
      ordinaryRuntimeOwner: { close: vi.fn() },
      queryInstance: { interrupt: vi.fn(async () => {}) },
    },
  };
  const native = {
    hasConversation: vi.fn(() => true),
    commands: vi.fn(() => [{ id: 'queued', status: 'queued' }]),
    cancelQueued: vi.fn(),
    assertRepositoryTaskStopped: vi.fn(),
  };
  const deps = {
    events: {
      deployment: { maintenance: { assertControl: vi.fn() } },
      getSession: vi.fn(() => session),
      getSessionRuntimeBinding: vi.fn(() => ({
        version: 2,
        execution: { location: 'local' },
        harness: { implementation: 'codex' },
      })),
      getEventsOfType: vi.fn(() => []),
      hasUncertainOrdinaryCommand: vi.fn(() => false),
      getPendingOrdinaryLocalVertexCommandIds: vi.fn(() => []),
      cancelOrdinaryLocalVertexQueuedCommand: vi.fn(),
      upsertSession: vi.fn(),
      getOrdinaryWorkspaceSessionPreparationForConversation: vi.fn(() => undefined as unknown),
      getOrdinaryInitialCommandId: vi.fn(() => undefined as unknown),
      getLatestOrdinaryCommandAdmission: vi.fn(() => undefined as unknown),
      hasRecentSendCommandForSession: vi.fn(() => false),
      assertPreparedOrdinaryWorkspaceSession: vi.fn(),
      removals: { read: vi.fn(() => ({ phase: 'closing' }) as unknown) },
    },
    registry: {
      findBySessionId: vi.fn(() => live as typeof live | undefined),
      entries: vi.fn(() => [][Symbol.iterator]()),
      abortStartup: vi.fn(() => false),
      markUserClose: vi.fn(),
    },
    tasks: { getTree: vi.fn(() => []), getTelosExecutionBinding: vi.fn(() => null) },
    native: () => native,
    stop: vi.fn(() => {
      deps.registry.findBySessionId.mockReturnValue(undefined);
    }),
  };
  const runtime = createSessionRemovalRuntime(deps as never);
  return { runtime, deps, native, live, session };
}
it('cancels retained queued commands, closes the idle driver and verifies native settlement', async () => {
  const f = fixture();
  await f.runtime.closeRuntime('chat');
  expect(f.native.cancelQueued).toHaveBeenCalledWith('chat', f.session.accountBinding, 'queued');
  expect(f.live.session.ordinaryRuntimeOwner.close).toHaveBeenCalledTimes(1);
  expect(f.live.session.queryInstance.interrupt).not.toHaveBeenCalled();
  f.runtime.assertSettled('chat');
  expect(f.native.assertRepositoryTaskStopped).toHaveBeenCalled();
});
it('does not call stopped data safe merely because the runtime disappeared', () => {
  const f = fixture();
  f.deps.registry.findBySessionId.mockReturnValue(undefined);
  f.native.assertRepositoryTaskStopped.mockImplementation(() => {
    throw Error('pending tool');
  });
  expect(() => f.runtime.assertSettled('chat')).toThrow(/pending tool/);
});
it('rechecks quarantine at the native queued-command cancellation boundary', async () => {
  const f = fixture();
  f.deps.events.deployment.maintenance.assertControl
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw Error('Historical execution is quarantined');
    });
  await expect(f.runtime.closeRuntime('chat')).rejects.toThrow(/quarantined/);
  expect(f.native.cancelQueued).not.toHaveBeenCalled();
  expect(f.live.session.ordinaryRuntimeOwner.close).not.toHaveBeenCalled();
});
it('rejects Symposium and retained task-board custody before teardown', () => {
  const f = fixture();
  Object.assign(f.session, { sessionType: 'symposium' });
  expect(() => f.runtime.assertProtected('chat')).toThrow(/shared/);
  Object.assign(f.session, { sessionType: 'ordinary' });
  f.deps.tasks.getTree.mockReturnValue([
    { id: 'task', status: 'active', sessionId: 'chat', children: [] },
  ] as never);
  expect(() => f.runtime.assertProtected('chat')).toThrow(/Task Board/);
  expect(f.deps.stop).not.toHaveBeenCalled();
});
function neverStarted() {
  const f = fixture();
  Object.assign(f.session, { ordinaryWorkspaceId: 'workspace', executionPhase: null });
  f.deps.registry.findBySessionId.mockReturnValue(undefined);
  f.native.hasConversation.mockReturnValue(false);
  f.deps.events.getOrdinaryWorkspaceSessionPreparationForConversation.mockReturnValue({
    sessionId: 'chat',
    workspaceId: 'workspace',
    allocationOperationId: 'allocation',
    firstCommandId: null,
    settings: { selection: {} },
  });
  return f;
}
it('settles only exact never-started preparations under the durable removal fence without reading absent native history', async () => {
  const f = neverStarted();
  await f.runtime.closeRuntime('chat');
  expect(f.deps.events.assertPreparedOrdinaryWorkspaceSession).toHaveBeenCalledWith(
    'allocation',
    expect.objectContaining({ sessionId: 'chat', ordinaryWorkspaceId: 'workspace' }),
    expect.any(Object),
    {},
  );
  expect(f.native.commands).not.toHaveBeenCalled();
  expect(f.native.assertRepositoryTaskStopped).not.toHaveBeenCalled();
  expect(f.deps.events.upsertSession).toHaveBeenCalledWith({
    sessionId: 'chat',
    isActive: false,
    closedBy: 'user',
  });
});
it.each([
  'missing-preparation',
  'missing-fence',
  'ordinary-command',
  'send-command',
  'execution',
  'uncertain',
] as const)(
  'preserves absent native data when %s prevents proof of unused preparation',
  async (reason) => {
    const f = neverStarted();
    if (reason === 'missing-preparation')
      f.deps.events.getOrdinaryWorkspaceSessionPreparationForConversation.mockReturnValue(
        undefined,
      );
    if (reason === 'missing-fence') f.deps.events.removals.read.mockReturnValue(undefined);
    if (reason === 'ordinary-command')
      f.deps.events.getOrdinaryInitialCommandId.mockReturnValue('command');
    if (reason === 'send-command')
      f.deps.events.hasRecentSendCommandForSession.mockReturnValue(true);
    if (reason === 'execution') Object.assign(f.session, { executionPhase: 'TERMINAL' });
    if (reason === 'uncertain') f.deps.events.hasUncertainOrdinaryCommand.mockReturnValue(true);
    await expect(f.runtime.closeRuntime('chat')).rejects.toThrow(/proof|unverified/i);
    expect(f.deps.events.upsertSession).not.toHaveBeenCalled();
  },
);
it('cancels tracked startup and keeps its cleanup blocker when no native conversation exists', async () => {
  const f = neverStarted();
  f.deps.registry.abortStartup.mockReturnValue(true);
  await expect(f.runtime.closeRuntime('chat')).rejects.toThrow(/Startup was cancelled/i);
  expect(f.native.commands).not.toHaveBeenCalled();
  expect(f.deps.events.upsertSession).not.toHaveBeenCalled();
});
