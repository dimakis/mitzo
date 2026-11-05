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
    commands: vi.fn(() => [{ id: 'queued', status: 'queued' }]),
    cancelQueued: vi.fn(),
    assertRepositoryTaskStopped: vi.fn(),
  };
  const deps = {
    events: {
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
