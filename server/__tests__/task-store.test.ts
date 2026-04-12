import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { TaskStore } from '../task-store.js';

const TEST_DIR = join(tmpdir(), `mitzo-task-store-test-${process.pid}`);

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

describe('TaskStore', () => {
  // --- Create ---

  it('creates a root task with defaults', () => {
    const task = store.create({ title: 'Root task' });
    expect(task.id).toBeTruthy();
    expect(task.title).toBe('Root task');
    expect(task.parentId).toBeNull();
    expect(task.status).toBe('pending');
    expect(task.depth).toBe(0);
    expect(task.priority).toBe(0);
    expect(task.sessionPolicy).toBe('auto');
    expect(task.annotations).toEqual([]);
    expect(task.requiresApproval).toBe(false);
    expect(task.tokenUsage).toBe(0);
    expect(task.createdAt).toBeGreaterThan(0);
    expect(task.updatedAt).toBeGreaterThan(0);
    expect(task.completedAt).toBeNull();
    expect(task.children).toEqual([]);
  });

  it('creates a task with all optional fields', () => {
    const task = store.create({
      title: 'Full task',
      description: 'A description',
      priority: 5,
      sessionPolicy: 'spawn',
      annotations: ['tag1', 'tag2'],
    });
    expect(task.title).toBe('Full task');
    expect(task.description).toBe('A description');
    expect(task.priority).toBe(5);
    expect(task.sessionPolicy).toBe('spawn');
    expect(task.annotations).toEqual(['tag1', 'tag2']);
  });

  it('creates a child task with auto-calculated depth', () => {
    const parent = store.create({ title: 'Parent' });
    const child = store.create({ title: 'Child', parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
    expect(child.depth).toBe(1);

    const grandchild = store.create({ title: 'Grandchild', parentId: child.id });
    expect(grandchild.depth).toBe(2);
  });

  it('throws when creating a child with nonexistent parent', () => {
    expect(() => store.create({ title: 'Orphan', parentId: 'nonexistent' })).toThrow();
  });

  // --- Get ---

  it('gets a task by id', () => {
    const created = store.create({ title: 'Findme' });
    const found = store.get(created.id);
    expect(found).not.toBeNull();
    expect(found!.title).toBe('Findme');
  });

  it('returns null for nonexistent id', () => {
    expect(store.get('nonexistent')).toBeNull();
  });

  // --- Update ---

  it('updates a task title', () => {
    const task = store.create({ title: 'Original' });
    const updated = store.update(task.id, { title: 'Updated' });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('Updated');
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(task.updatedAt);
  });

  it('sets completedAt when status transitions to done', () => {
    const task = store.create({ title: 'Complete me' });
    expect(task.completedAt).toBeNull();

    const updated = store.update(task.id, { status: 'done' });
    expect(updated!.completedAt).not.toBeNull();
    expect(updated!.completedAt).toBeGreaterThan(0);
  });

  it('sets completedAt when status transitions to skipped', () => {
    const task = store.create({ title: 'Skip me' });
    const updated = store.update(task.id, { status: 'skipped' });
    expect(updated!.completedAt).not.toBeNull();
  });

  it('sets completedAt when status transitions to failed', () => {
    const task = store.create({ title: 'Fail me' });
    const updated = store.update(task.id, { status: 'failed' });
    expect(updated!.completedAt).not.toBeNull();
  });

  it('clears completedAt when status transitions from terminal to non-terminal', () => {
    const task = store.create({ title: 'Reopen me' });
    store.update(task.id, { status: 'done' });
    const reopened = store.update(task.id, { status: 'active' });
    expect(reopened!.completedAt).toBeNull();
  });

  it('returns null when updating nonexistent id', () => {
    expect(store.update('nonexistent', { title: 'nope' })).toBeNull();
  });

  it('updates annotations', () => {
    const task = store.create({ title: 'Annotate me' });
    const updated = store.update(task.id, { annotations: ['a', 'b'] });
    expect(updated!.annotations).toEqual(['a', 'b']);
  });

  // --- Delete ---

  it('deletes a task', () => {
    const task = store.create({ title: 'Delete me' });
    expect(store.delete(task.id)).toBe(true);
    expect(store.get(task.id)).toBeNull();
  });

  it('returns false when deleting nonexistent id', () => {
    expect(store.delete('nonexistent')).toBe(false);
  });

  it('cascade deletes children', () => {
    const parent = store.create({ title: 'Parent' });
    const child = store.create({ title: 'Child', parentId: parent.id });
    const grandchild = store.create({ title: 'Grandchild', parentId: child.id });

    expect(store.delete(parent.id)).toBe(true);
    expect(store.get(child.id)).toBeNull();
    expect(store.get(grandchild.id)).toBeNull();
  });

  // --- listRoots ---

  it('lists root tasks ordered by priority DESC then created_at ASC', () => {
    store.create({ title: 'Low', priority: 0 });
    store.create({ title: 'High', priority: 10 });
    store.create({ title: 'Medium', priority: 5 });

    const roots = store.listRoots();
    expect(roots).toHaveLength(3);
    expect(roots[0].title).toBe('High');
    expect(roots[1].title).toBe('Medium');
    expect(roots[2].title).toBe('Low');
  });

  // --- getChildren ---

  it('gets children of a parent', () => {
    const parent = store.create({ title: 'Parent' });
    store.create({ title: 'Child 1', parentId: parent.id });
    store.create({ title: 'Child 2', parentId: parent.id });

    const children = store.getChildren(parent.id);
    expect(children).toHaveLength(2);
  });

  // --- getTree ---

  it('assembles a tree from flat data', () => {
    const root1 = store.create({ title: 'Root 1', priority: 1 });
    store.create({ title: 'Root 2', priority: 0 });
    const child1 = store.create({ title: 'Child 1', parentId: root1.id });
    store.create({ title: 'Grandchild', parentId: child1.id });

    const tree = store.getTree();
    expect(tree).toHaveLength(2);
    // Root 1 has higher priority
    expect(tree[0].title).toBe('Root 1');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].title).toBe('Child 1');
    expect(tree[0].children[0].children).toHaveLength(1);
    expect(tree[0].children[0].children[0].title).toBe('Grandchild');
    expect(tree[1].title).toBe('Root 2');
    expect(tree[1].children).toHaveLength(0);
  });

  // --- getSubtree ---

  it('gets a subtree rooted at a given task', () => {
    const root = store.create({ title: 'Root' });
    const child = store.create({ title: 'Child', parentId: root.id });
    store.create({ title: 'Grandchild', parentId: child.id });
    store.create({ title: 'Other root' });

    const subtree = store.getSubtree(root.id);
    expect(subtree).toHaveLength(1);
    expect(subtree[0].title).toBe('Root');
    expect(subtree[0].children).toHaveLength(1);
    expect(subtree[0].children[0].children).toHaveLength(1);
  });

  it('returns empty array for nonexistent subtree root', () => {
    expect(store.getSubtree('nonexistent')).toEqual([]);
  });

  // --- close ---

  it('can close and reopen', () => {
    const dbPath = join(TEST_DIR, 'reopen.db');
    const store1 = new TaskStore(dbPath);
    store1.create({ title: 'Persist me' });
    store1.close();

    const store2 = new TaskStore(dbPath);
    const roots = store2.listRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].title).toBe('Persist me');
    store2.close();
  });
});
