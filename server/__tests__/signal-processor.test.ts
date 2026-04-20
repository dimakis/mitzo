import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { TaskStore } from '../task-store.js';
import { SignalProcessor } from '../signal-processor.js';

const TEST_DIR = join(tmpdir(), `mitzo-signal-test-${process.pid}`);

let store: TaskStore;
let processor: SignalProcessor;
let onResolved: ReturnType<typeof vi.fn<(taskId: string) => void>>;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  store = new TaskStore(join(TEST_DIR, `tasks-${Date.now()}.db`));
  onResolved = vi.fn<(taskId: string) => void>();
  processor = new SignalProcessor(store, onResolved);
});

afterEach(() => {
  processor.unwatchAll();
  store.close();
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('SignalProcessor', () => {
  it('watches and resolves a signal manually', () => {
    const goal = store.create({ title: 'Goal' });
    const task = store.create({
      title: 'Wait for CI',
      parentId: goal.id,
      stageType: 'wait_for_signal',
      gateConfig: { type: 'gh_ci', repo: 'org/repo', pr: 1 },
    });
    store.update(task.id, { status: 'active' });

    processor.watch(task.id, task.gateConfig!);
    expect(processor.isWatching(task.id)).toBe(true);

    processor.resolveSignal(task.id, { status: 'pass', artifacts: { ci: 'green' } });

    const updated = store.get(task.id);
    expect(updated!.status).toBe('done');
    expect(updated!.artifacts).toEqual({ ci: 'green' });
    expect(onResolved).toHaveBeenCalledWith(task.id);
    expect(processor.isWatching(task.id)).toBe(false);
  });

  it('resolves a signal with failure and no retries → failed', () => {
    const goal = store.create({ title: 'Goal' });
    const task = store.create({
      title: 'CI check',
      parentId: goal.id,
      stageType: 'wait_for_signal',
      gateConfig: { type: 'gh_ci', repo: 'org/repo', pr: 1 },
      maxRetries: 0,
    });
    store.update(task.id, { status: 'active' });

    processor.watch(task.id, task.gateConfig!);
    processor.resolveSignal(task.id, { status: 'fail' });

    const updated = store.get(task.id);
    expect(updated!.status).toBe('failed');
    expect(onResolved).toHaveBeenCalledWith(task.id);
  });

  it('retries when max_retries > retry_count and resets preceding sibling', () => {
    const goal = store.create({ title: 'Goal' });
    const agentTask = store.create({
      title: 'Fix code',
      parentId: goal.id,
      stageType: 'agent_work',
      priority: 2,
    });
    store.update(agentTask.id, { status: 'done', summary: 'Fixed things' });

    const signalTask = store.create({
      title: 'Wait for CI',
      parentId: goal.id,
      stageType: 'wait_for_signal',
      gateConfig: { type: 'gh_ci', repo: 'org/repo', pr: 1 },
      maxRetries: 3,
      priority: 1,
    });
    store.update(signalTask.id, { status: 'active' });

    processor.watch(signalTask.id, signalTask.gateConfig!);
    processor.resolveSignal(signalTask.id, { status: 'fail', artifacts: { error: 'tests failed' } });

    const updatedSignal = store.get(signalTask.id);
    expect(updatedSignal!.status).toBe('pending');
    expect(updatedSignal!.retryCount).toBe(1);

    // Preceding agent_work sibling should be reset to pending
    const updatedAgent = store.get(agentTask.id);
    expect(updatedAgent!.status).toBe('pending');

    expect(onResolved).toHaveBeenCalledWith(signalTask.id);
  });

  it('fails after exhausting retries', () => {
    const goal = store.create({ title: 'Goal' });
    const task = store.create({
      title: 'CI check',
      parentId: goal.id,
      stageType: 'wait_for_signal',
      gateConfig: { type: 'gh_ci', repo: 'org/repo', pr: 1 },
      maxRetries: 2,
    });
    // Simulate already retried twice
    store.update(task.id, { status: 'active', retryCount: 2 });

    processor.watch(task.id, task.gateConfig!);
    processor.resolveSignal(task.id, { status: 'fail' });

    const updated = store.get(task.id);
    expect(updated!.status).toBe('failed');
  });

  it('unwatches a signal', () => {
    const goal = store.create({ title: 'Goal' });
    const task = store.create({
      title: 'Wait',
      parentId: goal.id,
      stageType: 'wait_for_signal',
      gateConfig: { type: 'human_approval' },
    });
    store.update(task.id, { status: 'active' });

    processor.watch(task.id, task.gateConfig!);
    expect(processor.isWatching(task.id)).toBe(true);

    processor.unwatch(task.id);
    expect(processor.isWatching(task.id)).toBe(false);
  });

  it('unwatchAll clears everything', () => {
    const goal = store.create({ title: 'Goal' });
    const t1 = store.create({ title: 'W1', parentId: goal.id, stageType: 'wait_for_signal', gateConfig: { type: 'human_approval' } });
    const t2 = store.create({ title: 'W2', parentId: goal.id, stageType: 'wait_for_signal', gateConfig: { type: 'human_approval' } });
    store.update(t1.id, { status: 'active' });
    store.update(t2.id, { status: 'active' });

    processor.watch(t1.id, t1.gateConfig!);
    processor.watch(t2.id, t2.gateConfig!);
    expect(processor.isWatching(t1.id)).toBe(true);
    expect(processor.isWatching(t2.id)).toBe(true);

    processor.unwatchAll();
    expect(processor.isWatching(t1.id)).toBe(false);
    expect(processor.isWatching(t2.id)).toBe(false);
  });

  it('stores failure artifacts in annotations on retry', () => {
    const goal = store.create({ title: 'Goal' });
    const agent = store.create({ title: 'Agent work', parentId: goal.id, stageType: 'agent_work', priority: 2 });
    store.update(agent.id, { status: 'done', summary: 'Done' });

    const signal = store.create({
      title: 'CI',
      parentId: goal.id,
      stageType: 'wait_for_signal',
      gateConfig: { type: 'gh_ci', repo: 'org/repo', pr: 1 },
      maxRetries: 3,
      priority: 1,
    });
    store.update(signal.id, { status: 'active' });

    processor.watch(signal.id, signal.gateConfig!);
    processor.resolveSignal(signal.id, { status: 'fail', artifacts: { failed_checks: ['lint', 'test'] } });

    const updated = store.get(signal.id);
    expect(updated!.annotations).toHaveLength(1);
    expect(updated!.annotations[0]).toContain('retry_0');
    expect(updated!.annotations[0]).toContain('lint');
  });
});
