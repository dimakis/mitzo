import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { load } from 'js-yaml';
import { expect, it } from 'vitest';

type Step = { name?: string; id?: string; if?: string };
const { jobs, concurrency } = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  jobs: Record<string, { if?: string; steps: Step[] }>;
  concurrency: { group: string; 'cancel-in-progress': string };
};

function enabled(condition: string | undefined, state: string, compiled = 'success') {
  const expression = condition?.replace(/^\$\{\{\s*|\s*\}\}$/g, '') || 'success()';
  return new Script(expression).runInNewContext({
    steps: { 'compiled-prerequisites': { outcome: compiled } },
    always: () => true,
    success: () => state === 'success',
    failure: () => state === 'failure',
    cancelled: () => state === 'cancelled',
  });
}

it.each([
  'codex-resume',
  'quotes',
  'lint',
  'format',
  'design',
  'audit',
  'secret-scan',
  'build-mcp',
  'bundle-size',
])('%s retains coverage after failures but releases superseded CI on cancellation', (id) => {
  const step = jobs.core.steps.find((candidate) => candidate.id === id);
  expect(step).toBeDefined();
  expect(enabled(step!.if, 'success')).toBe(true);
  expect(enabled(step!.if, 'failure')).toBe(true);
  expect(enabled(step!.if, 'cancelled')).toBe(false);
});

it('native failure diagnostics can build after a test failure but stop on cancellation', () => {
  const step = jobs.native.steps.find(
    (candidate) => candidate.name === 'Build iPhone app with Watch companion',
  );
  expect(enabled(step?.if, 'failure')).toBe(true);
  expect(enabled(step?.if, 'cancelled')).toBe(false);
});

it('the required browser aggregator still reports cancelled or incomplete selected suites', () => {
  expect(enabled(jobs['browser-validation'].if, 'cancelled')).toBe(true);
});

it('unit shards stop superseded tests but retain failure evidence', () => {
  const step = jobs.unit.steps.find((candidate) => candidate.id === 'test');
  expect(enabled(step?.if, 'failure')).toBe(true);
  expect(enabled(step?.if, 'cancelled')).toBe(false);
});

it('the required core aggregator reports cancelled or incomplete shards', () => {
  expect(enabled(jobs.ci.if, 'cancelled')).toBe(true);
});

it('unit compiled prerequisites and complete unit validation release superseded runs', () => {
  const build = jobs.unit.steps.find((candidate) => candidate.id === 'compiled-prerequisites');
  expect(build).toBeDefined();
  expect(enabled(build?.if, 'failure')).toBe(false);
  expect(enabled(build?.if, 'cancelled')).toBe(false);
  expect(enabled(jobs['unit-validation'].if, 'cancelled')).toBe(true);
});

function concurrencyFor(eventName: string, sha: string, number?: number) {
  const github = { event_name: eventName, sha, event: { pull_request: number ? { number } : {} } };
  const evaluate = (expression: string) =>
    new Script(expression).runInNewContext({
      github,
      format: (template: string, ...values: unknown[]) =>
        template.replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)])),
    });
  return {
    group: concurrency.group.replace(/\$\{\{(.*?)\}\}/g, (_, expression) =>
      String(evaluate(expression)),
    ),
    cancel: evaluate(concurrency['cancel-in-progress'].replace(/^\$\{\{\s*|\s*\}\}$/g, '')),
  };
}
it('admits a new candidate without waiting for an older PR run to finish shutting down', () => {
  const older = concurrencyFor('pull_request', 'old-merge-sha', 1154);
  const current = concurrencyFor('pull_request', 'new-merge-sha', 1154);
  expect(current.group).not.toBe(older.group);
  expect(current.group).toContain('1154');
  expect(current.group).toContain('new-merge-sha');
  expect(current.cancel).toBe(true);
  expect(concurrencyFor('pull_request', 'new-merge-sha', 1154)).toEqual(current);
  expect(concurrencyFor('pull_request', 'new-merge-sha', 1155).group).not.toBe(current.group);
});
it('preserves main candidate concurrency identity and does not cancel its validation', () => {
  expect(concurrencyFor('push', 'main-sha')).toEqual({ group: 'ci-main-sha', cancel: false });
});

it('frontend production builds retain failure diagnostics but stop on cancellation', () => {
  const build = jobs['frontend-build']?.steps.find((step) => step.id === 'build');
  expect(build).toBeDefined();
  expect(enabled(build?.if, 'failure')).toBe(true);
  expect(enabled(build?.if, 'cancelled')).toBe(false);
});

it('does not execute unit tests after missing or rejected compiled prerequisites', () => {
  const test = jobs.unit.steps.find((step) => step.id === 'test');
  for (const outcome of ['', 'failure', 'cancelled', 'skipped']) {
    expect(enabled(test?.if, 'success', outcome)).toBe(false);
    expect(enabled(test?.if, 'failure', outcome)).toBe(false);
  }
});
