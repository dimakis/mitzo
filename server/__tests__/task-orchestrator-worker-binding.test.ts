import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../task-store.js';
import { TaskOrchestrator, type TaskWorkerSession } from '../task-orchestrator.js';
vi.mock('../chat.js', () => ({ sendToChat: vi.fn() }));
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-task-worker-binding-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.db'));
  cleanup.push(() => store.close());
  const goal = store.create({ title: 'Goal', description: '' });
  const task = store.create({
    title: 'Work',
    description: '',
    parentId: goal.id,
    sessionPolicy: 'spawn',
  });
  const spawn = vi.fn<TaskWorkerSession>(async () => 'worker-client');
  const capture = vi.fn(() => spawn);
  const loop = new TaskOrchestrator({
    store,
    getClientId: () => null,
    setTaskContext: vi.fn(),
    clearTaskContext: vi.fn(),
    broadcastTasks: vi.fn(),
    broadcastStatus: vi.fn(),
    bindWorkerSession: capture,
  });
  cleanup.push(() => loop.stop());
  loop.setSpawnEnabled(true);
  return { store, goal, task, loop, spawn, capture };
}

it('requires a selected source chat before worker admission and captures it once per run', async () => {
  const f = fixture();
  expect(f.loop.requiresClientId(f.goal.id)).toBe(true);
  expect(f.loop.start(f.goal.id).state).toBe('idle');
  expect(f.capture).not.toHaveBeenCalled();
  f.loop.start(f.goal.id, { clientId: 'selected-source' });
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledTimes(1));
  expect(f.capture).toHaveBeenCalledExactlyOnceWith('selected-source');
  expect(f.spawn).toHaveBeenCalledWith(
    f.task.id,
    expect.any(String),
    f.goal.id,
    expect.any(Function),
    expect.objectContaining({ signal: expect.any(AbortSignal), operationId: expect.any(String) }),
  );
  const retained = f.store.get(f.task.id)!;
  const operationId = f.spawn.mock.calls[0][4].operationId;
  expect(retained.annotations).toContain(`worker_allocation: ${operationId}`);
});

it('aborts an in-flight worker admission on Stop without restarting it', async () => {
  const f = fixture();
  f.spawn.mockImplementationOnce(() => new Promise(() => {}));
  f.loop.start(f.goal.id, { clientId: 'selected-source' });
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledTimes(1));
  const signal = f.spawn.mock.calls[0][4].signal;
  f.loop.stop();
  expect(signal.aborted).toBe(true);
  expect(f.spawn).toHaveBeenCalledTimes(1);
});

it('retains admitted worker uncertainty on restart instead of reclaiming and replaying effects', async () => {
  const f = fixture();
  f.store.update(f.task.id, {
    status: 'active',
    annotations: ['worker_allocation: 7aa6a744-d27c-4eca-a49c-bde6c305ab10'],
  });
  f.store.setSessionId(f.task.id, 'missing-old-worker');
  const spawn = vi.fn();
  const recovered = new TaskOrchestrator({
    store: f.store,
    getClientId: () => null,
    getActiveSessionIds: () => new Set(),
    setTaskContext: vi.fn(),
    clearTaskContext: vi.fn(),
    broadcastTasks: vi.fn(),
    broadcastStatus: vi.fn(),
    bindWorkerSession: () => spawn,
  });
  cleanup.push(() => recovered.stop());
  recovered.setSpawnEnabled(true);
  recovered.start(f.goal.id, { clientId: 'selected-source' });
  await Promise.resolve();
  expect(f.store.get(f.task.id)?.status).toBe('blocked');
  expect(f.store.get(f.task.id)?.sessionId).toBe('missing-old-worker');
  expect(f.store.get(f.task.id)?.annotations).toContain(
    'worker_error: retained worker outcome is unconfirmed; inspect its conversation before explicitly retrying',
  );
  expect(spawn).not.toHaveBeenCalled();
});
