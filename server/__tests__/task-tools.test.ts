import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { TaskStore } from '../task-store.js';
import {
  handleTaskSet,
  handleTaskComplete,
  handleTaskStatus,
  handleTaskBlock,
  handleTaskArtifact,
} from '../task-tools.js';

const TEST_DIR = join(tmpdir(), `mitzo-task-tools-test-${process.pid}`);

let store: TaskStore;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  store = new TaskStore(join(TEST_DIR, `tasks-${Date.now()}.db`));
});

afterEach(() => {
  store.close();
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('handleTaskSet', () => {
  it('creates subtasks under the current task', () => {
    const goal = store.create({ title: 'Goal' });
    const result = handleTaskSet(store, goal.id, [
      { title: 'Step 1' },
      { title: 'Step 2', description: 'Details', priority: 5 },
    ]);

    expect(result).toContain('Created 2 subtask(s)');
    const children = store.getChildren(goal.id);
    expect(children).toHaveLength(2);
    expect(children[0].title).toBe('Step 2'); // priority 5 first
    expect(children[1].title).toBe('Step 1');
  });

  it('replaces existing children', () => {
    const goal = store.create({ title: 'Goal' });
    store.create({ title: 'Old child', parentId: goal.id });

    handleTaskSet(store, goal.id, [{ title: 'New child' }]);

    const children = store.getChildren(goal.id);
    expect(children).toHaveLength(1);
    expect(children[0].title).toBe('New child');
  });

  it('returns error for nonexistent task', () => {
    const result = handleTaskSet(store, 'bad-id', [{ title: 'X' }]);
    expect(result).toContain('Error');
  });

  it('returns error for empty task list', () => {
    const goal = store.create({ title: 'Goal' });
    const result = handleTaskSet(store, goal.id, []);
    expect(result).toContain('Error');
  });
});

describe('handleTaskComplete', () => {
  it('marks task as done with summary', () => {
    const goal = store.create({ title: 'Goal' });
    const child = store.create({ title: 'Task', parentId: goal.id });

    const result = handleTaskComplete(store, child.id, 'All done');

    expect(result).toContain('completed');
    const updated = store.get(child.id)!;
    expect(updated.status).toBe('done');
    expect(updated.summary).toBe('All done');
  });

  it('marks task as pending_review when requiresApproval', () => {
    const task = store.create({ title: 'Reviewable' });
    store.update(task.id, { requiresApproval: true });

    const result = handleTaskComplete(store, task.id, 'Please review');

    expect(result).toContain('pending_review');
    expect(store.get(task.id)!.status).toBe('pending_review');
  });

  it('cascades status to parent', () => {
    const parent = store.create({ title: 'Parent' });
    const child = store.create({ title: 'Only child', parentId: parent.id });

    handleTaskComplete(store, child.id, 'Done');

    expect(store.get(parent.id)!.status).toBe('done');
  });

  it('returns error for empty summary', () => {
    const task = store.create({ title: 'Task' });
    const result = handleTaskComplete(store, task.id, '  ');
    expect(result).toContain('Error');
  });
});

describe('handleTaskStatus', () => {
  it('returns formatted status with siblings', () => {
    const parent = store.create({ title: 'Parent' });
    const c1 = store.create({ title: 'Task A', parentId: parent.id });
    const c2 = store.create({ title: 'Task B', parentId: parent.id });
    store.update(c1.id, { status: 'done' });

    const result = handleTaskStatus(store, c2.id);

    expect(result).toContain('Task B');
    expect(result).toContain('[pending]');
    expect(result).toContain('1/2 siblings complete');
    expect(result).toContain('[done] Task A');
  });

  it('returns status for root task without siblings', () => {
    const root = store.create({ title: 'Solo' });
    const result = handleTaskStatus(store, root.id);
    expect(result).toContain('Solo');
    expect(result).not.toContain('Siblings');
  });

  it('returns error for nonexistent task', () => {
    const result = handleTaskStatus(store, 'bad-id');
    expect(result).toContain('Error');
  });
});

describe('handleTaskBlock', () => {
  it('sets status to blocked with reason annotation', () => {
    const parent = store.create({ title: 'Parent' });
    const task = store.create({ title: 'Blockable', parentId: parent.id });

    const result = handleTaskBlock(store, task.id, 'Missing API key');

    expect(result).toContain('blocked');
    expect(result).toContain('Missing API key');

    const updated = store.get(task.id)!;
    expect(updated.status).toBe('blocked');
    expect(updated.annotations).toContain('blocked: Missing API key');
  });

  it('cascades blocked status to parent', () => {
    const parent = store.create({ title: 'Parent' });
    const task = store.create({ title: 'Blockable', parentId: parent.id });

    handleTaskBlock(store, task.id, 'Stuck');

    expect(store.get(parent.id)!.status).toBe('blocked');
  });

  it('returns error for empty reason', () => {
    const task = store.create({ title: 'Task' });
    const result = handleTaskBlock(store, task.id, '  ');
    expect(result).toContain('Error');
  });
});

describe('handleTaskArtifact', () => {
  it('stores an artifact on a task', () => {
    const task = store.create({ title: 'Task' });
    const result = handleTaskArtifact(store, task.id, 'pr_url', 'https://github.com/org/repo/pull/42');

    expect(result).toContain('pr_url');
    expect(result).toContain('https://github.com/org/repo/pull/42');

    const updated = store.get(task.id)!;
    expect(updated.artifacts).toEqual({ pr_url: 'https://github.com/org/repo/pull/42' });
  });

  it('merges with existing artifacts', () => {
    const task = store.create({ title: 'Task' });
    handleTaskArtifact(store, task.id, 'key1', 'val1');
    handleTaskArtifact(store, task.id, 'key2', 'val2');

    const updated = store.get(task.id)!;
    expect(updated.artifacts).toEqual({ key1: 'val1', key2: 'val2' });
  });

  it('overwrites existing artifact key', () => {
    const task = store.create({ title: 'Task' });
    handleTaskArtifact(store, task.id, 'status', 'draft');
    handleTaskArtifact(store, task.id, 'status', 'final');

    const updated = store.get(task.id)!;
    expect(updated.artifacts).toEqual({ status: 'final' });
  });

  it('returns error for nonexistent task', () => {
    const result = handleTaskArtifact(store, 'nonexistent', 'key', 'val');
    expect(result).toContain('Error');
  });

  it('returns error for empty key', () => {
    const task = store.create({ title: 'Task' });
    const result = handleTaskArtifact(store, task.id, '  ', 'val');
    expect(result).toContain('Error');
  });
});
