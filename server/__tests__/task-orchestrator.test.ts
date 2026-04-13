import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { TaskStore } from '../task-store.js';
import { TaskOrchestrator } from '../task-orchestrator.js';
import type { OrchestratorDeps, LoopStatus } from '../task-orchestrator.js';

// Mock sendToChat
vi.mock('../chat.js', () => ({
  sendToChat: vi.fn(() => true),
}));

const TEST_DIR = join(tmpdir(), `mitzo-orchestrator-test-${process.pid}`);

let store: TaskStore;
let orchestrator: TaskOrchestrator;
let mockDeps: OrchestratorDeps;
let broadcastedStatuses: LoopStatus[];

function createTestDeps(store: TaskStore): OrchestratorDeps {
  broadcastedStatuses = [];
  return {
    store,
    getClientId: () => 'test-client',
    setTaskContext: vi.fn(),
    clearTaskContext: vi.fn(),
    broadcastStatus: (s) => broadcastedStatuses.push(s),
    broadcastTasks: vi.fn(),
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  store = new TaskStore(join(TEST_DIR, `tasks-${Date.now()}.db`));
  mockDeps = createTestDeps(store);
  orchestrator = new TaskOrchestrator(mockDeps);
});

afterEach(() => {
  store.close();
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('TaskOrchestrator', () => {
  it('starts in idle state', () => {
    const status = orchestrator.getStatus();
    expect(status.state).toBe('idle');
    expect(status.goalId).toBeNull();
  });

  it('start() transitions to running and assigns first task', () => {
    const goal = store.create({ title: 'Goal' });
    const child = store.create({ title: 'First task', parentId: goal.id });

    orchestrator.start(goal.id);

    const status = orchestrator.getStatus();
    expect(status.state).toBe('running');
    expect(status.goalId).toBe(goal.id);
    expect(status.activeTaskId).toBe(child.id);
    expect(store.get(child.id)!.status).toBe('active');
  });

  it('pause() transitions from running to paused', () => {
    const goal = store.create({ title: 'Goal' });
    store.create({ title: 'Task', parentId: goal.id });

    orchestrator.start(goal.id);
    orchestrator.pause();

    expect(orchestrator.getStatus().state).toBe('paused');
  });

  it('resume() transitions from paused to running', () => {
    const goal = store.create({ title: 'Goal' });
    store.create({ title: 'Task 1', parentId: goal.id });
    store.create({ title: 'Task 2', parentId: goal.id });

    orchestrator.start(goal.id);
    orchestrator.pause();
    orchestrator.resume();

    expect(orchestrator.getStatus().state).toBe('running');
  });

  it('stop() transitions to idle and clears state', () => {
    const goal = store.create({ title: 'Goal' });
    store.create({ title: 'Task', parentId: goal.id });

    orchestrator.start(goal.id);
    orchestrator.stop();

    const status = orchestrator.getStatus();
    expect(status.state).toBe('idle');
    expect(status.goalId).toBeNull();
    expect(status.activeTaskId).toBeNull();
    expect(mockDeps.clearTaskContext).toHaveBeenCalled();
  });

  it('tick assigns deepest-left pending leaf (DFS)', () => {
    const goal = store.create({ title: 'Goal' });
    const parent = store.create({ title: 'Parent', parentId: goal.id });
    const leaf = store.create({ title: 'Leaf', parentId: parent.id });
    store.create({ title: 'Sibling', parentId: goal.id });

    orchestrator.start(goal.id);

    expect(orchestrator.getStatus().activeTaskId).toBe(leaf.id);
    expect(store.get(leaf.id)!.status).toBe('active');
  });

  it('tick does nothing when paused', () => {
    const goal = store.create({ title: 'Goal' });
    store.create({ title: 'Task', parentId: goal.id });

    orchestrator.start(goal.id);
    orchestrator.pause();

    const activeId = orchestrator.getStatus().activeTaskId;
    // Manually call tick — should not change anything
    orchestrator.tick();
    expect(orchestrator.getStatus().activeTaskId).toBe(activeId);
  });

  it('tick transitions to idle when all tasks done', () => {
    const goal = store.create({ title: 'Goal' });
    const child = store.create({ title: 'Only task', parentId: goal.id });

    orchestrator.start(goal.id);

    // Simulate task completion
    store.update(child.id, { status: 'done' });
    store.cascadeStatus(child.id);
    orchestrator.onTaskCompleted(child.id);

    expect(orchestrator.getStatus().state).toBe('idle');
  });

  it('tick skips blocked tasks and finds next', () => {
    const goal = store.create({ title: 'Goal' });
    const c1 = store.create({ title: 'Blocked', parentId: goal.id });
    const c2 = store.create({ title: 'Available', parentId: goal.id });
    store.update(c1.id, { status: 'blocked' });

    orchestrator.start(goal.id);

    expect(orchestrator.getStatus().activeTaskId).toBe(c2.id);
  });

  it('onTaskCompleted triggers tick and assigns next', () => {
    const goal = store.create({ title: 'Goal' });
    const c1 = store.create({ title: 'Task 1', parentId: goal.id });
    const c2 = store.create({ title: 'Task 2', parentId: goal.id });

    orchestrator.start(goal.id);
    expect(orchestrator.getStatus().activeTaskId).toBe(c1.id);

    // Complete first task
    store.update(c1.id, { status: 'done' });
    store.cascadeStatus(c1.id);
    orchestrator.onTaskCompleted(c1.id);

    expect(orchestrator.getStatus().activeTaskId).toBe(c2.id);
  });

  it('onTaskBlocked triggers tick', () => {
    const goal = store.create({ title: 'Goal' });
    const c1 = store.create({ title: 'Task 1', parentId: goal.id });
    const c2 = store.create({ title: 'Task 2', parentId: goal.id });

    orchestrator.start(goal.id);

    store.update(c1.id, { status: 'blocked' });
    store.cascadeStatus(c1.id);
    orchestrator.onTaskBlocked(c1.id);

    expect(orchestrator.getStatus().activeTaskId).toBe(c2.id);
  });

  it('broadcasts status on state changes', () => {
    const goal = store.create({ title: 'Goal' });
    store.create({ title: 'Task', parentId: goal.id });

    orchestrator.start(goal.id);
    expect(broadcastedStatuses.length).toBeGreaterThan(0);
    expect(broadcastedStatuses[0].state).toBe('running');
  });

  it('sets task context on session when assigning', () => {
    const goal = store.create({ title: 'Goal' });
    const child = store.create({ title: 'Task', parentId: goal.id });

    orchestrator.start(goal.id);

    expect(mockDeps.setTaskContext).toHaveBeenCalledWith(child.id, goal.id);
  });

  it('computes progress correctly', () => {
    const goal = store.create({ title: 'Goal' });
    const c1 = store.create({ title: 'Task 1', parentId: goal.id });
    store.create({ title: 'Task 2', parentId: goal.id });
    store.create({ title: 'Task 3', parentId: goal.id });
    store.update(c1.id, { status: 'done' });

    orchestrator.start(goal.id);

    const status = orchestrator.getStatus();
    expect(status.progress).toEqual({ done: 1, total: 3 });
  });

  it('pauses when no executable tasks (all blocked)', () => {
    const goal = store.create({ title: 'Goal' });
    const c1 = store.create({ title: 'Task', parentId: goal.id });
    store.update(c1.id, { status: 'blocked' });

    orchestrator.start(goal.id);

    expect(orchestrator.getStatus().state).toBe('paused');
  });
});
