import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenShellLifecycleProductionAdapter } from '../openshell-lifecycle-production.js';
import { TaskStore } from '../task-store.js';
const record: any = { conversationId: 'c', identity: { threadId: 't' } };
function adapter(overrides: any = {}) {
  return createOpenShellLifecycleProductionAdapter({
    registry: { findBySessionId: () => null, entries: function* () {} },
    eventStore: { getSession: () => undefined },
    taskStore: { getTree: () => [], getTelosExecutionBinding: () => null },
    queue: () => ({ queued: 0, running: 0, recovery: false }),
    inspect: async () => undefined,
    stop: async () => {},
    delete: async () => {},
    checkpoint: async () => null,
    verifyCheckpoint: async () => false,
    ...overrides,
  });
}
it('blocks active sessions, queue recovery, task ownership, and Symposium', async () => {
  const protection = await adapter({
    registry: { findBySessionId: () => ({}), entries: function* () {} },
    queue: () => ({ queued: 1, running: 0, recovery: true }),
    taskStore: {
      getTree: () => [{ id: 'legacy-task', sessionId: 'c', status: 'pending', children: [] }],
      getTelosExecutionBinding: () => null,
    },
    eventStore: { getSession: () => ({ symposiumConfig: '{}', sessionType: 'symposium' }) },
  }).protect(record, AbortSignal.timeout(10));
  expect(protection.blockers).toEqual(
    expect.arrayContaining(['active_session', 'queued_work', 'task_board', 'symposium']),
  );
});
it('fails closed when an authoritative reader throws or identity is missing', async () => {
  expect(
    (
      await adapter({
        queue: () => {
          throw new Error('db');
        },
      }).protect(record, AbortSignal.timeout(10))
    ).blockers,
  ).toEqual(['inventory_unavailable']);
  expect(
    (await adapter().protect({ conversationId: 'c' } as any, AbortSignal.timeout(10))).blockers,
  ).toEqual(['ambiguous_ownership']);
});
it('resolves Task Board client ownership to its durable conversation and blocks missing event state', async () => {
  const protection = await adapter({
    registry: {
      findBySessionId: () => null,
      entries: function* () {
        yield ['client-7', { sessionId: 'c' }];
      },
    },
    taskStore: {
      getTree: () => [
        { id: 'legacy-task', sessionId: 'client-7', status: 'pending', children: [] },
      ],
      getTelosExecutionBinding: () => null,
    },
    eventStore: { getSession: () => undefined },
  }).protect(record, AbortSignal.timeout(10));
  expect(protection.blockers).toEqual(
    expect.arrayContaining(['task_board', 'inventory_unavailable']),
  );
});
it('scopes unresolved nonterminal Task Board ownership to the lifecycle record', async () => {
  const related = await adapter({
    registry: { findBySessionId: () => null, entries: function* () {} },
    taskStore: {
      getTree: () => [
        { id: 'legacy-task', sessionId: 'client-c', status: 'pending', children: [] },
      ],
      getTelosExecutionBinding: () => null,
    },
    eventStore: { getSession: () => ({}) },
  }).protect({ ...record, ownerClientId: 'client-c' }, AbortSignal.timeout(10));
  expect(related.blockers).toEqual(expect.arrayContaining(['task_board', 'ambiguous_ownership']));

  const unrelated = await adapter({
    registry: { findBySessionId: () => null, entries: function* () {} },
    taskStore: {
      getTree: () => [
        { id: 'legacy-task', sessionId: 'other-client', status: 'pending', children: [] },
      ],
      getTelosExecutionBinding: () => null,
    },
    eventStore: { getSession: () => ({}) },
  }).protect({ ...record, ownerClientId: 'client-c' }, AbortSignal.timeout(10));
  expect(unrelated.blockers).toEqual([]);
});
it.each([undefined, ''])(
  'does not treat a live client with unresolved conversation %s as unrelated to an ownerless record',
  async (sessionId) => {
    const protection = await adapter({
      registry: {
        findBySessionId: () => null,
        entries: function* () {
          yield ['client-c', { sessionId }];
        },
      },
      taskStore: {
        getTree: () => [{ id: 'task', sessionId: 'client-c', status: 'blocked', children: [] }],
        getTelosExecutionBinding: () => null,
      },
      eventStore: { getSession: () => ({}) },
    }).protect({ ...record, ownerClientId: null }, AbortSignal.timeout(1000));
    expect(protection.blockers).toEqual(
      expect.arrayContaining(['task_board', 'ambiguous_ownership']),
    );
  },
);
it.each(['conversation', 'durable-client', 'live-client'])(
  'preserves %s ownership even when another delegated worker binding conflicts',
  async (kind) => {
    const owner = kind === 'conversation' ? 'c' : 'client-c';
    const protection = await adapter({
      registry: {
        findBySessionId: () => null,
        entries: function* () {
          if (kind === 'live-client') yield ['client-c', { sessionId: 'c' }];
        },
      },
      taskStore: {
        getTree: () => [{ id: 'task', sessionId: owner, status: 'blocked', children: [] }],
        getTelosExecutionBinding: () => ({ workerConversationId: 'other-conversation' }),
      },
      eventStore: { getSession: () => ({}) },
    }).protect(
      { ...record, ownerClientId: kind === 'durable-client' ? owner : null },
      AbortSignal.timeout(1000),
    );
    expect(protection.blockers).toContain('task_board');
  },
);
it('does not assign unclaimed Task Board work to an ownerless lifecycle record', async () => {
  const protection = await adapter({
    taskStore: {
      getTree: () => [{ id: 'task', sessionId: null, status: 'pending', children: [] }],
      getTelosExecutionBinding: () => null,
    },
    eventStore: { getSession: () => ({}) },
  }).protect({ ...record, ownerClientId: null }, AbortSignal.timeout(1000));
  expect(protection.blockers).toEqual([]);
});
it.each(['pending', 'pending_review', 'done', 'skipped', 'failed'] as const)(
  'preserves durable delegated worker custody for %s tasks without claiming or dispatching them',
  async (status) => {
    const root = mkdtempSync(join(tmpdir(), 'lifecycle-telos-custody-'));
    const path = join(root, 'tasks.db');
    let store = new TaskStore(path);
    try {
      const task = store.createOrRecoverTelosExecutionTask(
        { title: 'Exact reviewed slice' },
        {
          attemptId: 'attempt',
          childItemId: 'slice',
          leadConversationId: 'lead',
          workerConversationId: 'c',
          contextSnapshotId: 'context',
          contextHash: 'a'.repeat(64),
        },
      );
      store.update(task.id, { status });
      store.close();
      store = new TaskStore(path);
      const before = store.get(task.id);
      const binding = store.getTelosExecutionBinding(task.id);
      expect(before).toMatchObject({ status, sessionId: null });
      const production = adapter({
        taskStore: store,
        eventStore: { getSession: () => ({}) },
      });
      const related = await production.protect(record, AbortSignal.timeout(1000));
      expect(related.blockers).toEqual(
        status === 'pending' || status === 'pending_review' ? ['task_board'] : [],
      );
      const unrelated = await production.protect(
        { ...record, conversationId: 'another-worker' },
        AbortSignal.timeout(1000),
      );
      expect(unrelated.blockers).toEqual([]);
      expect(store.get(task.id)).toEqual(before);
      expect(store.getTelosExecutionBinding(task.id)).toEqual(binding);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
it('retains resources when the durable delegated task owner cannot be read', async () => {
  const protection = await adapter({
    taskStore: {
      getTree: () => [{ id: 'task', sessionId: null, status: 'pending', children: [] }],
      getTelosExecutionBinding: () => {
        throw new Error('Task ownership unavailable');
      },
    },
    eventStore: { getSession: () => ({}) },
  }).protect(record, AbortSignal.timeout(1000));
  expect(protection.blockers).toEqual(['inventory_unavailable']);
});
it('forwards isolated reconciliation errors to the production observer', () => {
  const onReconcileError = vi.fn();
  const onOutcome = vi.fn();
  const production = adapter({ onReconcileError, onOutcome });
  expect(production.onReconcileError).toBe(onReconcileError);
  production.onOutcome?.(record, 'stopped');
  expect(onOutcome).toHaveBeenCalledWith('stopped');
});
