import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { expect, it } from 'vitest';

type Step = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  with?: Record<string, unknown>;
};
it('keeps one simulator owner, offline failure tests and always-retained phase evidence', () => {
  const workflow = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const owner = workflow.jobs.native.steps.find((s) => s.id === 'native-notification')!;
  expect(owner.name).toBe('Build iPhone app with Watch companion');
  expect(owner.run).toContain('scripts/ci-native-candidate.py');
  expect(owner.run).toContain('--derived-data "$RUNNER_TEMP/mitzo-ios-build"');
  expect(owner.run).toContain('set -o pipefail');
  expect(
    workflow.jobs.native.steps.find((s) => s.name === 'Retain native notification failure evidence')
      ?.if,
  ).toBe('always()');
  expect(workflow.jobs.preflight.steps.map((s) => s.run).join('\n')).toContain(
    'python3 scripts/test-ci-native-candidate.py',
  );
});
