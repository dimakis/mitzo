import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { load } from 'js-yaml';
import { expect, it } from 'vitest';

type Step = { name?: string; id?: string; if?: string };
const { jobs } = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  jobs: Record<string, { if?: string; steps: Step[] }>;
};

function enabled(condition: string | undefined, state: string) {
  const expression = condition?.replace(/^\$\{\{\s*|\s*\}\}$/g, '') || 'success()';
  return new Script(expression).runInNewContext({
    always: () => true,
    success: () => state === 'success',
    failure: () => state === 'failure',
    cancelled: () => state === 'cancelled',
  });
}

it.each([
  'design',
  'typecheck-server',
  'typecheck-frontend',
  'audit',
  'secret-scan',
  'build-mcp',
  'build',
  'bundle-size',
])('%s retains coverage after failures but releases superseded CI on cancellation', (id) => {
  const step = jobs.static.steps.find((candidate) => candidate.id === id);
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
