import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

// Test-only entry for the existing macOS offline owner. Every required case must
// execute fully. A platform skip or a green default Vitest suite is insufficient.
if (process.platform !== 'darwin')
  throw Error('Joined native artifact qualification requires macOS');
if (
  !process.env.S9_MGMT_PYTHON ||
  !isAbsolute(process.env.S9_MGMT_PYTHON) ||
  !existsSync(process.env.S9_MGMT_PYTHON)
)
  throw Error('Select a private test Python with fixtures/mgmt-read-requirements.txt installed');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(import.meta.url);
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const suite = 'tests/integration/telos-s9/integrated-candidate';
const cases = [
  { name: 'non-git', config: 'vitest.joined.config.ts', file: 'non-git-browser.contract.ts' },
  {
    name: 'repository',
    config: 'vitest.repository-joined.config.ts',
    file: 'repository-browser.contract.ts',
  },
  {
    name: 'lost-response-recovery',
    config: 'vitest.recovery-joined.config.ts',
    file: 'lost-response-browser.contract.ts',
  },
  {
    name: 'tree-priority',
    config: 'vitest.tree-priority-joined.config.ts',
    file: 'tree-priority-browser.contract.ts',
  },
  {
    name: 's8-chooser',
    config: 'vitest.s8-joined.config.ts',
    file: 's8-chooser-browser.contract.ts',
  },
  {
    name: 'stop-isolation',
    config: 'vitest.stop-isolation.config.ts',
    file: 'stop-isolation-browser.contract.ts',
  },
  {
    name: 's6-app-owners',
    config: 'vitest.s6-app-owners.config.ts',
    files: [
      'server/__tests__/telos-ordinary-canonical-journey.test.ts',
      'server/__tests__/agent-communication-nongit-app.test.ts',
      'server/__tests__/telos-coordinator-v2-native-journey.test.ts',
    ],
  },
];
const failures = [];
const summary = [];
for (const selected of cases) {
  const directory = join(root, 'test-results/telos-s9-joined', selected.name);
  mkdirSync(directory, { recursive: true });
  const env = {
    ...process.env,
    NODE_OPTIONS: '--max-old-space-size=1024',
    S9_JOINED_SCREENSHOT_DIR: directory,
  };
  // CI uses retained accepted bytes, never a developer's MGMT checkout.
  delete env.S9_MGMT_SOURCE_ROOT;
  const result = spawnSync(
    process.execPath,
    [
      vitest,
      'run',
      '--config',
      join(suite, selected.config),
      '--reporter=default',
      '--reporter=json',
      '--outputFile=' + join(directory, 'run.json'),
    ],
    {
      cwd: root,
      env,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  writeFileSync(join(directory, 'stdout.log'), result.stdout ?? '');
  writeFileSync(join(directory, 'stderr.log'), result.stderr ?? '');
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  try {
    const observed = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8'));
    const requiredFiles = selected.files ?? [suite + '/' + selected.file];
    const completeFiles = requiredFiles.every((path) => {
      const matches = observed.testResults.filter((r) => r.name.endsWith('/' + path));
      return (
        matches.length === 1 &&
        matches[0].assertionResults.length === 1 &&
        matches[0].assertionResults[0].status === 'passed'
      );
    });
    if (
      result.status !== 0 ||
      !observed.success ||
      observed.numTotalTests !== requiredFiles.length ||
      observed.numPassedTests !== requiredFiles.length ||
      observed.numFailedTests !== 0 ||
      observed.numPendingTests !== 0 ||
      observed.testResults.length !== requiredFiles.length ||
      !completeFiles
    )
      throw Error('Every required actual App case must pass exactly once with zero skips');
    summary.push({ ...selected, status: 'passed', result: join(directory, 'run.json') });
  } catch (error) {
    failures.push(selected.name);
    summary.push({
      ...selected,
      status: 'failed',
      exitCode: result.status,
      signal: result.signal,
      error: String(error),
    });
  }
}
writeFileSync(
  join(root, 'test-results/telos-s9-joined/required-summary.json'),
  JSON.stringify(summary, null, 2) + '\n',
);
if (failures.length) throw Error('Joined acceptance remains red: ' + failures.join(', '));
