import { afterEach, expect, it, vi } from 'vitest';
import { SessionRegistry } from '@mitzo/harness';
import { EventStore } from '../event-store.js';
import { TaskStore } from '../task-store.js';
import {
  captureTaskToolExecution,
  retainTaskWorkerAllocation,
  TASK_WORKER_ALLOCATION_EVENT,
} from '../task-worker-authority.js';
import { handleTaskArtifact, handleTaskComplete, handleTaskSet } from '../task-tools.js';
vi.mock('../chat.js', () => ({ sendToChat: vi.fn(async () => true) }));
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const tasks = new TaskStore(':memory:');
  const events = new EventStore(':memory:');
  const registry = new SessionRegistry();
  cleanup.push(
    () => tasks.close(),
    () => events.close(),
    () => registry.dispose(),
  );
  const goal = tasks.create({ title: 'Goal' });
  const task = tasks.create({ title: 'Worker', parentId: goal.id, sessionPolicy: 'spawn' });
  const attempts = [
    { operationId: 'old', sessionId: 'native-old', clientId: 'task-worker:old' },
    { operationId: 'new', sessionId: 'native-new', clientId: 'task-worker:new' },
  ];
  const owners = {
    tasks,
    events,
    registry,
    work: () => {
      throw Error('Unmapped ordinary task must not open Telos');
    },
  };
  function allocate(index: number) {
    const attempt = attempts[index];
    const before = tasks.get(task.id)!;
    tasks.update(task.id, {
      status: 'active',
      annotations: [
        ...before.annotations,
        `worker_allocation: ${attempt.operationId}`,
        `worker_conversation: ${attempt.sessionId}`,
      ],
    });
    tasks.setSessionId(task.id, attempt.clientId);
    events.upsertSession({ sessionId: attempt.sessionId });
    events.append(attempt.sessionId, TASK_WORKER_ALLOCATION_EVENT, {
      version: 1,
      taskId: task.id,
      goalId: goal.id,
      operationId: attempt.operationId,
      workerClientId: attempt.clientId,
      conversationId: attempt.sessionId,
    });
    registry.register(attempt.clientId, {
      sessionId: attempt.sessionId,
      abortController: new AbortController(),
      transport: { send() {}, isOpen: () => true },
      mode: 'ask',
      sessionAllowList: new Set(),
    });
    registry.get(attempt.clientId)!.taskContext = {
      currentTaskId: task.id,
      goalId: goal.id,
      workerAllocationId: attempt.operationId,
    };
    return attempt;
  }
  const capture = (clientId: string, sessionId: string) =>
    captureTaskToolExecution(owners, { clientId, expected: { sessionId, taskId: task.id } });
  return { tasks, events, registry, goal, task, attempts, owners, allocate, capture };
}
it('rejects a superseded still-live worker even though its allocation marker remains in task history', () => {
  const f = fixture();
  const old = f.allocate(0);
  const oldScope = f.capture(old.clientId, old.sessionId);
  expect(oldScope).not.toBeNull();
  f.tasks.update(f.task.id, { status: 'pending_review' }); // reviewer rejects/retries this same work item
  const next = f.allocate(1);
  expect(f.tasks.get(f.task.id)?.annotations).toContain('worker_allocation: old');
  expect(f.capture(old.clientId, old.sessionId)).toBeNull();
  expect(() => oldScope!.assertCurrent()).toThrow();
  const current = f.capture(next.clientId, next.sessionId);
  expect(current).not.toBeNull();
  expect(handleTaskArtifact(f.tasks, f.task.id, 'report', 'new result', current!)).toContain(
    'Artifact stored',
  );
  expect(() => handleTaskComplete(f.tasks, f.task.id, 'old result', oldScope!)).toThrow();
  expect(() =>
    handleTaskSet(f.tasks, f.task.id, [{ title: 'Old replacement' }], oldScope!),
  ).toThrow();
  expect(f.tasks.get(f.task.id)?.summary).toBeNull();
  expect(f.tasks.getChildren(f.task.id)).toEqual([]);
  expect(f.tasks.get(f.task.id)?.artifacts).toEqual({ report: 'new result' });
});
it('rechecks actual current ownership at the mutation boundary after intervening work and supports viewer rekey', () => {
  const f = fixture();
  const old = f.allocate(0);
  const captured = f.capture(old.clientId, old.sessionId)!;
  f.registry.rekey(old.clientId, 'reattached-viewer');
  const reattached = f.capture('reattached-viewer', old.sessionId);
  expect(reattached).not.toBeNull();
  expect(f.capture(old.clientId, old.sessionId)).not.toBeNull();
  expect(f.capture('unrelated-viewer', old.sessionId)).toBeNull();
  expect(handleTaskArtifact(f.tasks, f.task.id, 'before', 'accepted', reattached!)).toContain(
    'Artifact stored',
  );
  f.allocate(1);
  expect(() => handleTaskArtifact(f.tasks, f.task.id, 'after', 'stale', captured)).toThrow();
  expect(f.tasks.get(f.task.id)?.artifacts).toEqual({ before: 'accepted' });
});
it('refuses a missing live allocation identity and leaves ordinary reuse tasks unchanged', () => {
  const f = fixture();
  const old = f.allocate(0);
  const live = f.registry.get(old.clientId)!;
  delete live.taskContext!.workerAllocationId;
  expect(f.capture(old.clientId, old.sessionId)).toBeNull();
  f.tasks.update(f.task.id, { annotations: [], sessionPolicy: 'reuse' });
  expect(f.capture(old.clientId, old.sessionId)).toBeNull();
  f.events.upsertSession({ sessionId: 'reuse' });
  f.registry.register('reuse-client', {
    sessionId: 'reuse',
    abortController: new AbortController(),
    transport: { send() {}, isOpen: () => true },
    mode: 'ask',
    sessionAllowList: new Set(),
  });
  f.registry.get('reuse-client')!.taskContext = { currentTaskId: f.task.id, goalId: f.goal.id };
  expect(f.capture('reuse-client', 'reuse')?.taskId).toBe(f.task.id);
});

