import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { expect, it } from 'vitest';

const workflow = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  jobs: Record<string, { steps: Array<{ name?: string; run?: string; env?: unknown }> }>;
};
const step = workflow.jobs['ordinary-journey'].steps.find(
  (entry) => entry.name === 'Verify Claude and task-runner Git setup through real OS boundaries',
)!;
const validator = step.run!.split("node --input-type=module <<'NODE'\n")[1].split('\nNODE')[0];
const names = [
  'clones and develops through the real SDK boundary (Keychain 0)',
  'clones and develops through the real SDK boundary (Keychain 1)',
  'OS sandbox creates and develops a nested repository without granting its parent Git metadata',
  'allows native development in the owned repository and denies writes in sibling checkouts and authority',
];
const fixture = () => ({
  success: true,
  testResults: [{ assertionResults: names.map((fullName) => ({ fullName, status: 'passed' })) }],
});
function validate(report: ReturnType<typeof fixture>) {
  const directory = mkdtempSync(join(tmpdir(), 'claude-repository-report-'));
  try {
    mkdirSync(join(directory, 'test-results'));
    writeFileSync(
      join(directory, 'test-results/claude-repository-setup.json'),
      JSON.stringify(report),
    );
    return spawnSync(process.execPath, ['--input-type=module', '--eval', validator], {
      cwd: directory,
      encoding: 'utf8',
    }).status;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
it('qualifies only all four real Git development and confinement cases', () => {
  expect(step.env).toEqual({ MITZO_TEST_OS_SANDBOX: '1', MITZO_SANDBOX_INTEGRATION: '1' });
  expect(validate(fixture())).toBe(0);
});
it.each(['pending', 'skipped', 'failed', 'omitted', 'duplicated', 'unsuccessful'])(
  'refuses %s native Git evidence',
  (change) => {
    const report = fixture();
    const tests = report.testResults[0].assertionResults;
    if (change === 'omitted') tests.pop();
    else if (change === 'duplicated') tests[1].fullName = tests[0].fullName;
    else if (change === 'unsuccessful') report.success = false;
    else tests[0].status = change;
    expect(validate(report)).toBe(1);
  },
);
