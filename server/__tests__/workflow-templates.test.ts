import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { WorkflowTemplateStore, instantiateTemplate, seedBuiltInTemplates } from '../workflow-templates.js';
import { TaskStore } from '../task-store.js';

const TEST_DIR = join(tmpdir(), `mitzo-workflow-test-${process.pid}`);

let templateStore: WorkflowTemplateStore;
let taskStore: TaskStore;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  const dbPath = join(TEST_DIR, `test-${Date.now()}.db`);
  taskStore = new TaskStore(dbPath);
  templateStore = new WorkflowTemplateStore(dbPath);
});

afterEach(() => {
  templateStore.close();
  taskStore.close();
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('WorkflowTemplateStore', () => {
  it('creates and retrieves a template', () => {
    const t = templateStore.create({
      name: 'pr-triage',
      description: 'Triage a PR',
      stages: [
        { title: 'Check CI', stage_type: 'agent_work' },
        { title: 'Wait for review', stage_type: 'wait_for_signal', gate_config: { type: 'gh_review', repo: '{{repo}}', pr: '{{pr}}' } },
      ],
      variables: { repo: { description: 'GitHub repo' }, pr: { description: 'PR number' } },
    });
    expect(t.id).toBeTruthy();
    expect(t.name).toBe('pr-triage');
    expect(t.stages).toHaveLength(2);
    expect(t.variables).toHaveProperty('repo');
  });

  it('lists all templates', () => {
    templateStore.create({ name: 'a', stages: [{ title: 'Step 1', stage_type: 'agent_work' }] });
    templateStore.create({ name: 'b', stages: [{ title: 'Step 1', stage_type: 'agent_work' }] });
    const all = templateStore.list();
    expect(all).toHaveLength(2);
  });

  it('gets a template by id', () => {
    const created = templateStore.create({ name: 'test', stages: [{ title: 'S1', stage_type: 'agent_work' }] });
    const found = templateStore.get(created.id);
    expect(found!.name).toBe('test');
  });

  it('returns null for nonexistent template', () => {
    expect(templateStore.get('nonexistent')).toBeNull();
  });

  it('deletes a template', () => {
    const t = templateStore.create({ name: 'doomed', stages: [{ title: 'S', stage_type: 'agent_work' }] });
    expect(templateStore.delete(t.id)).toBe(true);
    expect(templateStore.get(t.id)).toBeNull();
  });

  it('rejects duplicate names', () => {
    templateStore.create({ name: 'unique', stages: [{ title: 'S', stage_type: 'agent_work' }] });
    expect(() => templateStore.create({ name: 'unique', stages: [{ title: 'S', stage_type: 'agent_work' }] })).toThrow();
  });
});

describe('instantiateTemplate', () => {
  it('creates a goal with child tasks from template', () => {
    const tmpl = templateStore.create({
      name: 'simple',
      stages: [
        { title: 'Step 1', stage_type: 'agent_work', description: 'Do work' },
        { title: 'Step 2', stage_type: 'wait_for_signal', gate_config: { type: 'gh_ci', repo: 'org/repo', pr: 1 } },
        { title: 'Step 3', stage_type: 'human_review' },
      ],
    });

    const goal = instantiateTemplate(taskStore, templateStore, tmpl.id, 'My Goal', {});
    expect(goal.title).toBe('My Goal');
    expect(goal.templateId).toBe(tmpl.id);
    expect(goal.depth).toBe(0);

    const children = taskStore.getChildren(goal.id);
    expect(children).toHaveLength(3);
    expect(children[0].title).toBe('Step 1');
    expect(children[0].stageType).toBe('agent_work');
    expect(children[0].description).toBe('Do work');
    expect(children[1].title).toBe('Step 2');
    expect(children[1].stageType).toBe('wait_for_signal');
    expect(children[1].gateConfig).toEqual({ type: 'gh_ci', repo: 'org/repo', pr: 1 });
    expect(children[2].title).toBe('Step 3');
    expect(children[2].stageType).toBe('human_review');
  });

  it('substitutes template variables', () => {
    const tmpl = templateStore.create({
      name: 'parameterized',
      stages: [
        {
          title: 'Check CI for PR #{{pr_number}}',
          stage_type: 'wait_for_signal',
          description: 'Check {{repo}} PR {{pr_number}}',
          gate_config: { type: 'gh_ci', repo: '{{repo}}', pr: '{{pr_number}}' },
        },
      ],
      variables: { repo: { description: 'Repo' }, pr_number: { description: 'PR #' } },
    });

    const goal = instantiateTemplate(taskStore, templateStore, tmpl.id, 'Triage PR #42', {
      repo: 'dimakis/mitzo',
      pr_number: '42',
    });
    const children = taskStore.getChildren(goal.id);
    expect(children[0].title).toBe('Check CI for PR #42');
    expect(children[0].description).toBe('Check dimakis/mitzo PR 42');
    expect(children[0].gateConfig).toEqual({ type: 'gh_ci', repo: 'dimakis/mitzo', pr: '42' });
  });

  it('sets priority to preserve stage ordering', () => {
    const tmpl = templateStore.create({
      name: 'ordered',
      stages: [
        { title: 'First', stage_type: 'agent_work' },
        { title: 'Second', stage_type: 'agent_work' },
        { title: 'Third', stage_type: 'agent_work' },
      ],
    });

    const goal = instantiateTemplate(taskStore, templateStore, tmpl.id, 'Ordered Goal', {});
    const children = taskStore.getChildren(goal.id);
    // DFS uses priority DESC so first stage needs highest priority
    expect(children[0].title).toBe('First');
    expect(children[0].priority).toBeGreaterThan(children[1].priority);
    expect(children[1].priority).toBeGreaterThan(children[2].priority);
  });

  it('sets max_retries from template stage', () => {
    const tmpl = templateStore.create({
      name: 'retriable',
      stages: [
        { title: 'Flaky step', stage_type: 'agent_work', max_retries: 3 },
      ],
    });

    const goal = instantiateTemplate(taskStore, templateStore, tmpl.id, 'Retry Goal', {});
    const children = taskStore.getChildren(goal.id);
    expect(children[0].maxRetries).toBe(3);
  });

  it('throws for nonexistent template', () => {
    expect(() => instantiateTemplate(taskStore, templateStore, 'nonexistent', 'Goal', {})).toThrow();
  });

  it('sets templateId on all created tasks', () => {
    const tmpl = templateStore.create({
      name: 'tracked',
      stages: [
        { title: 'S1', stage_type: 'agent_work' },
        { title: 'S2', stage_type: 'agent_work' },
      ],
    });

    const goal = instantiateTemplate(taskStore, templateStore, tmpl.id, 'Tracked', {});
    const children = taskStore.getChildren(goal.id);
    expect(goal.templateId).toBe(tmpl.id);
    expect(children[0].templateId).toBe(tmpl.id);
    expect(children[1].templateId).toBe(tmpl.id);
  });
});

describe('seedBuiltInTemplates', () => {
  it('creates pr-triage and upstream-issue templates', () => {
    seedBuiltInTemplates(templateStore);
    const templates = templateStore.list();
    const names = templates.map((t) => t.name);
    expect(names).toContain('pr-triage');
    expect(names).toContain('upstream-issue');

    const prTriage = templates.find((t) => t.name === 'pr-triage')!;
    expect(prTriage.stages).toHaveLength(5);
    expect(prTriage.variables).toHaveProperty('repo');
    expect(prTriage.variables).toHaveProperty('pr');
  });

  it('is idempotent — second call does not duplicate', () => {
    seedBuiltInTemplates(templateStore);
    seedBuiltInTemplates(templateStore);
    const count = templateStore.list().filter((t) => t.name === 'pr-triage').length;
    expect(count).toBe(1);
  });
});
