import { expect, it, vi } from 'vitest';
import { createOpenShellLifecycleProductionAdapter } from '../openshell-lifecycle-production.js';
const record: any = { conversationId: 'c', identity: { threadId: 't' } };
function adapter(overrides: any = {}) {
  return createOpenShellLifecycleProductionAdapter({
    registry: { findBySessionId: () => null, entries: function* () {} },
    eventStore: { getSession: () => undefined },
    taskStore: { getTree: () => [] },
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
    taskStore: { getTree: () => [{ sessionId: 'c', status: 'pending', children: [] }] },
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
    taskStore: { getTree: () => [{ sessionId: 'client-7', status: 'pending', children: [] }] },
    eventStore: { getSession: () => undefined },
  }).protect(record, AbortSignal.timeout(10));
  expect(protection.blockers).toEqual(
    expect.arrayContaining(['task_board', 'inventory_unavailable']),
  );
});
it('forwards isolated reconciliation errors to the production observer', () => {
  const onReconcileError = vi.fn();
  const onOutcome = vi.fn();
  const production = adapter({ onReconcileError, onOutcome });
  expect(production.onReconcileError).toBe(onReconcileError);
  production.onOutcome?.(record, 'stopped');
  expect(onOutcome).toHaveBeenCalledWith('stopped');
});
