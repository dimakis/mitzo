import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { TaskStore } from '../task-store.js';
import { TaskOrchestrator } from '../task-orchestrator.js';
import type { OrchestratorDeps } from '../task-orchestrator.js';

// Mock sendToChat
vi.mock('../chat.js', () => ({
  sendToChat: vi.fn(() => true),
}));

const TEST_DIR = join(tmpdir(), `mitzo-loop-routes-test-${process.pid}`);

let store: TaskStore;
let orchestrator: TaskOrchestrator;

function createTestDeps(store: TaskStore): OrchestratorDeps {
  return {
    store,
    getClientId: () => 'test-client',
    setTaskContext: vi.fn(),
    clearTaskContext: vi.fn(),
    broadcastStatus: vi.fn(),
    broadcastTasks: vi.fn(),
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  store = new TaskStore(join(TEST_DIR, `tasks-${Date.now()}.db`));
  orchestrator = new TaskOrchestrator(createTestDeps(store));
});

afterEach(() => {
  store.close();
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('loop orchestrator API (unit)', () => {
  it('getStatus returns idle by default', () => {
    expect(orchestrator.getStatus().state).toBe('idle');
  });

  it('start transitions to running', () => {
    const goal = store.create({ title: 'Goal' });
    store.create({ title: 'Task', parentId: goal.id });

    const status = orchestrator.start(goal.id);
    expect(status.state).toBe('running');
    expect(status.goalId).toBe(goal.id);
  });

  it('start with nonexistent goalId stays idle', () => {
    const status = orchestrator.start('bad-id');
    expect(status.state).toBe('idle');
  });

  it('pause returns paused', () => {
    const goal = store.create({ title: 'Goal' });
    store.create({ title: 'Task', parentId: goal.id });

    orchestrator.start(goal.id);
    const status = orchestrator.pause();
    expect(status.state).toBe('paused');
  });

  it('resume returns running', () => {
    const goal = store.create({ title: 'Goal' });
    store.create({ title: 'T1', parentId: goal.id });
    store.create({ title: 'T2', parentId: goal.id });

    orchestrator.start(goal.id);
    orchestrator.pause();
    const status = orchestrator.resume();
    expect(status.state).toBe('running');
  });

  it('stop returns idle', () => {
    const goal = store.create({ title: 'Goal' });
    store.create({ title: 'Task', parentId: goal.id });

    orchestrator.start(goal.id);
    const status = orchestrator.stop();
    expect(status.state).toBe('idle');
  });

  it('start while running returns current state', () => {
    const goal = store.create({ title: 'Goal' });
    store.create({ title: 'Task', parentId: goal.id });

    orchestrator.start(goal.id);
    const status = orchestrator.start(goal.id);
    expect(status.state).toBe('running');
  });
});
