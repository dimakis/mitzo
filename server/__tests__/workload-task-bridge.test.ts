/**
 * Integration test: Workload → Task Board bridge lifecycle.
 *
 * Tests the full promote → execute → complete → workload-sync flow
 * using real stores and orchestrator (no HTTP layer).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { TaskStore } from '../task-store.js';
import { WorkloadStore } from '../workload-store.js';
import { TaskOrchestrator } from '../task-orchestrator.js';
import type { OrchestratorDeps, LoopStatus } from '../task-orchestrator.js';

// Mock sendToChat — orchestrator calls it when assigning tasks
vi.mock('../chat.js', () => ({
  sendToChat: vi.fn(() => true),
}));

const TEST_DIR = join(tmpdir(), `mitzo-bridge-test-${process.pid}`);

let taskStore: TaskStore;
let workloadStore: WorkloadStore;
let workloadDb: Database.Database;
let orchestrator: TaskOrchestrator;
let broadcastedStatuses: LoopStatus[];

function createTestDeps(store: TaskStore, wlStore: WorkloadStore): OrchestratorDeps {
  broadcastedStatuses = [];
  return {
    store,
    workloadStore: wlStore,
    getClientId: () => 'test-client',
    setTaskContext: vi.fn(),
    clearTaskContext: vi.fn(),
    broadcastStatus: (s) => broadcastedStatuses.push(s),
    broadcastTasks: vi.fn(),
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  taskStore = new TaskStore(join(TEST_DIR, `tasks-${Date.now()}.db`));
  workloadDb = new Database(':memory:');
  workloadStore = new WorkloadStore(workloadDb);
  const deps = createTestDeps(taskStore, workloadStore);
  orchestrator = new TaskOrchestrator(deps);
});

afterEach(() => {
  taskStore.close();
  workloadDb.close();
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('Workload → Task Board bridge', () => {
  it('completes workload item when linked goal task completes', () => {
    // 1. Create workload item via signal ingestion
    const { item } = workloadStore.ingest({
      sourceType: 'telos',
      sourceId: 'telos-123',
      url: 'https://example.com/telos/123',
      title: 'Implement feature X',
      snippet: 'Build the feature',
      author: 'dimitri',
      timestamp: new Date().toISOString(),
      profile: 'default',
    });

    expect(item.status).toBe('active');
    expect(item.goalId).toBeNull();

    // 2. Promote: create task and link
    const goal = taskStore.create({ title: item.title });
    workloadStore.setGoalId(item.id, goal.id);

    const linkedItem = workloadStore.get(item.id)!;
    expect(linkedItem.goalId).toBe(goal.id);

    // 3. Add subtasks (simulate decomposition)
    const child1 = taskStore.create({ title: 'Step 1', parentId: goal.id });
    const child2 = taskStore.create({ title: 'Step 2', parentId: goal.id });

    // 4. Start orchestrator
    orchestrator.start(goal.id);
    expect(orchestrator.getStatus().state).toBe('running');
    expect(orchestrator.getStatus().activeTaskId).toBe(child1.id);

    // 5. Complete child tasks
    taskStore.update(child1.id, { status: 'done', summary: 'Done step 1' });
    taskStore.cascadeStatus(child1.id);
    orchestrator.onTaskCompleted(child1.id);

    expect(orchestrator.getStatus().activeTaskId).toBe(child2.id);

    taskStore.update(child2.id, { status: 'done', summary: 'Done step 2' });
    taskStore.cascadeStatus(child2.id);
    orchestrator.onTaskCompleted(child2.id);

    // 6. Verify goal is complete
    const finalGoal = taskStore.get(goal.id)!;
    expect(finalGoal.status).toBe('done');

    // 7. Verify workload item was auto-completed
    const finalItem = workloadStore.get(item.id)!;
    expect(finalItem.status).toBe('completed');

    // 8. Verify orchestrator stopped
    expect(orchestrator.getStatus().state).toBe('idle');
  });

  it('does not complete workload item if goal fails', () => {
    // Create and link
    const { item } = workloadStore.ingest({
      sourceType: 'telos',
      sourceId: 'telos-fail',
      url: 'https://example.com/telos/fail',
      title: 'This will fail',
      snippet: 'Should not complete',
      author: 'dimitri',
      timestamp: new Date().toISOString(),
      profile: 'default',
    });

    const goal = taskStore.create({ title: item.title });
    workloadStore.setGoalId(item.id, goal.id);

    const child = taskStore.create({ title: 'Only step', parentId: goal.id });

    // Start and fail the task
    orchestrator.start(goal.id);
    taskStore.update(child.id, { status: 'failed', summary: 'Something broke' });
    taskStore.cascadeStatus(child.id);
    orchestrator.onTaskCompleted(child.id);

    // Goal should be failed
    const finalGoal = taskStore.get(goal.id)!;
    expect(finalGoal.status).toBe('failed');

    // Workload item should NOT be completed (only done triggers completion)
    const finalItem = workloadStore.get(item.id)!;
    expect(finalItem.status).not.toBe('completed');
  });

  it('handles promotion without subtasks (single root goal)', () => {
    const { item } = workloadStore.ingest({
      sourceType: 'telos',
      sourceId: 'telos-simple',
      url: 'https://example.com/telos/simple',
      title: 'Simple task',
      snippet: 'No children needed',
      author: 'dimitri',
      timestamp: new Date().toISOString(),
      profile: 'default',
    });

    const goal = taskStore.create({ title: item.title });
    workloadStore.setGoalId(item.id, goal.id);

    // Complete goal directly (no children)
    taskStore.update(goal.id, { status: 'done', summary: 'Done directly' });
    workloadStore.completeByGoal(goal.id);

    const finalItem = workloadStore.get(item.id)!;
    expect(finalItem.status).toBe('completed');
  });

  it('completeByGoal is idempotent', () => {
    const { item } = workloadStore.ingest({
      sourceType: 'telos',
      sourceId: 'telos-idem',
      url: 'https://example.com/telos/idem',
      title: 'Idempotent test',
      snippet: 'Call complete twice',
      author: 'dimitri',
      timestamp: new Date().toISOString(),
      profile: 'default',
    });

    const goal = taskStore.create({ title: item.title });
    workloadStore.setGoalId(item.id, goal.id);

    // Complete twice — should not throw
    workloadStore.completeByGoal(goal.id);
    workloadStore.completeByGoal(goal.id);

    const finalItem = workloadStore.get(item.id)!;
    expect(finalItem.status).toBe('completed');
  });
});
