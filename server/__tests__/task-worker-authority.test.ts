import { afterEach, expect, it } from 'vitest';
import { SessionRegistry } from '@mitzo/harness';
import { EventStore } from '../event-store.js';
import { TaskStore } from '../task-store.js';
import {
  captureTaskToolExecution,
  TASK_WORKER_ALLOCATION_EVENT,
} from '../task-worker-authority.js';
import { handleTaskArtifact, handleTaskComplete, handleTaskSet } from '../task-tools.js';
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
  expect(handleTaskArtifact(f.tasks, f.task.id, 'before', 'accepted', reattached!)).toContain(
    'Artifact stored',
  );
  f.allocate(1);
  expect(() => handleTaskArtifact(f.tasks, f.task.id, 'after', 'stale', captured)).toThrow();
  expect(f.tasks.get(f.task.id)?.artifacts).toEqual({ before: 'accepted' });
});
it('refuses missing or ambiguous durable worker proof and leaves ordinary reuse tasks unchanged', () => {
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
