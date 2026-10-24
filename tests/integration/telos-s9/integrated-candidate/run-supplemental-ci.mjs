import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { selectSupplementalShard, parseSupplementalShardArgs } from './supplemental-shards.mjs';

// Separate closed regressions; the original required-nine runner is unchanged.
if (process.platform !== 'darwin') throw Error('Supplemental owner journeys require macOS');
if (
  !process.env.S9_MGMT_PYTHON ||
  !isAbsolute(process.env.S9_MGMT_PYTHON) ||
  !existsSync(process.env.S9_MGMT_PYTHON)
)
  throw Error('Select the private Python with hash-pinned canonical CLI dependencies');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const suite = 'tests/integration/telos-s9/integrated-candidate';
const selection = JSON.parse(
  readFileSync(join(root, suite, 'closed-supplemental-selection.json'), 'utf8'),
);
if (selection.version !== 1 || selection.expectedCases !== 17 || selection.cases?.length !== 17)
  throw Error('The explicit closed supplemental selection must contain seventeen cases');
const names = new Set();
const paths = new Set();
for (const selected of selection.cases) {
  if (
    !/^[a-z0-9-]+$/.test(selected.name) ||
    names.has(selected.name) ||
    !/^vitest\.[a-z0-9-]+\.config\.ts$/.test(selected.config) ||
    selected.expectedTests !== 1 ||
    selected.files?.length !== 1
  )
    throw Error('Invalid or duplicate supplemental group');
  names.add(selected.name);
  for (const path of selected.files) {
    if (
      !path.startsWith(suite + '/') ||
      path.includes('..') ||
      (!path.endsWith('-browser.contract.ts') &&
        path !== suite + '/advisor-material-refusal.contract.ts' &&
        path !== suite + '/task-chat-tree-app.contract.ts') ||
      paths.has(path)
    )
      throw Error('Invalid or duplicate supplemental case path');
    paths.add(path);
  }
}
const selectedCases = selectSupplementalShard(
  selection.cases,
  parseSupplementalShardArgs(process.argv.slice(2)),
);
const require = createRequire(import.meta.url);
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const summary = [];
const failures = [];
for (const selected of selectedCases) {
  const directory = join(root, 'test-results/telos-s9-supplemental', selected.name);
  mkdirSync(directory, { recursive: true });
  // A failed collection or absent reporter must never reuse an earlier result.
  rmSync(join(directory, 'run.json'), { force: true });
  const env = {
    ...process.env,
    NODE_OPTIONS: '--max-old-space-size=1024',
    S9_JOINED_SCREENSHOT_DIR: directory,
  };
  delete env.S9_MGMT_SOURCE_ROOT;
  const result = spawnSync(
    process.execPath,
    [
      vitest,
      'run',
      '--config',
      join(suite, selected.config),
      '--maxWorkers=1',
      '--no-file-parallelism',
      '--reporter=default',
      '--reporter=json',
      '--outputFile=' + join(directory, 'run.json'),
    ],
    { cwd: root, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  writeFileSync(join(directory, 'runner-stdout.log'), result.stdout ?? '');
  writeFileSync(join(directory, 'runner-stderr.log'), result.stderr ?? '');
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  try {
    const observed = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8'));
    const completeFiles = selected.files.every((path) => {
      const matches = observed.testResults.filter((r) => r.name.endsWith('/' + path));
      return (
        matches.length === 1 &&
        matches[0].status === 'passed' &&
        matches[0].assertionResults.length === 1 &&
        matches[0].assertionResults[0].status === 'passed'
      );
    });
    if (
      result.status !== 0 ||
      result.signal ||
      result.error ||
      !observed.success ||
      observed.numTotalTests !== selected.expectedTests ||
      observed.numPassedTests !== selected.expectedTests ||
      observed.numFailedTests !== 0 ||
      observed.numPendingTests !== 0 ||
      observed.testResults.length !== selected.files.length ||
      !completeFiles
    )
      throw Error(
        'Every selected supplemental file must execute exactly once and pass without skipped or pending tests',
      );
    summary.push({ ...selected, status: 'passed', result: join(directory, 'run.json') });
  } catch (error) {
    failures.push(selected.name);
    summary.push({
      ...selected,
      status: 'failed',
      exitCode: result.status,
      signal: result.signal,
      error: String(error),
      processError: String(result.error ?? ''),
    });
  }
}
writeFileSync(
  join(root, 'test-results/telos-s9-supplemental/closed-summary.json'),
  JSON.stringify(summary, null, 2) + '\n',
);
if (failures.length)
  throw Error('Closed supplemental qualification remains red: ' + failures.join(', '));
