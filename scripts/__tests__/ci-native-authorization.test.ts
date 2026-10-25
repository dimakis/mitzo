import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { expect, it } from 'vitest';

// Execute the actual required workflow's reporter validator. A green Vitest
// flag must not qualify omitted or skipped platform-specific authority cases.
const workflow = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
};
const step = workflow.jobs['ordinary-journey'].steps.find(
  (entry) => entry.name === 'Verify signed native operator lifetime and repository tools',
)!;
const validator = step.run!.split("node --input-type=module <<'NODE'\n")[1].split('\nNODE')[0];
const required = [
  ['native-host-operator-lifetime.test.ts', 5],
  ['native-local-repository-preparation-registration-dispatch.test.ts', 4],
  ['native-local-repository-read-tools.test.ts', 8],
  ['native-reader-path-authorization.test.ts', 13],
] as const;
function fixture() {
  return {
    success: true,
    testResults: required.map(([file, count]) => ({
      name: '/fixture/server/__tests__/' + file,
      assertionResults: Array.from({ length: count }, (_, index) => ({
        fullName: file + ' case ' + index,
        status: 'passed',
      })),
    })),
  };
}
function validate(report: ReturnType<typeof fixture>) {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-native-ci-report-'));
  try {
    mkdirSync(join(directory, 'test-results'));
    writeFileSync(
      join(directory, 'test-results/native-host-authorization.json'),
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
it('accepts all thirty actual authority cases and only the named optional diagnostic', () => {
  expect(step.run!.split("node --input-type=module <<'NODE'\n")[0]).toContain(
    'server/__tests__/native-reader-path-authorization.test.ts',
  );
  expect(validate(fixture())).toBe(0);
  const report = fixture();
  report.testResults[2].assertionResults.push({
    fullName: 'source-mode signed Inspect positive diagnostic',
    status: 'pending',
  });
  expect(validate(report)).toBe(0);
});
it.each(required)('rejects omitted required platform coverage from %s', (file) => {
  const report = fixture();
  report.testResults = report.testResults.filter((suite) => !suite.name.endsWith('/' + file));
  expect(validate(report)).toBe(1);
});
it.each(['pending', 'skipped', 'failed'])('rejects a %s required native reader case', (status) => {
  const report = fixture();
  report.testResults[3].assertionResults[0].status = status;
  expect(validate(report)).toBe(1);
});
it('rejects partial, additional, substituted or unsuccessful native reader evidence', () => {
  for (const change of ['partial', 'additional', 'substitute', 'failure']) {
    const report = fixture();
    const suite = report.testResults[3];
    if (change === 'partial') suite.assertionResults.pop();
    if (change === 'additional')
      suite.assertionResults.push({ fullName: 'extra', status: 'passed' });
    if (change === 'substitute') suite.name = '/fixture/unrelated.test.ts';
    if (change === 'failure') report.success = false;
    expect(validate(report)).toBe(1);
  }
});
