import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { TaskStore } from '../task-store.js';
import { buildTaskContextPrompt, buildTaskSystemPrompt } from '../task-context.js';

const TEST_DIR = join(tmpdir(), `mitzo-task-context-test-${process.pid}`);

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

describe('buildTaskContextPrompt', () => {
  it('returns null for nonexistent task', () => {
    expect(buildTaskContextPrompt(store, 'bad-id')).toBeNull();
  });

  it('builds context for a root task', () => {
    const task = store.create({ title: 'My Goal' });
    const ctx = buildTaskContextPrompt(store, task.id)!;

    expect(ctx).toContain('<task-context>');
    expect(ctx).toContain(`id="${task.id}"`);
    expect(ctx).toContain('depth="0"');
    expect(ctx).toContain('<title>My Goal</title>');
    expect(ctx).not.toContain('<parent');
    expect(ctx).not.toContain('<siblings');
  });

  it('includes parent and sibling context for child task', () => {
    const parent = store.create({ title: 'Goal' });
    const c1 = store.create({ title: 'Step 1', parentId: parent.id });
    const c2 = store.create({ title: 'Step 2', parentId: parent.id });
    store.update(c1.id, { status: 'done' });

    const ctx = buildTaskContextPrompt(store, c2.id)!;

    expect(ctx).toContain('<parent title="Goal"');
    expect(ctx).toContain('<siblings>');
    expect(ctx).toContain('current="true"');
    expect(ctx).toContain('status="done"');
  });

  it('includes completed sibling summaries', () => {
    const parent = store.create({ title: 'Goal' });
    const c1 = store.create({ title: 'Done task', parentId: parent.id });
    const c2 = store.create({ title: 'Current', parentId: parent.id });
    store.update(c1.id, { status: 'done', summary: 'Did the thing' });

    const ctx = buildTaskContextPrompt(store, c2.id)!;

    expect(ctx).toContain('<completed-siblings>');
    expect(ctx).toContain('Did the thing');
  });

  it('truncates long summaries', () => {
    const parent = store.create({ title: 'Goal' });
    const c1 = store.create({ title: 'Verbose', parentId: parent.id });
    const c2 = store.create({ title: 'Current', parentId: parent.id });
    const longSummary = 'x'.repeat(2500);
    store.update(c1.id, { status: 'done', summary: longSummary });

    const ctx = buildTaskContextPrompt(store, c2.id)!;

    expect(ctx).toContain('...');
    expect(ctx.length).toBeLessThan(3000);
  });

  it('returns depth error for tasks at max depth', () => {
    let parentId: string | undefined;
    for (let i = 0; i < 5; i++) {
      const t = store.create({ title: `Level ${i}`, parentId });
      parentId = t.id;
    }
    const deep = store.create({ title: 'Too deep', parentId });

    const ctx = buildTaskContextPrompt(store, deep.id)!;
    expect(ctx).toContain('<error>');
    expect(ctx).toContain('exceeds maximum');
  });

  it('escapes XML special characters', () => {
    const task = store.create({ title: 'Fix <script> & "quotes"' });
    const ctx = buildTaskContextPrompt(store, task.id)!;

    expect(ctx).toContain('&lt;script&gt;');
    expect(ctx).toContain('&amp;');
    expect(ctx).toContain('&quot;quotes&quot;');
  });

  it('includes sibling artifacts in context', () => {
    const goal = store.create({ title: 'Goal' });
    const s1 = store.create({ title: 'Create PR', parentId: goal.id, priority: 2 });
    store.update(s1.id, {
      status: 'done',
      summary: 'Created PR #42',
      artifacts: { pr_url: 'https://github.com/org/repo/pull/42' },
    });
    const s2 = store.create({ title: 'Check CI', parentId: goal.id, priority: 1 });

    const ctx = buildTaskContextPrompt(store, s2.id)!;
    expect(ctx).toContain('<sibling-artifacts>');
    expect(ctx).toContain('key="pr_url"');
    expect(ctx).toContain('https://github.com/org/repo/pull/42');
  });

  it('omits sibling-artifacts when none exist', () => {
    const goal = store.create({ title: 'Goal' });
    const s1 = store.create({ title: 'Step 1', parentId: goal.id, priority: 2 });
    store.update(s1.id, { status: 'done', summary: 'Done' });
    const s2 = store.create({ title: 'Step 2', parentId: goal.id, priority: 1 });

    const ctx = buildTaskContextPrompt(store, s2.id)!;
    expect(ctx).not.toContain('<sibling-artifacts>');
  });
});

describe('buildTaskSystemPrompt', () => {
  it('includes task board instructions and context', () => {
    const task = store.create({ title: 'Build feature' });
    const prompt = buildTaskSystemPrompt(store, task.id);

    expect(prompt).toContain('Task Board');
    expect(prompt).toContain('TaskSet');
    expect(prompt).toContain('TaskComplete');
    expect(prompt).toContain('TaskArtifact');
    expect(prompt).toContain('<task-context>');
  });

  it('returns empty string for nonexistent task', () => {
    expect(buildTaskSystemPrompt(store, 'bad-id')).toBe('');
  });
});