it('refuses missing or duplicate durable receipts while retaining worker history', () => {
  const f = fixture();
  const old = f.allocate(0);
  const emptyEvents = new EventStore(':memory:');
  cleanup.push(() => emptyEvents.close());
  emptyEvents.upsertSession({ sessionId: old.sessionId });
  expect(
    captureTaskToolExecution(
      { ...f.owners, events: emptyEvents },
      { clientId: old.clientId, expected: { sessionId: old.sessionId, taskId: f.task.id } },
    ),
  ).toBeNull();
  const original = f.events.getEventsOfType(old.sessionId, TASK_WORKER_ALLOCATION_EVENT)[0];
  f.events.append(old.sessionId, TASK_WORKER_ALLOCATION_EVENT, original.payload);
  expect(f.capture(old.clientId, old.sessionId)).toBeNull();
  expect(f.events.getEventsOfType(old.sessionId, TASK_WORKER_ALLOCATION_EVENT)).toHaveLength(2);
  expect(f.tasks.get(f.task.id)?.artifacts).toBeNull();
});

it('rejection and a fresh scheduler retry revoke the old idle worker before it can mutate the replacement attempt', async () => {
  const f = fixture();
  const { TaskOrchestrator } = await import('../task-orchestrator.js');
  f.tasks.update(f.task.id, { requiresApproval: true });
  const allocated: { clientId: string; sessionId: string }[] = [];
  const orchestrator = new TaskOrchestrator({
    store: f.tasks,
    getClientId: () => 'source',
    setTaskContext() {},
    clearTaskContext() {},
    broadcastStatus() {},
    broadcastTasks() {},
    bindWorkerSession: () => async (taskId, _prompt, goalId, _onEnded, scope) => {
      const clientId = `task-worker:${scope.operationId}`,
        sessionId = `native-${scope.operationId}`;
      f.tasks.setSessionId(taskId, clientId);
      f.tasks.update(taskId, {
        annotations: [...f.tasks.get(taskId)!.annotations, `worker_conversation: ${sessionId}`],
      });
      f.events.upsertSession({ sessionId });
      retainTaskWorkerAllocation(f.events, {
        version: 1,
        taskId,
        goalId,
        operationId: scope.operationId,
        workerClientId: clientId,
        conversationId: sessionId,
      });
      f.registry.register(clientId, {
        sessionId,
        mode: 'ask',
        abortController: new AbortController(),
        transport: { send() {}, isOpen: () => true },
        sessionAllowList: new Set(),
      });
      f.registry.get(clientId)!.taskContext = {
        currentTaskId: taskId,
        goalId,
        workerAllocationId: scope.operationId,
      };
      allocated.push({ clientId, sessionId });
      return clientId;
    },
  });
  cleanup.push(() => orchestrator.stop());
  orchestrator.setSpawnEnabled(true);
  orchestrator.start(f.goal.id, { clientId: 'source' });
  await vi.waitFor(() => expect(allocated).toHaveLength(1));
  const old = allocated[0],
    oldEffect = f.capture(old.clientId, old.sessionId)!;
  expect(handleTaskComplete(f.tasks, f.task.id, 'First reviewed attempt', oldEffect)).toContain(
    'pending_review',
  );
  orchestrator.onTaskCompleted(f.task.id);
  expect(orchestrator.rejectTask(f.task.id, 'Use a fresh attempt')).toBe(true);
  await vi.waitFor(() => expect(allocated).toHaveLength(2));
  expect(f.capture(old.clientId, old.sessionId)).toBeNull();
  expect(() =>
    handleTaskArtifact(f.tasks, f.task.id, 'stale', 'must not persist', oldEffect),
  ).toThrow();
  const latest = allocated[1],
    current = f.capture(latest.clientId, latest.sessionId)!;
  expect(handleTaskArtifact(f.tasks, f.task.id, 'current', 'retained evidence', current)).toContain(
    'Artifact stored',
  );
  expect(f.tasks.get(f.task.id)?.artifacts).toEqual({ current: 'retained evidence' });
});
