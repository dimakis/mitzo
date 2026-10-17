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

  // --- deriveParentStatus ---

  it('derives failed when any child is failed', () => {
    const parent = store.create({ title: 'Parent' });
    store.create({ title: 'C1', parentId: parent.id });
    const c2 = store.create({ title: 'C2', parentId: parent.id });
    store.update(c2.id, { status: 'failed' });

    expect(store.deriveParentStatus(parent.id)).toBe('failed');
  });

  it('derives blocked when any child is blocked (no failed)', () => {
    const parent = store.create({ title: 'Parent' });
    store.create({ title: 'C1', parentId: parent.id });
    const c2 = store.create({ title: 'C2', parentId: parent.id });
    store.update(c2.id, { status: 'blocked' });

    expect(store.deriveParentStatus(parent.id)).toBe('blocked');
  });

  it('derives active when any child is active', () => {
    const parent = store.create({ title: 'Parent' });
    const c1 = store.create({ title: 'C1', parentId: parent.id });
    store.create({ title: 'C2', parentId: parent.id });
    store.update(c1.id, { status: 'active' });

    expect(store.deriveParentStatus(parent.id)).toBe('active');
  });

  it('derives pending_review when any child is pending_review', () => {
    const parent = store.create({ title: 'Parent' });
    const c1 = store.create({ title: 'C1', parentId: parent.id });
    const c2 = store.create({ title: 'C2', parentId: parent.id });
    store.update(c1.id, { status: 'done' });
    store.update(c2.id, { status: 'pending_review' });

    expect(store.deriveParentStatus(parent.id)).toBe('pending_review');
  });

  it('derives done when all children are done or skipped', () => {
    const parent = store.create({ title: 'Parent' });
    const c1 = store.create({ title: 'C1', parentId: parent.id });
    const c2 = store.create({ title: 'C2', parentId: parent.id });
    store.update(c1.id, { status: 'done' });
    store.update(c2.id, { status: 'skipped' });

    expect(store.deriveParentStatus(parent.id)).toBe('done');
  });

  it('derives pending when children are mixed pending', () => {
    const parent = store.create({ title: 'Parent' });
    const c1 = store.create({ title: 'C1', parentId: parent.id });
    store.create({ title: 'C2', parentId: parent.id });
    store.update(c1.id, { status: 'done' });

    expect(store.deriveParentStatus(parent.id)).toBe('pending');
  });

  it('returns own status when task has no children', () => {
    const leaf = store.create({ title: 'Leaf' });
    store.update(leaf.id, { status: 'active' });

    expect(store.deriveParentStatus(leaf.id)).toBe('active');
  });

  // --- cascadeStatus ---

  it('cascades status up the parent chain', () => {
    const root = store.create({ title: 'Root' });
    const mid = store.create({ title: 'Mid', parentId: root.id });
    const leaf = store.create({ title: 'Leaf', parentId: mid.id });
    store.update(leaf.id, { status: 'done' });

    store.cascadeStatus(leaf.id);

    expect(store.get(mid.id)!.status).toBe('done');
    expect(store.get(root.id)!.status).toBe('done');
  });

  it('cascade stops when status unchanged', () => {
    const root = store.create({ title: 'Root' });
    const mid = store.create({ title: 'Mid', parentId: root.id });
    store.create({ title: 'Sibling', parentId: root.id }); // pending sibling keeps root pending
    const leaf = store.create({ title: 'Leaf', parentId: mid.id });
    store.update(leaf.id, { status: 'done' });

    store.cascadeStatus(leaf.id);

    expect(store.get(mid.id)!.status).toBe('done');
    // Root stays pending because of the pending sibling
    expect(store.get(root.id)!.status).toBe('pending');
  });

  // --- getBySession ---

  it('returns tasks assigned to a session', () => {
    const t1 = store.create({ title: 'T1' });
    store.create({ title: 'T2' });
    store.setSessionId(t1.id, 'session-abc');

    const result = store.getBySession('session-abc');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(t1.id);
  });

  it('returns empty array for unknown session', () => {
    expect(store.getBySession('nonexistent')).toEqual([]);
  });

  // --- setSessionId ---

  it('assigns a session to a task', () => {
    const task = store.create({ title: 'Assignable' });
    const updated = store.setSessionId(task.id, 'session-xyz');
    expect(updated!.sessionId).toBe('session-xyz');
    expect(updated!.claimedBy).toBe('session-xyz');
    expect(updated!.claimedAt).toBeGreaterThan(0);
  });

  it('unassigns a session from a task', () => {
    const task = store.create({ title: 'Unassignable' });
    store.setSessionId(task.id, 'session-xyz');
    const cleared = store.setSessionId(task.id, null);
    expect(cleared!.sessionId).toBeNull();
    expect(cleared!.claimedAt).toBeNull();
  });

  // --- getNextExecutable ---

  it('returns the deepest-left pending leaf (DFS)', () => {
    const root = store.create({ title: 'Goal' });
    const c1 = store.create({ title: 'C1', parentId: root.id });
    const c1a = store.create({ title: 'C1a', parentId: c1.id });
    store.create({ title: 'C2', parentId: root.id });

    const next = store.getNextExecutable();
    expect(next!.id).toBe(c1a.id);
  });

  it('skips done subtrees and finds next pending', () => {
    const root = store.create({ title: 'Goal' });
    const c1 = store.create({ title: 'C1', parentId: root.id });
    const c2 = store.create({ title: 'C2', parentId: root.id });
    store.update(c1.id, { status: 'done' });

    const next = store.getNextExecutable();
    expect(next!.id).toBe(c2.id);
  });

  it('skips blocked subtrees', () => {
    const root = store.create({ title: 'Goal' });
    const c1 = store.create({ title: 'C1', parentId: root.id });
    const c2 = store.create({ title: 'C2', parentId: root.id });
    store.update(c1.id, { status: 'blocked' });

    const next = store.getNextExecutable();
    expect(next!.id).toBe(c2.id);
  });

  it('returns null when all tasks are done', () => {
    const root = store.create({ title: 'Goal' });
    const c1 = store.create({ title: 'C1', parentId: root.id });
    store.update(c1.id, { status: 'done' });
    store.update(root.id, { status: 'done' });

    expect(store.getNextExecutable()).toBeNull();
  });

  it('searches within a specific parent subtree', () => {
    const g1 = store.create({ title: 'Goal 1' });
    const g2 = store.create({ title: 'Goal 2' });
    store.create({ title: 'G1-child', parentId: g1.id });
    const g2child = store.create({ title: 'G2-child', parentId: g2.id });

    const next = store.getNextExecutable(g2.id);
    expect(next!.id).toBe(g2child.id);
  });

  // --- getOrphaned ---

  it('finds active tasks with dead sessions', () => {
    const t1 = store.create({ title: 'Active' });
    store.update(t1.id, { status: 'active' });
    store.setSessionId(t1.id, 'dead-session');

    const orphans = store.getOrphaned(new Set(['alive-session']));
    expect(orphans).toHaveLength(1);
    expect(orphans[0].id).toBe(t1.id);
  });

  it('does not include tasks with alive sessions', () => {
    const t1 = store.create({ title: 'Active' });
    store.update(t1.id, { status: 'active' });
    store.setSessionId(t1.id, 'alive-session');

    const orphans = store.getOrphaned(new Set(['alive-session']));
    expect(orphans).toHaveLength(0);
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

  // --- Workflow fields ---

  it('creates a task with workflow fields', () => {
    const task = store.create({
      title: 'Wait for CI',
      stageType: 'wait_for_signal',
      gateConfig: { type: 'gh_ci', repo: 'org/repo', pr: 42 },
      maxRetries: 3,
      templateId: 'pr-triage',
    });
    expect(task.stageType).toBe('wait_for_signal');
    expect(task.gateConfig).toEqual({ type: 'gh_ci', repo: 'org/repo', pr: 42 });
    expect(task.maxRetries).toBe(3);
    expect(task.retryCount).toBe(0);
    expect(task.templateId).toBe('pr-triage');
    expect(task.artifacts).toBeNull();
  });

  it('defaults workflow fields to null/0 for legacy tasks', () => {
    const task = store.create({ title: 'Plain task' });
    expect(task.stageType).toBeNull();
    expect(task.gateConfig).toBeNull();
    expect(task.artifacts).toBeNull();
    expect(task.retryCount).toBe(0);
    expect(task.maxRetries).toBe(0);
    expect(task.templateId).toBeNull();
  });

  it('updates workflow fields', () => {
    const task = store.create({ title: 'Updatable' });
    const updated = store.update(task.id, {
      stageType: 'human_review',
      artifacts: { design_doc: '/path/to/doc.md' },
      retryCount: 2,
      maxRetries: 5,
    });
    expect(updated!.stageType).toBe('human_review');
    expect(updated!.artifacts).toEqual({ design_doc: '/path/to/doc.md' });
    expect(updated!.retryCount).toBe(2);
    expect(updated!.maxRetries).toBe(5);
  });

  it('updates gate_config via update', () => {
    const task = store.create({
      title: 'Signal task',
      stageType: 'wait_for_signal',
      gateConfig: { type: 'gh_ci', repo: 'org/repo', pr: 1 },
    });
    const updated = store.update(task.id, {
      gateConfig: { type: 'gh_review', repo: 'org/repo', pr: 1 },
    });
    expect(updated!.gateConfig).toEqual({ type: 'gh_review', repo: 'org/repo', pr: 1 });
  });

  it('round-trips workflow fields through close and reopen', () => {
    const dbPath = join(TEST_DIR, 'workflow-reopen.db');
    const store1 = new TaskStore(dbPath);
    store1.create({
      title: 'Workflow task',
      stageType: 'wait_for_signal',
      gateConfig: { type: 'gh_ci', repo: 'org/repo', pr: 99 },
      maxRetries: 2,
      templateId: 'upstream-issue',
    });
    store1.close();

    const store2 = new TaskStore(dbPath);
    const roots = store2.listRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].stageType).toBe('wait_for_signal');
    expect(roots[0].gateConfig).toEqual({ type: 'gh_ci', repo: 'org/repo', pr: 99 });
    expect(roots[0].maxRetries).toBe(2);
    expect(roots[0].templateId).toBe('upstream-issue');
    store2.close();
  });

  // --- externalRef ---

  it('creates a task with externalRef', () => {
    const task = store.create({ title: 'Ref task', externalRef: 'pr_shepherd:org/repo#42' });
    expect(task.externalRef).toBe('pr_shepherd:org/repo#42');
  });

  it('defaults externalRef to null', () => {
    const task = store.create({ title: 'No ref' });
    expect(task.externalRef).toBeNull();
  });

  it('getByExternalRef finds a task', () => {
    store.create({ title: 'Findable', externalRef: 'test:find-me' });
    const found = store.getByExternalRef('test:find-me');
    expect(found).not.toBeNull();
    expect(found!.title).toBe('Findable');
  });

  it('getByExternalRef returns null for unknown ref', () => {
    expect(store.getByExternalRef('nonexistent')).toBeNull();
  });

  it('rejects duplicate externalRef', () => {
    store.create({ title: 'First', externalRef: 'unique:ref' });
    expect(() => store.create({ title: 'Second', externalRef: 'unique:ref' })).toThrow();
  });

  it('allows multiple tasks with null externalRef', () => {
    store.create({ title: 'A' });
    store.create({ title: 'B' });
    const roots = store.listRoots();
    expect(roots.length).toBeGreaterThanOrEqual(2);
  });

  it('migrates existing database to add workflow columns', () => {
    // Create a DB without workflow columns, then reopen to trigger migration
    const dbPath = join(TEST_DIR, 'migrate.db');
    const store1 = new TaskStore(dbPath);
    const t = store1.create({ title: 'Pre-migration task' });
    store1.close();

    // Reopen — migration should be idempotent
    const store2 = new TaskStore(dbPath);
    const task = store2.get(t.id);
    expect(task!.stageType).toBeNull();
    expect(task!.gateConfig).toBeNull();
    expect(task!.retryCount).toBe(0);
    expect(task!.maxRetries).toBe(0);
    store2.close();
  });

  it('migrates existing database to add external_ref column', () => {
    const dbPath = join(TEST_DIR, 'migrate-extref.db');
    const store1 = new TaskStore(dbPath);
    const t = store1.create({ title: 'Pre-extref task' });
    store1.close();

    // Reopen — migration 2 should add external_ref
    const store2 = new TaskStore(dbPath);
    const task = store2.get(t.id);
    expect(task!.externalRef).toBeNull();

    // Verify the column works after migration
    const refTask = store2.create({ title: 'With ref', externalRef: 'migrated:ref' });
    expect(refTask.externalRef).toBe('migrated:ref');
    expect(store2.getByExternalRef('migrated:ref')!.id).toBe(refTask.id);
    store2.close();
  });

  it('preserves workflow fields in tree assembly', () => {
    const goal = store.create({ title: 'Goal', stageType: 'agent_work' });
    store.create({
      title: 'Wait step',
      parentId: goal.id,
      stageType: 'wait_for_signal',
      gateConfig: { type: 'gh_ci', repo: 'test/repo', pr: 5 },
    });
    store.create({
      title: 'Review step',
      parentId: goal.id,
      stageType: 'human_review',
    });

    const tree = store.getTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(2);
    expect(tree[0].children[0].stageType).toBe('wait_for_signal');
    expect(tree[0].children[0].gateConfig).toEqual({ type: 'gh_ci', repo: 'test/repo', pr: 5 });
    expect(tree[0].children[1].stageType).toBe('human_review');
  });
});
